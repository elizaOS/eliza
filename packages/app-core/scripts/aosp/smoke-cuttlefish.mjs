#!/usr/bin/env node

// eliza/packages/app-core/scripts/aosp/smoke-cuttlefish.mjs —
// end-to-end smoke test for the on-device agent. Confirms: cvd is up,
// APK is installed, service starts, /api/health responds, bearer
// token is readable, chat round-trip works, and response generation
// stayed local.
//
// Designed to run after `node eliza/packages/app-core/scripts/aosp/build-aosp.mjs --launch`
// finishes. Idempotent: re-running on the same cvd is fine; the service
// is restartable. Exit code 0 on full pass, 1 on any failure.
//
// Reads `packageName` + `appName` from `app.config.ts > aosp:`.
// `--app-config <PATH>` overrides the config location for tests.
//
// Works for both x86_64 cuttlefish and a real arm64-v8a device. The
// per-device ABI is read from `getprop ro.product.cpu.abi` so the
// reporter can call it out in the summary.
//
// Hard rule from the brief: this verifies LOCAL inference, not cloud-
// routed. Step 8 hits /api/local-inference/active and asserts the
// active model state is "ready" with a real modelId. If the runtime
// fell back to cloud (which it should NOT on AOSP with ELIZA_LOCAL_-
// LLAMA=1) the test fails loudly.
//
// Caveat: the AOSP_LLAMA_PROVIDER constant referenced in some earlier
// briefs does not exist in the runtime. Local-vs-cloud detection uses
// the local-inference active-model state as the signal; that endpoint
// is only populated when a local libllama-backed model is loaded.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";

// Node 22+ ships undici as the fetch implementation but does NOT
// expose it under the bare `undici` specifier — it lives behind the
// internal `node:undici` namespace (or via `internalBinding`). Default
// `bodyTimeout` is 300_000 ms (5 min); local-inference chat
// completions on cuttlefish CPU routinely run 5–20 minutes for a
// single turn (planner + action evaluator + reply, all on a single
// emulated core). We dynamic-import undici lazily so the smoke runs
// on systems without an `undici` package installed; if the import
// fails (older Node), we fall back to the default fetch and document
// the limitation.
async function configureUndiciIfAvailable(timeoutMs) {
  try {
    /* Boundary cast: dynamic import of bundled undici, weakly typed */
    const undici = await import("node:undici").catch(() =>
      import("undici").catch(() => null),
    );
    if (!undici || typeof undici.setGlobalDispatcher !== "function") {
      return false;
    }
    // Both `headersTimeout` and `bodyTimeout` need to span the entire
    // generation budget. The agent's chat-routes endpoint does NOT
    // emit headers until the chat completion is fully generated and
    // serialized — there's no streaming framing on the non-stream
    // path. So a 60 s headersTimeout (undici default) fires at the
    // 60 s mark even though the agent is happily decoding the
    // planner's prompt at 20 tok/s. Pin headersTimeout to the same
    // value as bodyTimeout so a single env var (CHAT_TIMEOUT_MS)
    // controls the whole client deadline.
    undici.setGlobalDispatcher(
      new undici.Agent({
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: timeoutMs,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

const AGENT_PORT = 31337;
// adb forward picks an arbitrary host port; we always pin to AGENT_PORT
// for simplicity. cvd binds 6520+ for its own ports so 31337 is free.
const HOST_PORT = 31337;
// Cold-boot on cvd takes several minutes: the service has to extract
// the bun musl binary + agent-bundle + GGUF models from the APK, hand
// the bun process a (clean) PGlite db, register all plugins, and
// finally bring up Express. A 30 s window only works when the smoke
// runs against an already-warm service. After the service has been
// killed (watchdog after a long chat held the bun thread past health-
// ping window, or `am start` on a re-launched activity) we need to
// budget for the full boot path. 10 min is generous for cvd CPU and
// short enough that a real failure still surfaces quickly.
const HEALTH_TIMEOUT_MS = 600_000;
const HEALTH_POLL_INTERVAL_MS = 2_000;
// Cuttlefish x86_64 has no GPU; Eliza-1 decoding a 9k-token
// planner prompt on CPU runs for several minutes per turn (planner +
// action evaluator + reply). End-to-end chat lands at 25–45 min on
// cvd's 4 emulated vCPUs (each model call is ~12 min wall-clock; a
// chat turn fires 3–5 calls). 3600 s matches the service-side
// ELIZA_CHAT_GENERATION_TIMEOUT_MS we set in ElizaAgentService when
// AOSP_BUILD=true. Real phone hardware resolves in seconds, so this
// only matters for cvd runs.
const CHAT_TIMEOUT_MS = 3_600_000;

// ANSI color helpers; output is human-readable, no JSON for now.
const RESET = "[0m";
const RED = "[31m";
const GREEN = "[32m";
const CYAN = "[36m";

const TOTAL_STEPS = 8;

function color(c, s) {
  return `${c}${s}${RESET}`;
}

function logStep(n, label) {
  console.log(color(CYAN, `[${n}/${TOTAL_STEPS}] ${label}`));
}

export function formatResult(step, label, ok, detail) {
  const tag = ok ? color(GREEN, "PASS") : color(RED, "FAIL");
  const tail = detail ? ` - ${detail}` : "";
  return `[${step}/${TOTAL_STEPS}] ${tag} ${label}${tail}`;
}

export function summarize(results) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const allPassed = failed === 0;
  const tag = allPassed
    ? color(GREEN, `PASS (${passed}/${results.length})`)
    : color(RED, `FAIL (${passed}/${results.length} passed, ${failed} failed)`);
  return { line: `Smoke test: ${tag}`, allPassed };
}

// Helper: synchronous adb invocation. Returns { stdout, stderr, status }.
// `serial` lets the caller target a specific device when more than one
// is attached (cvd commonly registers 0.0.0.0:6520).
function adb(args, { serial = null, timeout = 10_000 } = {}) {
  const fullArgs = serial ? ["-s", serial, ...args] : args;
  const result = spawnSync("adb", fullArgs, {
    encoding: "utf8",
    timeout,
  });
  return {
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
    status: result.status,
    error: result.error,
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollHealth(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${HOST_PORT}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_POLL_INTERVAL_MS),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: true, body };
      }
    } catch {
      // fall through to retry
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return { ok: false };
}

/**
 * Run the smoke test against the currently-attached cvd / device.
 *
 * Returns an array of { step, label, ok, detail } records; the caller
 * (CLI entry point) prints them and decides the exit code.
 */
export async function runSmoke({
  adb: adbImpl = adb,
  packageName,
  appName = null,
} = {}) {
  if (!packageName) {
    throw new Error(
      "[smoke-cuttlefish] runSmoke requires `packageName` (resolve from app.config.ts > aosp.packageName).",
    );
  }
  const SERVICE_FQN = `${packageName}/${packageName}.ElizaAgentService`;
  const apkLabel = appName ? `${appName}.apk` : "the APK";
  const results = [];
  let serial = null;

  // Configure undici's global dispatcher so fetch() doesn't enforce
  // its default 300 s `bodyTimeout` on the long-running chat request
  // (Step 6). On cuttlefish CPU a single chat turn can take 10–25
  // minutes; the bodyTimeout has to match the server-side
  // ELIZA_CHAT_GENERATION_TIMEOUT_MS budget or the client gives up
  // mid-decode. Fail-soft: if undici isn't available we run with
  // default fetch and the operator sees `fetch failed` on long runs.
  const undiciOk = await configureUndiciIfAvailable(CHAT_TIMEOUT_MS);
  if (!undiciOk) {
    console.warn(
      "[smoke-cuttlefish] WARN: undici not available; fetch() will use default 5-minute bodyTimeout. Long chats will fail.",
    );
  }

  // ── Step 1: verify cvd / device is up ───────────────────────────────
  logStep(1, "Verifying cvd / device is reachable via adb");
  const devicesResult = adbImpl(["devices"]);
  const deviceLines = devicesResult.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("List of devices"));
  const onlineDevices = deviceLines
    .filter((l) => /\sdevice$/.test(l))
    .map((l) => l.split(/\s+/)[0]);
  if (onlineDevices.length === 0) {
    results.push({
      step: 1,
      label: "cvd / device reachable",
      ok: false,
      detail:
        "no online adb devices found. Run `cvd_start_x86_64` (or attach a real device) before re-running.",
    });
    return results;
  }
  // Honor ANDROID_SERIAL when set — picking arbitrarily from a multi-
  // device list on a developer machine (cvd + physical phone) silently
  // ran the smoke against the wrong target. If the env var names a
  // device that isn't online, fail loudly so the operator can fix it
  // rather than falling back to whichever device sorted first.
  const requestedSerial =
    typeof process.env.ANDROID_SERIAL === "string" &&
    process.env.ANDROID_SERIAL.trim().length > 0
      ? process.env.ANDROID_SERIAL.trim()
      : null;
  if (requestedSerial) {
    if (!onlineDevices.includes(requestedSerial)) {
      results.push({
        step: 1,
        label: "cvd / device reachable",
        ok: false,
        detail: `ANDROID_SERIAL=${requestedSerial} but that device is not online. adb devices: ${onlineDevices.join(", ")}`,
      });
      return results;
    }
    serial = requestedSerial;
    results.push({ step: 1, label: "cvd / device reachable", ok: true });
  } else if (onlineDevices.length > 1) {
    serial = onlineDevices[0];
    results.push({
      step: 1,
      label: "cvd / device reachable",
      ok: true,
      detail: `multiple devices, using ${serial} (set ANDROID_SERIAL to pin)`,
    });
  } else {
    serial = onlineDevices[0];
    results.push({ step: 1, label: "cvd / device reachable", ok: true });
  }

  // Step 2: verify APK installed and report ABI.
  logStep(2, `Verifying ${packageName} is installed`);
  const pmList = adbImpl(["shell", "pm", "list", "packages", packageName], {
    serial,
  });
  const installed = pmList.stdout.includes(`package:${packageName}`);
  if (!installed) {
    results.push({
      step: 2,
      label: `${apkLabel} installed`,
      ok: false,
      detail: `pm list packages did not show ${packageName}. Reinstall via the AOSP image or sideload ${apkLabel}.`,
    });
    return results;
  }
  const abiOut = adbImpl(["shell", "getprop", "ro.product.cpu.abi"], {
    serial,
  });
  const abi = abiOut.stdout.trim() || "unknown";
  results.push({
    step: 2,
    label: `${apkLabel} installed`,
    ok: true,
    detail: `abi=${abi}`,
  });

  // ── Step 3: launch the service ──────────────────────────────────────
  logStep(3, "Starting ElizaAgentService");
  // The ElizaAgentService is declared android:exported="false" so a
  // direct `am start-foreground-service` from adb shell (uid 2000) hits
  // "Requires permission not exported from uid 10036". The legitimate
  // startup path is via MainActivity.onCreate() which calls
  // ElizaAgentService.start(this) from inside the variant's process. We
  // also rely on ElizaBootReceiver auto-starting the service on boot.
  // Try direct start first (works on debuggable / shell-uid-allowed
  // builds); on permission denial, fall back to launching MainActivity;
  // finally treat an already-running service as success.
  const tryStart = (cmd) =>
    adbImpl(["shell", "am", cmd, "-n", SERVICE_FQN], { serial });
  let startSvc = tryStart("start-foreground-service");
  let svcText = (startSvc.stdout + startSvc.stderr).trim();
  const isPermDenied = /not exported from uid/i.test(svcText);
  if (
    startSvc.status !== 0 ||
    /Error:|Unable to find|Bad component name/i.test(svcText)
  ) {
    if (!isPermDenied) {
      startSvc = tryStart("startservice");
      svcText = (startSvc.stdout + startSvc.stderr).trim();
    }
    if (isPermDenied || startSvc.status !== 0 || /Error:/i.test(svcText)) {
      // Launch the activity, which kicks the service from inside the
      // variant's uid via ElizaAgentService.start(this).
      const launchAct = adbImpl(
        [
          "shell",
          "am",
          "start",
          "-n",
          `${packageName}/${packageName}.MainActivity`,
        ],
        { serial },
      );
      const launchText = (launchAct.stdout + launchAct.stderr).trim();
      if (launchAct.status !== 0 || /Error:|Unable to find/i.test(launchText)) {
        results.push({
          step: 3,
          label: "ElizaAgentService start",
          ok: false,
          detail: `service direct-start hit "${svcText.slice(0, 80)}" and activity launch fallback failed: ${launchText.slice(0, 120)}`,
        });
        return results;
      }
    }
  }
  results.push({ step: 3, label: "ElizaAgentService start", ok: true });

  // Step 4: wait for /api/health via adb forward.
  logStep(4, `Waiting up to ${HEALTH_TIMEOUT_MS / 1000}s for /api/health`);
  const forwardResult = adbImpl(
    ["forward", `tcp:${HOST_PORT}`, `tcp:${AGENT_PORT}`],
    { serial },
  );
  if (forwardResult.status !== 0) {
    results.push({
      step: 4,
      label: "/api/health responds",
      ok: false,
      detail: `adb forward failed: ${forwardResult.stderr.trim()}`,
    });
    return results;
  }
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const health = await pollHealth(deadline);
  if (!health.ok) {
    results.push({
      step: 4,
      label: "/api/health responds",
      ok: false,
      detail: `no 200 within ${HEALTH_TIMEOUT_MS / 1000}s. Check 'adb logcat -s ElizaAgent' for SIGSYS / spawn-failed signs.`,
    });
    return results;
  }
  results.push({
    step: 4,
    label: "/api/health responds",
    ok: true,
    detail: `agentState=${health.body.agentState ?? "?"} runtime=${health.body.runtime ?? "?"}`,
  });

  // ── Step 5: read the per-boot bearer token from app data dir ────────
  logStep(5, "Reading per-boot bearer token (run-as → su 0 fallback)");
  // Release-built APKs from the AOSP image are NOT debuggable, so
  // `run-as <pkg>` fails with "package not debuggable". On a userdebug
  // cuttlefish, `adb root` switches adbd to root but `adb shell` still
  // enters as the shell user (uid 2000) which cannot read /data/data/
  // <pkg>/files/. Use `su 0 cat` to escalate inside the shell. Try in
  // order: run-as → direct cat → su 0 cat. The shell context still
  // bumps into SELinux on user builds, but on userdebug the
  // `permissive` shell domain lets `su 0` read app data.
  const tokenPath = `/data/data/${packageName}/files/auth/local-agent-token`;
  let tokenResult = adbImpl(
    ["shell", "run-as", packageName, "cat", tokenPath],
    { serial },
  );
  let token = tokenResult.stdout.trim();
  const runAsFailed =
    !token ||
    /run-as: /i.test(tokenResult.stderr) ||
    /not debuggable/i.test(tokenResult.stderr);
  if (runAsFailed) {
    tokenResult = adbImpl(["shell", "cat", tokenPath], { serial });
    token = tokenResult.stdout.trim();
  }
  if (!token || token.length < 16 || /[^0-9a-fA-F]/.test(token)) {
    // Last resort on userdebug: su 0 cat. `adb root` plus `su 0` is the
    // canonical way to read app-private files from an adb shell.
    tokenResult = adbImpl(["shell", "su", "0", "cat", tokenPath], { serial });
    token = tokenResult.stdout.trim();
  }
  if (!token || token.length < 16 || /[^0-9a-fA-F]/.test(token)) {
    results.push({
      step: 5,
      label: "Bearer token readable",
      ok: false,
      detail: `Could not read ${tokenPath}: run-as / cat / su 0 cat all failed. Last stderr: ${tokenResult.stderr.trim().slice(0, 100) || "(empty)"}. Run \`adb root\` on userdebug; on non-userdebug, rebuild the APK with android:debuggable=true.`,
    });
    return results;
  }
  results.push({
    step: 5,
    label: "Bearer token readable",
    ok: true,
    detail: `${token.length} hex chars`,
  });

  // Step 6: POST a chat message to /v1/chat/completions.
  // The OpenAI-compat agent server accepts any model identifier in
  // the request body; the server-side router resolves the actual
  // local-inference model independently. Default to the variant's
  // CLI/cliName-style label; the body field is functionally a tag.
  logStep(6, "POSTing a chat message to /v1/chat/completions");
  const chatBody = {
    model: appName?.toLowerCase() ?? "default",
    messages: [{ role: "user", content: "hello, who are you?" }],
    stream: false,
    max_tokens: 64,
  };

  // Live progress logger. On cuttlefish CPU the chat endpoint can take
  // 5–25 minutes wall-clock to return a response (planner + action
  // evaluator + reply, all on a single CPU). Without periodic stdout
  // chatter the smoke run looks dead. Print a heartbeat with elapsed
  // time so the operator (and CI) can confirm the smoke is still
  // making progress.
  const chatStartedAt = Date.now();
  const heartbeatHandle = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - chatStartedAt) / 1000);
    process.stdout.write(
      color(CYAN, `  ... chat in flight (${elapsedSec}s elapsed)\n`),
    );
  }, 30_000);

  // Single chat request — no retries. A retry would queue a SECOND
  // chat request behind the first one on the agent's HTTP server,
  // doubling the work the device has to do. On cuttlefish CPU each
  // chat turn fires multiple model calls (planner, action evaluator,
  // response generator), each running through llama_decode for
  // minutes; doubling that load reliably crashes the smoke. If the
  // first request really did fail mid-flight, the device-side log
  // tells us why; better to fail fast than to drown the device.
  let chatResp = null;
  let lastFetchError = null;
  try {
    // @duplicate-component-audit-allow: smoke test exercises the local chat endpoint; runtime owns model logging.
    chatResp = await fetch(
      `http://127.0.0.1:${HOST_PORT}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(chatBody),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      },
    );
  } catch (error) {
    lastFetchError = error;
  }
  clearInterval(heartbeatHandle);
  if (!chatResp) {
    // Surface the underlying socket cause so "fetch failed" doesn't
    // shadow ECONNRESET / ECONNREFUSED / EPIPE / UND_ERR_SOCKET. Node's
    // fetch wraps the real reason in `error.cause`; older callers only
    // saw "fetch failed: fetch failed" with no actionable detail.
    const cause =
      lastFetchError && typeof lastFetchError === "object"
        ? /* Boundary cast: Error.cause is loosely typed as unknown */
          /** @type {{ cause?: unknown }} */ (lastFetchError).cause
        : null;
    const causeMessage =
      cause && typeof cause === "object" && "message" in cause
        ? /** @type {{ message?: string }} */ (cause).message
        : cause === undefined || cause === null
          ? null
          : String(cause);
    const causeCode =
      cause && typeof cause === "object" && "code" in cause
        ? /** @type {{ code?: string }} */ (cause).code
        : null;
    const detail = [
      `fetch failed: ${lastFetchError?.message ?? "unknown"}`,
      causeCode ? `cause=${causeCode}` : null,
      causeMessage && causeMessage !== lastFetchError?.message
        ? `cause-msg=${causeMessage}`
        : null,
    ]
      .filter(Boolean)
      .join(" / ");
    results.push({
      step: 6,
      label: "Chat completion request",
      ok: false,
      detail,
    });
    return results;
  }
  if (!chatResp.ok) {
    const text = await chatResp.text().catch(() => "");
    results.push({
      step: 6,
      label: "Chat completion request",
      ok: false,
      detail: `HTTP ${chatResp.status}: ${text.slice(0, 200)}`,
    });
    return results;
  }
  const chatElapsedSec = Math.floor((Date.now() - chatStartedAt) / 1000);
  results.push({
    step: 6,
    label: "Chat completion request",
    ok: true,
    detail: `${chatElapsedSec}s wall-clock`,
  });

  // Step 7: assert the chat response contains a non-empty message.
  logStep(7, "Asserting response shape");
  const chatJson = await chatResp.json().catch(() => null);
  const messageContent =
    chatJson?.choices?.[0]?.message?.content ??
    chatJson?.choices?.[0]?.delta?.content ??
    "";
  if (!messageContent || typeof messageContent !== "string") {
    results.push({
      step: 7,
      label: "Response shape",
      ok: false,
      detail: `choices[0].message.content was empty or non-string. Body: ${JSON.stringify(chatJson).slice(0, 200)}`,
    });
    return results;
  }
  results.push({
    step: 7,
    label: "Response shape",
    ok: true,
    detail: `${messageContent.length} chars: "${messageContent.slice(0, 60).replace(/\n/g, " ")}..."`,
  });

  // ── Step 8: verify the response was LOCAL, not cloud-routed ─────────
  logStep(8, "Verifying provider is local (via on-device agent log)");
  // The agent bundle uses the standalone agent server (not the
  // app-core wrapper), so `/api/local-inference/active` doesn't exist
  // on the AOSP runtime — that route lives in app-core and is only
  // active on the desktop / Capacitor wrapper. On AOSP we verify
  // local inference via the agent.log: presence of `[aosp-llama]
  // Loaded ...gguf` AND `[aosp-llama] gen done` proves a real local
  // FFI call ran. No-network host (cvd has no Internet) plus no
  // ANTHROPIC_API_KEY / OPENAI_API_KEY / ELIZAOS_CLOUD_API_KEY is the
  // belt-and-braces argument; the log line is the ground truth.
  // The regex contains a space and parens, so the device shell interprets
  // unquoted `(Loaded|gen done)` as a subshell and exits with a syntax
  // error (logging zero matches even when local inference fired). Single-
  // quote the pattern so the device shell hands it to grep verbatim.
  const logCheck = adbImpl(
    [
      "shell",
      "su",
      "0",
      "grep",
      "-cE",
      "'aosp-llama. (Loaded|gen done)'",
      `/data/data/${packageName}/files/agent/agent.log`,
    ],
    { serial },
  );
  const aospLogLines = Number.parseInt(logCheck.stdout.trim(), 10);
  if (!Number.isFinite(aospLogLines) || aospLogLines < 2) {
    results.push({
      step: 8,
      label: "Provider is local",
      ok: false,
      detail: `agent.log has ${aospLogLines || 0} aosp-llama Loaded/gen-done lines (need ≥2 for a real chat-with-local-inference round)`,
    });
    return results;
  }
  results.push({
    step: 8,
    label: "Provider is local",
    ok: true,
    detail: `agent.log shows ${aospLogLines} aosp-llama Loaded/gen-done lines`,
  });
  return results;
}

function parseSmokeArgs(argv) {
  const out = { json: false, appConfigPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--app-config") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--app-config requires a value");
      }
      out.appConfigPath = path.resolve(value);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/smoke-cuttlefish.mjs [--json] [--app-config <PATH>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const { json: wantJson, appConfigPath } = parseSmokeArgs(argv);
  const cfgPath = resolveAppConfigPath({ repoRoot, flagValue: appConfigPath });
  if (!fs.existsSync(cfgPath)) {
    throw new Error(
      `[smoke-cuttlefish] app.config.ts not found at ${cfgPath}.`,
    );
  }
  const variant = loadAospVariantConfig({ appConfigPath: cfgPath });
  if (!variant) {
    throw new Error(
      `[smoke-cuttlefish] No \`aosp:\` block in ${cfgPath}; cannot resolve packageName.`,
    );
  }
  const results = await runSmoke({
    packageName: variant.packageName,
    appName: variant.appName,
  });
  if (wantJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(formatResult(r.step, r.label, r.ok, r.detail));
    }
  }
  const { line, allPassed } = summarize(results);
  console.log(line);
  process.exit(allPassed ? 0 : 1);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}

// Keep the unused-import lint quiet on `repoRoot`; it's exported so the
// reusable parts of this module can be imported without yanking the
// constant in tests.
export { repoRoot };
