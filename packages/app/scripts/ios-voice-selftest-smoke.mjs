#!/usr/bin/env node
/**
 * iOS Simulator voice round-trip lane (#13688). WKWebView is not CDP-drivable,
 * so this mirrors ios-attachment-smoke: seed Capacitor Preferences, launch the
 * installed app, then let the in-app voice verifier drive the SAME production
 * `runVoiceSelfTest` harness — bundled speech clip ("what time is it") -> real
 * on-device/local ASR -> real agent over SSE -> real TTS decode+playback — and
 * report the machine-readable per-stage verdict back through Preferences.
 *
 * ## Modes (#18313)
 *
 * `--mode local` (default): exercises the REAL on-device voice pipeline. Seeds
 * `eliza:mobile-runtime-mode=local`, `eliza:first-run-complete=1`, and the
 * canonical `eliza-local-agent://ipc` active-server record so the app boots
 * straight into the on-device IPC agent. Does NOT start a remote host or arm
 * remote onboarding — the deterministic host agent lacks plugin-local-inference
 * and ASR/TTS, so it could never satisfy this acceptance contract.
 *
 * `--mode remote`: preserves the original behavior for remote-agent
 * compatibility. Starts the deterministic host agent (or uses `--api-base`),
 * arms remote onboarding, and runs the voice round-trip against that backend.
 * This mode is only a valid voice proof if the remote host actually exposes the
 * real ASR/TTS backend.
 *
 * The host-side gate is `evaluateVoiceSelfTestReport`: overall must be `pass`
 * AND asr/send/tts must each be `pass` (a `skipped` stage — e.g. local ASR not
 * provisioned on the sim — fails loudly, exactly like
 * voice-selftest.android.spec.ts). The full report (transcript + reply + stage
 * grid) lands in test-results/ios-voice-selftest/ for human review.
 *
 * Audio round-trip note: the fixture path needs no microphone (wav-direct), so
 * the ASR->agent->TTS-decode legs run headless on the simulator. Verifying the
 * reply is AUDIBLE through a real speaker (acoustic output, echo cancellation)
 * requires audio hardware and is covered on the physical-device lane.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateStagedIosSideloadBundle,
  isLocalAgentRuntimeMode,
  LOCAL_AGENT_RUNTIME_MODES,
} from "../../app-core/scripts/lib/mobile-lane-stamp.mjs";
import { evaluateVoiceSelfTestReport } from "./ios-voice-selftest-lib.mjs";
import {
  generateVoiceTraceId,
  localRuntimePreferenceWrites,
  onboardingRequestJson,
  parseVoiceSelfTestMode,
  shouldStartRemoteHost,
  voiceRequestJson,
} from "./ios-voice-selftest-mode.mjs";
import {
  DEFAULT_HOST_AGENT_PORT,
  startDeviceE2eHostAgent,
} from "./lib/host-agent.mjs";
import {
  readRendererManifest,
  rendererManifestPathFromAppPath,
} from "./lib/ios-renderer-stamp.mjs";
import {
  captureIosSimulatorScreenshot,
  startIosSimulatorVideo,
} from "./lib/ios-simulator-capture.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = path.resolve(appDir, "..", "..");
const resultDir = path.join(appDir, "test-results", "ios-voice-selftest");
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

const ONBOARDING_REQUEST_KEY = "eliza:ios-onboarding-smoke:request";
const ONBOARDING_RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const VOICE_REQUEST_KEY = "eliza:ios-voice-selftest:request";
const VOICE_RESULT_KEY = "eliza:ios-voice-selftest:result";
const DEFAULT_HOST_AGENT_PORT_STRING = String(DEFAULT_HOST_AGENT_PORT);

const has = (flag) => process.argv.includes(flag);
const val = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const log = (message) => console.log(`[ios-voice-selftest] ${message}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function tryRun(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // error-policy:J6 optional host probe — callers treat null as an explicit
    // unavailable result and hard-fail separately when the value is required
    if (options.warnOnFailure) {
      log(
        `${options.label ?? `${command} ${args.join(" ")}`} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return null;
  }
}

function removePathRecursive(targetPath) {
  const result = spawnSync(
    "node",
    [cleanupHelperScript, path.relative(repoRoot, targetPath)],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `failed to remove ${targetPath}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAppIdentity() {
  const src = fs.readFileSync(path.join(appDir, "app.config.ts"), "utf8");
  const appId =
    val("--app-id") ??
    src.match(/appId:\s*["']([^"']+)["']/)?.[1] ??
    "ai.elizaos.app";
  const urlScheme =
    val("--url-scheme") ??
    src.match(/urlScheme:\s*["']([^"']+)["']/)?.[1] ??
    "elizaos";
  return { appId, urlScheme };
}

function simctl(args) {
  return run("xcrun", ["simctl", ...args], { stdio: "pipe" });
}

function bootedUdid() {
  const json = tryRun("xcrun", [
    "simctl",
    "list",
    "devices",
    "booted",
    "--json",
  ]);
  if (!json) return null;
  const parsed = JSON.parse(json);
  for (const devices of Object.values(parsed.devices ?? {})) {
    const booted = devices.find((device) => device.state === "Booted");
    if (booted?.udid) return booted.udid;
  }
  return null;
}

function ensureSimulatorBooted() {
  if (process.platform !== "darwin") {
    throw new Error("iOS voice self-test requires macOS with xcrun simctl.");
  }
  const existing = bootedUdid();
  if (existing) {
    log(`reusing booted simulator ${existing}`);
    return existing;
  }
  const target = val("--device", "iPhone 16 Pro");
  log(`booting simulator ${target}`);
  simctl(["boot", target]);
  tryRun("open", ["-a", "Simulator"]);
  const udid = bootedUdid();
  if (!udid) throw new Error(`Simulator ${target} did not reach Booted state.`);
  return udid;
}

function latestBuiltApp() {
  const derivedData = path.join(
    os.homedir(),
    "Library",
    "Developer",
    "Xcode",
    "DerivedData",
  );
  if (!fs.existsSync(derivedData)) return null;
  const output = tryRun("find", [
    derivedData,
    "-name",
    "App.app",
    "-path",
    "*/Debug-iphonesimulator/*",
    "-type",
    "d",
  ]);
  const apps = (output ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({ path: entry, mtimeMs: fs.statSync(entry).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return apps[0]?.path ?? null;
}

function installLatestApp(udid, appId) {
  if (has("--skip-install")) return;
  const appPath = val("--app-path") ?? latestBuiltApp();
  if (!appPath) {
    throw new Error(
      "Could not find a Debug-iphonesimulator App.app. Build the iOS simulator app first or pass --app-path.",
    );
  }
  tryRun("xcrun", ["simctl", "terminate", udid, appId]);
  tryRun("xcrun", ["simctl", "uninstall", udid, appId]);
  log(`installing ${appPath}`);
  simctl(["install", udid, appPath]);
  const installed = tryRun("xcrun", [
    "simctl",
    "get_app_container",
    udid,
    appId,
    "app",
  ]);
  if (!installed) {
    throw new Error(`${appId} was not installed after simctl install.`);
  }
}

function prefsDomainPath(udid, appId) {
  const container = tryRun("xcrun", [
    "simctl",
    "get_app_container",
    udid,
    appId,
    "data",
  ]);
  if (!container) return null;
  return path.join(container, "Library", "Preferences", appId);
}

function preferenceNativeKeys(key) {
  return [`CapacitorStorage.${key}`, key];
}

function defaultsDelete(udid, appId, key) {
  for (const nativeKey of preferenceNativeKeys(key)) {
    tryRun("xcrun", [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "delete",
      appId,
      nativeKey,
    ]);
  }
  const domainPath = prefsDomainPath(udid, appId);
  if (domainPath) {
    for (const nativeKey of preferenceNativeKeys(key)) {
      tryRun("defaults", ["delete", domainPath, nativeKey]);
    }
  }
}

function defaultsWriteString(udid, appId, key, value) {
  for (const [index, nativeKey] of preferenceNativeKeys(key).entries()) {
    const args = [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "write",
      appId,
      nativeKey,
      "-string",
      value,
    ];
    if (index === 0) run("xcrun", args, { stdio: "ignore" });
    else tryRun("xcrun", args);
  }
}

function defaultsReadString(udid, appId, key) {
  const domainPath = prefsDomainPath(udid, appId);
  if (domainPath) {
    const plist = `${domainPath}.plist`;
    if (fs.existsSync(plist)) {
      const json = tryRun("plutil", ["-convert", "json", "-o", "-", plist]);
      if (json) {
        try {
          const parsed = JSON.parse(json);
          for (const nativeKey of preferenceNativeKeys(key)) {
            if (typeof parsed[nativeKey] === "string") return parsed[nativeKey];
          }
        } catch (error) {
          // error-policy:J3 corrupt plist JSON — fall through to the native
          // defaults readers and keep the malformed source visible in logs
          log(
            `failed to parse ${plist}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    for (const nativeKey of preferenceNativeKeys(key)) {
      const value = tryRun("defaults", ["read", domainPath, nativeKey]);
      if (value !== null) return value;
    }
  }
  for (const nativeKey of preferenceNativeKeys(key)) {
    const value = tryRun("xcrun", [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "read",
      appId,
      nativeKey,
    ]);
    if (value !== null) return value;
  }
  return null;
}

function flushPreferences(udid) {
  tryRun("xcrun", ["simctl", "spawn", udid, "killall", "cfprefsd"]);
}

const STATE_KEYS = [
  ONBOARDING_REQUEST_KEY,
  ONBOARDING_RESULT_KEY,
  VOICE_REQUEST_KEY,
  VOICE_RESULT_KEY,
  "elizaos:active-server",
  "eliza:first-run-complete",
  "eliza:setup:step",
  "eliza:onboarding-complete",
  "eliza:mobile-runtime-mode",
  "eliza.background.config",
  "elizaos:first-run:force-fresh",
];

function clearState(udid, appId) {
  for (const key of STATE_KEYS) defaultsDelete(udid, appId, key);
}

function takeScreenshot(udid, label) {
  try {
    return captureIosSimulatorScreenshot({
      target: udid,
      artifactDir: resultDir,
      filename: `${label}.png`,
      log,
    });
  } catch (error) {
    // error-policy:J6 best-effort evidence capture — the test verdict still
    // comes from the machine-readable voice report
    log(
      `screenshot "${label}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function startVideo(udid) {
  if (has("--no-video")) return null;
  return startIosSimulatorVideo({
    target: udid,
    artifactDir: resultDir,
    filename: "voice-selftest.mp4",
    log,
  });
}

async function stopVideo(recording) {
  if (!recording) return null;
  return recording.stop();
}

/**
 * Assert that the installed app's renderer manifest carries a local runtime
 * mode — not just a matching buildId (finding #2). The base
 * `assertInstalledIosAppRendererFresh` compares only `buildId` and reads
 * `runtimeMode` from the manifest but never asserts it, so a cloud/thin-client
 * app with the same buildId passes without local renderer mode, native local
 * configuration, or the full Bun engine. This also evaluates the staged
 * sideload bundle via `evaluateStagedIosSideloadBundle` to check both the
 * renderer manifest and the native Capacitor config.
 */
function assertInstalledAppLocalRuntime({ udid, appId }) {
  // Finding #2: assert runtimeMode === local in the renderer manifest
  const appPath = tryRun("xcrun", [
    "simctl",
    "get_app_container",
    udid,
    appId,
    "app",
  ]);
  if (!appPath) {
    throw new Error(
      `Cannot verify renderer stamp: ${appId} is not installed in simulator ${udid}.`,
    );
  }
  const manifestPath = rendererManifestPathFromAppPath(appPath.trim());
  const installed = readRendererManifest(manifestPath, `installed ${appId}`);
  if (!isLocalAgentRuntimeMode(installed.runtimeMode)) {
    throw new Error(
      `Installed app renderer runtimeMode is '${installed.runtimeMode}', not a local mode (${LOCAL_AGENT_RUNTIME_MODES.join(", ")}). ` +
        `A cloud/thin-client bundle with the same buildId cannot drive the on-device ASR/TTS pipeline. ` +
        `Rebuild with \`bun run --cwd packages/app build:ios:local\`.`,
    );
  }
  log(`renderer runtimeMode OK: '${installed.runtimeMode}' for ${appId}`);

  // Finding #2: also evaluate the staged native Capacitor config via
  // evaluateStagedIosSideloadBundle so the native Agent plugin config is
  // checked too — not just the renderer manifest.
  const iosAppDir = path.join(appDir, "ios", "App", "App");
  const capacitorConfigPath = path.join(iosAppDir, "capacitor.config.json");
  let agentConfig = null;
  let rendererManifest = null;
  if (fs.existsSync(capacitorConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(capacitorConfigPath, "utf8"));
      agentConfig = config?.plugins?.Agent ?? null;
    } catch {
      // error-policy:J4 unavailable config — the renderer check above already
      // validates the critical path; this is a best-effort native-side check
    }
  }
  if (fs.existsSync(manifestPath)) {
    try {
      rendererManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      // error-policy:J4 manifest already validated by readRendererManifest above
    }
  }
  const verdict = evaluateStagedIosSideloadBundle({
    agentConfig,
    rendererManifest,
  });
  if (verdict.staged && !verdict.ok) {
    throw new Error(
      `Staged iOS bundle is not safe for local voice self-test: ${verdict.reason}`,
    );
  }
  log(`staged sideload bundle OK: ${verdict.reason}`);
}

/**
 * Preflight the voice-bundle artifacts required by the on-device voice
 * pipeline before arming the production voice request (finding #3). A
 * correctly local app with missing assets still ends at ASR-not-ready; this
 * surfaces an actionable error listing which artifacts are missing so the
 * operator can stage them instead of chasing a confusing ASR skip.
 */
function preflightVoiceBundle() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const asrDir =
    process.env.ELIZA_IOS_ASR_MODEL_DIR ??
    path.join(home, ".cache/eliza/asr-model");
  const ttsDir =
    process.env.ELIZA_IOS_TTS_MODEL_DIR ??
    path.join(home, ".local/state/eliza/local-inference/models/omnivoice");
  const textDir =
    process.env.ELIZA_IOS_TEXT_MODEL_DIR ??
    path.join(home, ".local/state/eliza/local-inference/models/text");
  const requiredArtifacts = [
    { label: "ASR model", file: path.join(asrDir, "eliza-1-asr.gguf") },
    {
      label: "ASR mmproj",
      file: path.join(asrDir, "eliza-1-asr-mmproj.gguf"),
    },
    {
      label: "TTS model",
      file: path.join(ttsDir, "omnivoice-base-q4_k_m.gguf"),
    },
    {
      label: "TTS tokenizer",
      file: path.join(ttsDir, "omnivoice-tokenizer-q4_k_m.gguf"),
    },
    { label: "Text model", file: path.join(textDir, "eliza-1-2b.gguf") },
  ];
  const missing = requiredArtifacts.filter((a) => !fs.existsSync(a.file));
  if (missing.length > 0) {
    const missingList = missing
      .map((a) => `  - ${a.label}: ${a.file}`)
      .join("\n");
    throw new Error(
      `Voice bundle preflight failed — ${missing.length} required artifact(s) missing on host:\n${missingList}\n` +
        `Stage these before arming the local voice self-test, or set ELIZA_IOS_ASR_MODEL_DIR / ELIZA_IOS_TTS_MODEL_DIR / ELIZA_IOS_TEXT_MODEL_DIR to the correct directories.`,
    );
  }
  const present = requiredArtifacts
    .filter((a) => fs.existsSync(a.file))
    .map((a) => `${a.label}: ${a.file}`);
  log(
    `voice bundle preflight OK (${present.length}/${requiredArtifacts.length} artifacts present)`,
  );
}

async function pollResult(udid, appId, traceId) {
  const attempts = Number.parseInt(
    process.env.IOS_VOICE_SELFTEST_ATTEMPTS ?? "300",
    10,
  );
  const delayMs = Number.parseInt(
    process.env.IOS_VOICE_SELFTEST_DELAY_MS ?? "1000",
    10,
  );
  let lastRaw = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastRaw = defaultsReadString(udid, appId, VOICE_RESULT_KEY) ?? "";
    if (lastRaw) {
      let parsed = null;
      try {
        parsed = JSON.parse(lastRaw);
      } catch (error) {
        // error-policy:J3 corrupt interim result blob — keep polling until a
        // valid terminal result arrives or the lane times out
        if (attempt % 15 === 0) {
          log(
            `result JSON parse failed (${attempt}/${attempts}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        parsed = null;
      }
      if (parsed?.phase === "complete" || parsed?.phase === "failed") {
        // Finding #4: reject stale results that don't carry the current
        // traceId — under --skip-install, retained WebView storage can
        // republish an older terminal report after native Preferences are
        // reset, producing a false-green.
        if (traceId && parsed.traceId && parsed.traceId !== traceId) {
          if (attempt % 15 === 0) {
            log(
              `stale result (traceId ${parsed.traceId} != current ${traceId}), continuing to poll`,
            );
          }
        } else {
          return parsed;
        }
        continue;
      }
      if (parsed?.error) {
        if (traceId && parsed.traceId && parsed.traceId !== traceId) {
          // error-policy:J4 stale error from a previous run — keep polling
        } else {
          return parsed;
        }
      }
      if (attempt % 15 === 0) {
        log(`still running (${attempt}/${attempts}): ${lastRaw.slice(0, 200)}`);
      }
    }
    await sleep(delayMs);
  }
  throw new Error(
    `iOS voice self-test timed out after ${attempts} attempts. Last result: ${lastRaw || "<none>"}`,
  );
}

async function main() {
  const { appId } = readAppIdentity();
  const mode = parseVoiceSelfTestMode(process.argv);
  let apiBase = val("--api-base");
  const udid = ensureSimulatorBooted();
  removePathRecursive(resultDir);
  fs.mkdirSync(resultDir, { recursive: true });
  log(`mode: ${mode}`);

  // Only remote mode (without an explicit --api-base) starts the deterministic
  // host agent. Local mode never does — the on-device agent owns the pipeline,
  // and the host agent does NOT register plugin-local-inference or ASR/TTS, so
  // it can never satisfy the real voice acceptance contract (#18313).
  const hostAgent = shouldStartRemoteHost({ mode, apiBase })
    ? await startDeviceE2eHostAgent({
        repoRoot,
        artifactDir: resultDir,
        requestedPort: val("--host-agent-port"),
        preferredPort:
          process.env.ELIZA_IOS_HOST_AGENT_PORT ??
          DEFAULT_HOST_AGENT_PORT_STRING,
        log,
      })
    : null;
  apiBase = apiBase ?? hostAgent?.apiBase ?? null;
  const traceId = generateVoiceTraceId();
  log(`traceId: ${traceId}`);
  let recording = null;

  try {
    clearState(udid, appId);
    flushPreferences(udid);
    installLatestApp(udid, appId);
    tryRun("xcrun", ["simctl", "terminate", udid, appId]);
    clearState(udid, appId);

    // Local mode: seed the iOS simulator preferences for local runtime before
    // launch — same triple as mobile-local-chat-smoke --ios-select-local. This
    // puts the app straight into the on-device IPC agent, bypassing first-run
    // onboarding so the in-app voice verifier hits the real ASR/TTS backend.
    // Remote mode: arm the remote onboarding request so the in-app verifier
    // connects to the host agent.
    const runtimePrefs = localRuntimePreferenceWrites({ mode });
    for (const { key, value } of runtimePrefs) {
      defaultsWriteString(udid, appId, key, value);
    }

    const onboardingRequest = onboardingRequestJson({ mode, apiBase });
    if (onboardingRequest !== null) {
      defaultsWriteString(
        udid,
        appId,
        ONBOARDING_REQUEST_KEY,
        onboardingRequest,
      );
      defaultsWriteString(
        udid,
        appId,
        ONBOARDING_RESULT_KEY,
        JSON.stringify({
          ok: false,
          phase: "requested",
          apiBase,
          updatedAt: new Date().toISOString(),
        }),
      );
    }

    defaultsWriteString(
      udid,
      appId,
      VOICE_REQUEST_KEY,
      voiceRequestJson({ mode, apiBase, traceId }),
    );
    defaultsWriteString(
      udid,
      appId,
      VOICE_RESULT_KEY,
      JSON.stringify({
        ok: false,
        phase: "requested",
        apiBase,
        traceId,
        updatedAt: new Date().toISOString(),
      }),
    );
    flushPreferences(udid);

    // Validate that the installed app is a fresh full-Bun local build with
    // local runtime mode before collecting voice evidence (finding #2). A
    // stale or cloud-only (thin-client) install with the same buildId passes
    // the freshness check but cannot drive the on-device ASR/TTS pipeline.
    if (mode === "local") {
      assertInstalledAppLocalRuntime({ udid, appId });
      // Preflight voice bundle artifacts so a correctly local app with missing
      // assets fails with an actionable error instead of a confusing
      // ASR-not-ready skip (finding #3).
      preflightVoiceBundle();
    }

    recording = startVideo(udid);
    log(`launching ${appId} on ${udid}`);
    simctl(["launch", udid, appId]);
    await sleep(1500);
    takeScreenshot(udid, "fresh-launch");
    if (mode === "local") {
      log("armed in-app local voice self-test (on-device ASR/TTS pipeline)");
    } else {
      log(
        `armed in-app first-run remote connect + voice self-test for ${apiBase}`,
      );
    }

    const result = await pollResult(udid, appId, traceId);
    const screenshot = takeScreenshot(udid, "voice-selftest-result");
    const video = await stopVideo(recording);

    fs.writeFileSync(
      path.join(resultDir, "result.json"),
      `${JSON.stringify({ ...result, mode, traceId, screenshot, video }, null, 2)}\n`,
    );

    const verdict = evaluateVoiceSelfTestReport(result.report ?? result);
    if (!verdict.pass) {
      throw new Error(
        `iOS voice round-trip did not pass: ${verdict.reasons.join("; ")}\nstages=${JSON.stringify(verdict.stageStatuses)} transcript=${JSON.stringify(verdict.transcript)} reply=${JSON.stringify(verdict.reply.slice(0, 120))}`,
      );
    }
    log(
      `PASS overall=${verdict.overall} stages=${JSON.stringify(verdict.stageStatuses)} transcript=${JSON.stringify(verdict.transcript)} reply=${JSON.stringify(verdict.reply.slice(0, 120))}`,
    );
    log(`artifacts: ${resultDir}`);
  } catch (error) {
    // error-policy:J1 simulator smoke boundary — capture best-effort evidence
    // and rethrow so the CLI exits nonzero
    const screenshot = takeScreenshot(udid, "failure");
    await stopVideo(recording);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${screenshot ? ` (screenshot: ${screenshot})` : ""}`,
    );
  } finally {
    await hostAgent?.stop();
  }
}

main().catch((error) => {
  // error-policy:J1 CLI boundary — the caller observes the nonzero exit
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
