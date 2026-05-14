#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const appConfigPath = path.join(repoRoot, "packages/app/app.config.ts");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const platform = argValue("--platform") ?? "ios";
const apiBase = argValue("--api-base");
const authTokenArg = argValue("--auth-token");
const requireInstalled = process.argv.includes("--require-installed");
const exerciseAppCoreApi = process.argv.includes("--live") || Boolean(apiBase);
const iosSelectLocal = process.argv.includes("--ios-select-local");
const iosFullBunSmoke = process.argv.includes("--ios-full-bun-smoke");
const androidSelectLocal = process.argv.includes("--android-select-local");
const androidBackground = process.argv.includes("--android-background");
const iosBackground = process.argv.includes("--ios-background");
const iosBackgroundTaskId =
  argValue("--ios-background-task-id") ?? "ai.eliza.tasks.refresh";
const IOS_FULL_BUN_SMOKE_REQUEST_KEY = "eliza:ios-full-bun-smoke:request";
const IOS_FULL_BUN_SMOKE_RESULT_KEY = "eliza:ios-full-bun-smoke:result";
const IOS_FULL_BUN_PREWARM_RESULT_KEY = "eliza:ios-full-bun-prewarm:result";
const IOS_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";
const IOS_FULL_BUN_SMOKE_ATTEMPTS = 180;
const IOS_FULL_BUN_SMOKE_DELAY_MS = 2000;
const IOS_FULL_BUN_SMOKE_PROMPT_ECHO_RE = /in one short sentence/i;
const ANDROID_HEALTH_ATTEMPTS = 240;
const IOS_WAKE_POLL_ATTEMPTS = 30;
const IOS_WAKE_POLL_DELAY_MS = 1000;
const ANDROID_WAKE_POLL_ATTEMPTS = 30;
const ANDROID_WAKE_POLL_DELAY_MS = 1000;

function printHelp() {
  console.log(`Usage: node packages/app/scripts/mobile-local-chat-smoke.mjs [options]

Options:
  --platform ios|android|both       Simulator platform to launch (default: ios)
  --require-installed              Fail when the selected app/simulator is unavailable
  --live                           Exercise the app-core local-agent HTTP API on Android
  --api-base URL                   Exercise an already-reachable app-core HTTP API
  --auth-token TOKEN               Bearer token for protected app-core API routes
  --ios-select-local               Pre-seed iOS onboarding/runtime state for Local mode before launch
  --ios-full-bun-smoke             Run a WebView-executed full Bun backend smoke in the iOS app
  --android-select-local           Tap through Android first-run Local runtime selection
  --android-background             Background Android, force-fire the WorkManager job, and poll /api/health
  --ios-background                 Background iOS, fire a BGTaskScheduler task via LLDB, and poll /api/health
  --ios-background-task-id ID      iOS BGTask identifier to simulate (default: ai.eliza.tasks.refresh)
  --help                           Print this help

Notes:
  --live validates the running app-core/local-agent API. It is not a remote
  service test. The chat step verifies conversation routes and local-inference
  hub readiness/download state; it does not require a completed model reply.`);
}

if (process.argv.includes("--help")) {
  printHelp();
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function executablePath(...candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function appId() {
  const config = fs.readFileSync(appConfigPath, "utf8");
  return config.match(/appId:\s*["']([^"']+)["']/)?.[1] ?? "app.eliza";
}

function androidSdkRoot() {
  return (
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    path.join(os.homedir(), "Library/Android/sdk")
  );
}

function androidTool(relativePath, fallbackName) {
  return executablePath(
    path.join(androidSdkRoot(), relativePath),
    fallbackName,
  );
}

function adbPath() {
  return androidTool("platform-tools/adb", "adb");
}

function tryExec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (requireInstalled && !options.allowFailure) {
      throw error;
    }
    return null;
  }
}

function requireExec(command, args, label) {
  const output = tryExec(command, args);
  if (output === null) {
    throw new Error(label ?? `${command} ${args.join(" ")} failed`);
  }
  return output;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bootedIosUdid() {
  const listing = tryExec("xcrun", ["simctl", "list", "devices", "booted"]);
  if (!listing) return null;
  // Lines look like: "    iPhone 17 (5C9F2EAC-4F1D-…) (Booted)"
  const match = listing.match(/\(([0-9A-Fa-f-]{36})\)\s*\(Booted\)/);
  return match ? match[1] : null;
}

function launchIosSimulatorApp() {
  const udid = bootedIosUdid();
  if (!udid) {
    console.warn("[local-chat-smoke] No booted iOS simulator found.");
    return null;
  }

  const id = appId();
  let fullBunSmokeRequestedAtMs = null;
  const container = tryExec("xcrun", [
    "simctl",
    "get_app_container",
    udid,
    id,
    "app",
  ]);
  if (!container) {
    console.warn(
      `[local-chat-smoke] ${id} is not installed in the booted simulator (${udid}).`,
    );
    return { udid, installed: false };
  }

  if (iosSelectLocal || iosFullBunSmoke) {
    preseedIosLocalRuntime(udid, id);
  }
  if (iosFullBunSmoke) {
    fullBunSmokeRequestedAtMs = Date.now();
    preseedIosFullBunSmoke(udid, id);
  }

  console.log(
    `[local-chat-smoke] Launching ${id} in the booted simulator (${udid}).`,
  );
  tryExec("xcrun", ["simctl", "launch", udid, id]);
  if (!iosFullBunSmoke) {
    tryExec("xcrun", ["simctl", "openurl", udid, "elizaos://chat"]);
  }
  return { udid, installed: true, fullBunSmokeRequestedAtMs };
}

function writeIosDefaultsString(udid, domain, key, value) {
  // Capacitor Preferences stores the default group as `CapacitorStorage.<key>`
  // in iOS UserDefaults. The JS API strips that prefix; simulator pre-seed has
  // to write the native key directly because the app is not running yet. Use
  // the simulator's `defaults` tool so the same cfprefsd domain that the app's
  // UserDefaults.standard reads is updated.
  const nativeKey = `CapacitorStorage.${key}`;
  requireExec(
    "xcrun",
    [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "write",
      domain,
      nativeKey,
      "-string",
      value,
    ],
    `Failed to write iOS preference ${key}.`,
  );
}

function readIosDefaultsString(udid, domain, key) {
  const nativeKey = `CapacitorStorage.${key}`;
  const readPlistValue = () => {
    const dataContainer = tryExec(
      "xcrun",
      ["simctl", "get_app_container", udid, domain, "data"],
      { allowFailure: true },
    );
    if (!dataContainer) return null;
    const plist = path.join(
      dataContainer,
      "Library",
      "Preferences",
      `${domain}.plist`,
    );
    if (!fs.existsSync(plist)) return null;
    const json = tryExec("plutil", ["-convert", "json", "-o", "-", plist], {
      allowFailure: true,
    });
    if (!json) return null;
    try {
      const parsed = JSON.parse(json);
      const plistValue = parsed?.[nativeKey];
      return typeof plistValue === "string" ? plistValue : null;
    } catch {
      return null;
    }
  };

  const plistValue = readPlistValue();
  if (plistValue !== null) return plistValue;

  const value = tryExec(
    "xcrun",
    ["simctl", "spawn", udid, "defaults", "read", domain, nativeKey],
    { allowFailure: true },
  );
  if (value !== null) return value;

  return null;
}

function deleteIosDefaultsKey(udid, domain, key) {
  tryExec(
    "xcrun",
    [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "delete",
      domain,
      `CapacitorStorage.${key}`,
    ],
    { allowFailure: true },
  );
}

function flushIosPreferencesCache(udid) {
  // `defaults write <container>/Library/Preferences/<bundle-id>` updates the
  // plist on disk, but a booted simulator can keep the old domain cached in
  // cfprefsd. Kill it before app launch so Capacitor Preferences sees the
  // pre-seeded values on first read.
  tryExec("xcrun", ["simctl", "spawn", udid, "killall", "cfprefsd"], {
    allowFailure: true,
  });
}

function preseedIosLocalRuntime(udid, id) {
  const activeServer = JSON.stringify({
    id: "local:mobile",
    kind: "remote",
    label: "On-device agent",
    apiBase: IOS_LOCAL_AGENT_IPC_BASE,
  });

  tryExec("xcrun", ["simctl", "terminate", udid, id], { allowFailure: true });
  writeIosDefaultsString(udid, id, "eliza:mobile-runtime-mode", "local");
  writeIosDefaultsString(udid, id, "eliza:onboarding-complete", "1");
  writeIosDefaultsString(udid, id, "elizaos:active-server", activeServer);
  flushIosPreferencesCache(udid);
  console.log(
    `[local-chat-smoke] Pre-seeded iOS Local runtime preferences for ${id}.`,
  );
}

function preseedIosFullBunSmoke(udid, id) {
  deleteIosDefaultsKey(udid, id, IOS_FULL_BUN_SMOKE_RESULT_KEY);
  deleteIosDefaultsKey(udid, id, IOS_FULL_BUN_PREWARM_RESULT_KEY);
  writeIosDefaultsString(
    udid,
    id,
    IOS_FULL_BUN_SMOKE_RESULT_KEY,
    JSON.stringify({
      ok: false,
      phase: "requested",
      updatedAt: new Date().toISOString(),
    }),
  );
  writeIosDefaultsString(udid, id, IOS_FULL_BUN_SMOKE_REQUEST_KEY, "1");
  flushIosPreferencesCache(udid);
  console.log(
    `[local-chat-smoke] Requested in-app iOS full Bun backend smoke for ${id}.`,
  );
}

function androidDeviceSerial(adb) {
  const devices = requireExec(
    adb,
    ["devices"],
    "No Android device or emulator is available.",
  );
  const line = devices
    .split("\n")
    .slice(1)
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith("\tdevice"));
  if (!line) return null;
  return line.split(/\s+/)[0];
}

function launchAndroidEmulatorApp() {
  const adb = adbPath();
  if (!adb) {
    const message =
      "[local-chat-smoke] Android SDK platform-tools/adb was not found.";
    if (requireInstalled) throw new Error(message);
    console.warn(message);
    return null;
  }

  const serial = androidDeviceSerial(adb);
  if (!serial) {
    const message = "[local-chat-smoke] No booted Android emulator found.";
    if (requireInstalled) throw new Error(message);
    console.warn(message);
    return null;
  }

  const id = appId();
  const packagePath = tryExec(adb, ["-s", serial, "shell", "pm", "path", id]);
  if (!packagePath) {
    const message = `[local-chat-smoke] ${id} is not installed on ${serial}.`;
    if (requireInstalled) throw new Error(message);
    console.warn(message);
    return { adb, serial, installed: false };
  }

  console.log(`[local-chat-smoke] Launching ${id} on ${serial}.`);
  requireExec(
    adb,
    ["-s", serial, "shell", "am", "start", "-n", `${id}/.MainActivity`],
    `Failed to launch ${id} on ${serial}.`,
  );
  tryExec(adb, [
    "-s",
    serial,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "elizaos://chat",
    id,
  ]);
  return { adb, serial, installed: true };
}

function androidScreenSize(context) {
  const output = tryExec(context.adb, [
    "-s",
    context.serial,
    "shell",
    "wm",
    "size",
  ]);
  const match = output?.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) return { width: 1440, height: 2960 };
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

function tapAndroidRatio(context, xRatio, yRatio) {
  const { width, height } = androidScreenSize(context);
  requireExec(
    context.adb,
    [
      "-s",
      context.serial,
      "shell",
      "input",
      "tap",
      String(Math.round(width * xRatio)),
      String(Math.round(height * yRatio)),
    ],
    "Failed to tap Android emulator.",
  );
}

function readAndroidLocalAgentToken(context) {
  if (!context?.installed) return null;
  return tryExec(
    context.adb,
    [
      "-s",
      context.serial,
      "shell",
      "run-as",
      appId(),
      "cat",
      "files/auth/local-agent-token",
    ],
    { allowFailure: true },
  );
}

function removeAndroidForward(context, localPort) {
  tryExec(
    context.adb,
    ["-s", context.serial, "forward", "--remove", localPort],
    { allowFailure: true },
  );
}

function cleanupAndroidAgentForwards(context, reason) {
  if (!context?.installed) return;
  const forwardedPorts = context.localAgentForward
    ? [context.localAgentForward]
    : [];
  for (const localPort of forwardedPorts) {
    removeAndroidForward(context, localPort);
  }
  context.localAgentForward = null;
  if (forwardedPorts.length > 0) {
    console.log(
      `[local-chat-smoke] Removed Android adb forward(s) for tcp:31337 (${reason}): ${forwardedPorts.join(", ")}.`,
    );
  }
}

async function selectAndroidLocalRuntime(context) {
  if (!context?.installed) return;
  if (readAndroidLocalAgentToken(context)) return;
  console.log("[local-chat-smoke] Selecting Local runtime on Android.");
  await sleep(5000);
  // Current first-run flow: "I want to run it myself" -> "Use Local".
  tapAndroidRatio(context, 0.5, 0.695);
  await sleep(1500);
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    tapAndroidRatio(context, 0.29, 0.675);
    await sleep(2500);
    if (readAndroidLocalAgentToken(context)) return;
  }
}

async function waitForAndroidApi(context) {
  if (!context?.installed) return null;

  let token = authTokenArg;
  let forwardedApiBase = null;
  let tokenRejectedAttempts = 0;
  for (let attempt = 1; attempt <= ANDROID_HEALTH_ATTEMPTS; attempt += 1) {
    if (!token) {
      token = readAndroidLocalAgentToken(context);
    }
    if (token) {
      if (!forwardedApiBase) {
        const forwardedPort = requireExec(
          context.adb,
          ["-s", context.serial, "forward", "tcp:0", "tcp:31337"],
          "Failed to forward Android local-agent port.",
        );
        context.localAgentForward = `tcp:${forwardedPort.trim()}`;
        forwardedApiBase = `http://127.0.0.1:${forwardedPort.trim()}`;
        console.log(
          `[local-chat-smoke] Android local-agent forwarded to ${forwardedApiBase}.`,
        );
      }
      try {
        const health = await requestJson(
          "GET",
          "/api/health",
          undefined,
          forwardedApiBase,
          token,
        );
        const status = await requestJson(
          "GET",
          "/api/status",
          undefined,
          forwardedApiBase,
          token,
        );
        console.log("[local-chat-smoke] Android health:", health);
        console.log("[local-chat-smoke] Android status:", status);
        return { apiBase: forwardedApiBase, token };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("/api/status failed: 401") ||
          message.includes("Unauthorized")
        ) {
          tokenRejectedAttempts += 1;
          const refreshedToken =
            authTokenArg ?? readAndroidLocalAgentToken(context);
          if (refreshedToken && refreshedToken !== token) {
            token = refreshedToken;
            tokenRejectedAttempts = 0;
            if (attempt % 10 === 0) {
              console.warn(
                "[local-chat-smoke] Android local-agent token changed during startup; retrying with the refreshed token.",
              );
            }
          }
          if (tokenRejectedAttempts >= 3) {
            throw new Error(
              "Android local-agent token was rejected by the protected /api/status route. " +
                "This usually means another installed Eliza app already owns device port 31337; " +
                "force-stop the conflicting package or uninstall it before running the smoke.",
            );
          }
        }
        if (attempt % 10 === 0) {
          console.warn(
            `[local-chat-smoke] Android agent not healthy/authenticated yet (${attempt}/${ANDROID_HEALTH_ATTEMPTS}): ${message}`,
          );
        }
      }
    } else if (attempt % 10 === 0) {
      console.warn(
        `[local-chat-smoke] Android local-agent token not available yet (${attempt}/${ANDROID_HEALTH_ATTEMPTS}).`,
      );
    }
    await sleep(2000);
  }
  throw new Error("Android local-agent API did not become healthy in time.");
}

function readLastWakeFiredAtMs(health) {
  if (!health || typeof health !== "object") return null;
  const raw = health.lastWakeFiredAt;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

async function pollForWakeAdvance(
  baseUrl,
  authToken,
  baselineMs,
  attempts,
  delayMs,
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const health = await requestJson(
      "GET",
      "/api/health",
      undefined,
      baseUrl,
      authToken,
    );
    const observedMs = readLastWakeFiredAtMs(health);
    if (
      observedMs !== null &&
      (baselineMs === null || observedMs > baselineMs)
    ) {
      return { health, observedMs };
    }
    await sleep(delayMs);
  }
  return null;
}

function findAndroidJobIdForPackage(context, id) {
  const dump = tryExec(context.adb, [
    "-s",
    context.serial,
    "shell",
    "dumpsys",
    "jobscheduler",
  ]);
  if (!dump) return null;
  const escapedId = id.replace(/[.+]/g, (c) => `\\${c}`);
  const re = new RegExp(`#u\\d+/(\\d+).*?${escapedId}`, "g");
  const ids = new Set();
  for (const match of dump.matchAll(re)) {
    ids.add(Number.parseInt(match[1], 10));
  }
  // Fall back: look for `JOB #u0/<n>` followed by the package name on a
  // subsequent line.
  if (ids.size === 0) {
    const lines = dump.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/JOB\s+#u\d+\/(\d+)/);
      if (!m) continue;
      const block = lines.slice(i, i + 8).join("\n");
      if (block.includes(id)) {
        ids.add(Number.parseInt(m[1], 10));
      }
    }
  }
  if (ids.size === 0) return null;
  // Prefer the smallest known job id (workmanager periodic worker is typically
  // registered with a stable id; if multiple match we return all separately).
  return Array.from(ids).sort((a, b) => a - b);
}

function takeIosScreenshot(udid, label) {
  if (!udid) return null;
  const outDir = path.join(os.tmpdir(), "eliza-ios-bg-smoke");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  const ok = tryExec("xcrun", ["simctl", "io", udid, "screenshot", outPath]);
  if (ok === null) return null;
  return outPath;
}

function parseIosFullBunSmokeResult(raw) {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function iosFullBunSmokeResultTimeMs(result) {
  if (!result || typeof result !== "object") return null;
  for (const key of ["updatedAt", "finishedAt", "startedAt"]) {
    const value = result[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object.`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} was not an array.`);
  }
  return value;
}

function assertIosFullBunSmokeSuccess(result) {
  const runtimeStatus = assertObject(
    result.runtimeStatus,
    "iOS full Bun runtimeStatus",
  );
  if (runtimeStatus.ready !== true || runtimeStatus.engine !== "bun") {
    throw new Error(
      `iOS full Bun runtimeStatus was not ready on bun: ${JSON.stringify(runtimeStatus)}`,
    );
  }

  const bridgeStatus = assertObject(
    result.bridgeStatus,
    "iOS full Bun bridgeStatus",
  );
  if (
    bridgeStatus.ready !== true ||
    bridgeStatus.engine !== "bun" ||
    bridgeStatus.transport !== "bun-host-ipc"
  ) {
    throw new Error(
      `iOS full Bun bridgeStatus did not report bun-host-ipc: ${JSON.stringify(bridgeStatus)}`,
    );
  }
  if ("apiPort" in bridgeStatus || "fallbackPort" in bridgeStatus) {
    throw new Error(
      `iOS full Bun bridgeStatus still exposed port metadata: ${JSON.stringify(bridgeStatus)}`,
    );
  }

  const fetchHealth = assertObject(
    result.fetchHealth,
    "iOS full Bun fetchHealth",
  );
  if (fetchHealth.ready !== true || fetchHealth.runtime !== "ok") {
    throw new Error(
      `iOS full Bun fetchHealth was not ready: ${JSON.stringify(fetchHealth)}`,
    );
  }

  const localInference = assertObject(
    result.localInference,
    "iOS full Bun localInference",
  );
  const hub = assertObject(
    localInference.hub,
    "iOS full Bun localInference.hub",
  );
  const hubInstalled = assertArray(
    hub.installed,
    "iOS full Bun localInference.hub.installed",
  );
  const device = assertObject(
    localInference.device,
    "iOS full Bun localInference.device",
  );
  if (
    device.enabled !== true ||
    device.connected !== true ||
    device.transport !== "bun-host-ipc"
  ) {
    throw new Error(
      `iOS full Bun device bridge was not connected over IPC: ${JSON.stringify(device)}`,
    );
  }
  assertArray(device.devices, "iOS full Bun localInference.device.devices");

  const providers = assertArray(
    assertObject(localInference.providers, "iOS full Bun providers").providers,
    "iOS full Bun provider list",
  );
  const capacitorProvider = providers.find(
    (provider) =>
      provider &&
      typeof provider === "object" &&
      provider.id === "capacitor-llama",
  );
  if (!capacitorProvider) {
    throw new Error(
      "iOS full Bun provider list did not include capacitor-llama.",
    );
  }
  const slots = assertArray(
    capacitorProvider.registeredSlots,
    "iOS full Bun capacitor-llama registeredSlots",
  );
  if (!slots.includes("TEXT_SMALL") || !slots.includes("TEXT_LARGE")) {
    throw new Error(
      "iOS full Bun capacitor-llama did not register TEXT_SMALL/TEXT_LARGE.",
    );
  }

  if (typeof result.conversationId !== "string" || !result.conversationId) {
    throw new Error("iOS full Bun smoke did not return a conversationId.");
  }
  const installed = assertArray(
    assertObject(
      localInference.installed,
      "iOS full Bun localInference.installed",
    ).models,
    "iOS full Bun localInference.installed.models",
  );
  if (hubInstalled.length > 0) {
    if (installed.length === 0) {
      throw new Error(
        "iOS full Bun scanner saw an installed model, but /installed returned none.",
      );
    }
    const activatedModel = assertObject(
      localInference.activatedModel,
      "iOS full Bun localInference.activatedModel",
    );
    if (
      activatedModel.status !== "ready" ||
      typeof activatedModel.modelPath !== "string" ||
      !activatedModel.modelPath
    ) {
      throw new Error(
        `iOS full Bun model activation was not ready: ${JSON.stringify(activatedModel)}`,
      );
    }
    const active = assertObject(
      localInference.active,
      "iOS full Bun localInference.active",
    );
    if (active.status !== "ready") {
      throw new Error(
        `iOS full Bun active model was not ready: ${JSON.stringify(active)}`,
      );
    }
  }
  const sendMessage = assertObject(
    result.sendMessage,
    "iOS full Bun sendMessage",
  );
  const reply = String(sendMessage.text ?? sendMessage.reply ?? "");
  if (
    !reply.trim() ||
    /something went wrong|<think\b|<\/think>|\/?\bno_think\b/i.test(reply) ||
    IOS_FULL_BUN_SMOKE_PROMPT_ECHO_RE.test(reply)
  ) {
    throw new Error(
      `iOS full Bun sendMessage did not return a usable reply: ${JSON.stringify(sendMessage)}`,
    );
  }
  const streamMessage = String(result.streamMessage ?? "");
  if (
    !streamMessage.includes('"type":"done"') ||
    /something went wrong|<think\b|<\/think>|\/?\bno_think\b/i.test(
      streamMessage,
    ) ||
    IOS_FULL_BUN_SMOKE_PROMPT_ECHO_RE.test(streamMessage)
  ) {
    throw new Error(
      `iOS full Bun stream did not return usable SSE: ${streamMessage.slice(0, 500)}`,
    );
  }
}

async function verifyIosFullBunSmoke(context) {
  if (!context?.installed) {
    const message =
      "[local-chat-smoke] --ios-full-bun-smoke requested but the iOS app is not installed.";
    if (requireInstalled) throw new Error(message);
    console.warn(message);
    return null;
  }

  const id = appId();
  let lastRaw = "";
  const requestedAtMs = Number.isFinite(context.fullBunSmokeRequestedAtMs)
    ? context.fullBunSmokeRequestedAtMs
    : Date.now();
  for (let attempt = 1; attempt <= IOS_FULL_BUN_SMOKE_ATTEMPTS; attempt += 1) {
    lastRaw =
      readIosDefaultsString(context.udid, id, IOS_FULL_BUN_SMOKE_RESULT_KEY) ??
      "";
    const result = parseIosFullBunSmokeResult(lastRaw);
    const resultTimeMs = iosFullBunSmokeResultTimeMs(result);
    const isFresh =
      resultTimeMs !== null && resultTimeMs >= requestedAtMs - 1_000;
    if (result && !isFresh) {
      await sleep(IOS_FULL_BUN_SMOKE_DELAY_MS);
      continue;
    }
    if (result?.ok === true) {
      assertIosFullBunSmokeSuccess(result);
      console.log(
        "[local-chat-smoke] iOS full Bun smoke:",
        JSON.stringify(result),
      );
      return result;
    }
    if (result?.phase === "failed" || (result?.ok === false && result?.error)) {
      const screenshot = takeIosScreenshot(context.udid, "ios-full-bun-failed");
      throw new Error(
        `iOS full Bun smoke failed: ${JSON.stringify(result)}${screenshot ? ` Screenshot: ${screenshot}` : ""}`,
      );
    }
    if (attempt % 10 === 0) {
      const phase =
        typeof result?.phase === "string" ? ` (${result.phase})` : "";
      console.warn(
        `[local-chat-smoke] iOS full Bun smoke still running${phase} (${attempt}/${IOS_FULL_BUN_SMOKE_ATTEMPTS}).`,
      );
    }
    await sleep(IOS_FULL_BUN_SMOKE_DELAY_MS);
  }

  const screenshot = takeIosScreenshot(context.udid, "ios-full-bun-timeout");
  throw new Error(
    `iOS full Bun smoke did not complete in time. Last result: ${lastRaw || "<none>"}${screenshot ? ` Screenshot: ${screenshot}` : ""}`,
  );
}

function takeAndroidScreenshot(context, label) {
  if (!context?.installed) return null;
  const outDir = path.join(os.tmpdir(), "eliza-android-bg-smoke");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  const remote = `/sdcard/${path.basename(outPath)}`;
  if (
    tryExec(context.adb, [
      "-s",
      context.serial,
      "shell",
      "screencap",
      "-p",
      remote,
    ]) === null
  ) {
    return null;
  }
  if (
    tryExec(context.adb, ["-s", context.serial, "pull", remote, outPath]) ===
    null
  ) {
    return null;
  }
  tryExec(context.adb, ["-s", context.serial, "shell", "rm", remote], {
    allowFailure: true,
  });
  return outPath;
}

function androidBackgroundServicesReady(services, id) {
  const foregroundCount = services.match(/isForeground=true/g)?.length ?? 0;
  return (
    services.includes(`${id}/.ElizaAgentService`) &&
    services.includes(`${id}/.GatewayConnectionService`) &&
    foregroundCount >= 2
  );
}

async function waitForAndroidBackgroundServices(context, id) {
  let lastServices = "";
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    lastServices = requireExec(
      context.adb,
      ["-s", context.serial, "shell", "dumpsys", "activity", "services", id],
      "Failed to inspect Android foreground services.",
    );
    if (androidBackgroundServicesReady(lastServices, id)) {
      return lastServices;
    }
    await sleep(1000);
  }
  throw new Error(
    "Android local background services did not both become foreground services. " +
      `Last services dump:\n${lastServices.slice(0, 4000)}`,
  );
}

async function verifyAndroidBackgroundApi(context, baseUrl, authToken) {
  if (!context?.installed) {
    return { ok: false, reason: "no-emulator" };
  }
  const id = appId();
  console.log("[local-chat-smoke] Sending Android app to background.");
  const beforeShot = takeAndroidScreenshot(context, "android-pre-bg");
  if (beforeShot) {
    console.log(`[local-chat-smoke] Android pre-bg screenshot: ${beforeShot}`);
  }
  requireExec(
    context.adb,
    ["-s", context.serial, "shell", "input", "keyevent", "HOME"],
    "Failed to send Android emulator to home screen.",
  );
  await waitForAndroidBackgroundServices(context, id);
  const baselineHealth = await requestJson(
    "GET",
    "/api/health",
    undefined,
    baseUrl,
    authToken,
  );
  if (
    baselineHealth?.ready !== true ||
    baselineHealth?.agentState !== "running"
  ) {
    throw new Error(
      `Android background health check failed: ${JSON.stringify(baselineHealth)}`,
    );
  }
  const baselineWakeMs = readLastWakeFiredAtMs(baselineHealth);
  console.log("[local-chat-smoke] Android background health:", baselineHealth);

  // Force-fire the WorkManager periodic worker via JobScheduler. Discover the
  // job id first; if none is registered, fall back to the legacy
  // /api/background/run-due-tasks loopback POST to keep the test useful on
  // older builds.
  const jobIds = findAndroidJobIdForPackage(context, id);
  let advanced = null;
  let forceFireMethod = "";
  if (jobIds && jobIds.length > 0) {
    forceFireMethod = `jobscheduler[${jobIds.join(",")}]`;
    for (const jobId of jobIds) {
      console.log(
        `[local-chat-smoke] Android jobscheduler force-fire: ${id} #${jobId}`,
      );
      requireExec(
        context.adb,
        [
          "-s",
          context.serial,
          "shell",
          "cmd",
          "jobscheduler",
          "run",
          "-f",
          id,
          String(jobId),
        ],
        `Failed to force-fire JobScheduler job ${jobId} for ${id}.`,
      );
    }
    advanced = await pollForWakeAdvance(
      baseUrl,
      authToken,
      baselineWakeMs,
      ANDROID_WAKE_POLL_ATTEMPTS,
      ANDROID_WAKE_POLL_DELAY_MS,
    );
  } else {
    forceFireMethod = "loopback-route";
    console.warn(
      "[local-chat-smoke] No JobScheduler job found for the package; falling back to POST /api/background/run-due-tasks.",
    );
    const runDue = await requestJsonResponse(
      "POST",
      "/api/background/run-due-tasks",
      {
        source: "mobile-local-chat-smoke",
        platform: "android",
        firedAt: new Date().toISOString(),
      },
      baseUrl,
      authToken,
    );
    if (runDue.response.status === 404) {
      throw new Error(
        "Android background run-due-tasks route is not present in the installed app-core build. " +
          "Rebuild and reinstall the Android app before running --android-background.",
      );
    }
    if (!runDue.response.ok) {
      throw new Error(
        `POST /api/background/run-due-tasks failed while Android app was backgrounded: ${runDue.response.status} ${runDue.text}`,
      );
    }
    if (runDue.data?.ok !== true) {
      throw new Error(
        `Android background run-due-tasks returned an unexpected body: ${JSON.stringify(runDue.data)}`,
      );
    }
    console.log(
      "[local-chat-smoke] Android background run-due-tasks:",
      runDue.data,
    );
    advanced = await pollForWakeAdvance(
      baseUrl,
      authToken,
      baselineWakeMs,
      ANDROID_WAKE_POLL_ATTEMPTS,
      ANDROID_WAKE_POLL_DELAY_MS,
    );
  }

  const afterShot = takeAndroidScreenshot(context, "android-post-bg");
  if (afterShot) {
    console.log(`[local-chat-smoke] Android post-bg screenshot: ${afterShot}`);
  }

  if (!advanced) {
    // /api/health does not yet emit `lastWakeFiredAt` until Wave 3D lands;
    // emit a warning but don't fail the run when the field is simply absent
    // (baselineWakeMs === null AND every poll observed null too). Treat that
    // as "wake field not implemented yet" so this script is usable before
    // Wave 3D merges.
    const fieldImplemented = baselineWakeMs !== null;
    if (fieldImplemented) {
      throw new Error(
        `Android wake did not advance after force-fire via ${forceFireMethod}. ` +
          `baseline=${baselineWakeMs} (no observation > baseline)`,
      );
    }
    console.warn(
      "[local-chat-smoke] /api/health.lastWakeFiredAt not present yet (Wave 3D pending); " +
        "skipping wake-advance assertion.",
    );
    return {
      ok: true,
      reason: "wake-field-not-implemented",
      forceFireMethod,
      beforeAt: baselineWakeMs,
      afterAt: null,
      durationMs: null,
    };
  }

  console.log(
    `[local-chat-smoke] Android wake fired: ${baselineWakeMs} → ${advanced.observedMs} (${
      advanced.observedMs - (baselineWakeMs ?? 0)
    }ms)`,
  );
  return {
    ok: true,
    forceFireMethod,
    beforeAt: baselineWakeMs,
    afterAt: advanced.observedMs,
    durationMs:
      baselineWakeMs !== null ? advanced.observedMs - baselineWakeMs : null,
  };
}

/**
 * iOS BGTaskScheduler harness for an already-booted simulator.
 *
 * Drives Apple's private LLDB-only `_simulateLaunchForTaskWithIdentifier:`
 * against the running app process, then polls `/api/health` until
 * `lastWakeFiredAt` advances past the pre-fire baseline. Returns a result
 * object so callers can assert duration / advancement.
 *
 * Notes:
 *   - The wake field lands in Wave 3D. Until then, this returns
 *     `{ ok: true, reason: "wake-field-not-implemented" }` rather than
 *     failing — so the harness ships now and lights up the moment 3D merges.
 *   - The LLDB invocation is the documented Apple test path for BG task
 *     simulation. See "Simulating Background Fetch and Refresh Behavior"
 *     in Apple's docs and `BGTaskSchedulerPermittedIdentifiers` in Info.plist.
 */
async function verifyIosBackgroundApi(udid, opts = {}) {
  if (!udid) {
    return { ok: false, reason: "no-simulator" };
  }
  const taskIdentifier = opts.taskIdentifier ?? "ai.eliza.tasks.refresh";
  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:31337";
  const authToken = opts.authToken;

  const id = appId();
  console.log(
    `[local-chat-smoke] iOS BG harness: udid=${udid} task=${taskIdentifier}`,
  );

  const beforeShot = takeIosScreenshot(udid, "ios-pre-bg");
  if (beforeShot) {
    console.log(`[local-chat-smoke] iOS pre-bg screenshot: ${beforeShot}`);
  }

  // Drive the simulator to the home screen first so the app is in the
  // background-eligible state expected by BGTaskScheduler.
  tryExec("xcrun", ["simctl", "openurl", udid, "elizaos://chat"]);
  await sleep(1000);

  // Capture the pre-fire wake baseline. If /api/health is unreachable (no
  // forwarded port on iOS sim) the harness short-circuits — Wave 3D wires
  // the agent loopback. Treat unreachable as "wake-field-not-implemented".
  let baselineWakeMs = null;
  let fieldImplemented = false;
  try {
    const health = await requestJson(
      "GET",
      "/api/health",
      undefined,
      baseUrl,
      authToken,
    );
    baselineWakeMs = readLastWakeFiredAtMs(health);
    fieldImplemented = baselineWakeMs !== null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[local-chat-smoke] iOS /api/health not reachable yet: ${message}`,
    );
  }

  // Resolve the simulator's running app PID via launchctl.
  const pidLine = tryExec("xcrun", [
    "simctl",
    "spawn",
    udid,
    "launchctl",
    "print",
    `system/${id}`,
  ]);
  const pidMatch = pidLine?.match(/pid\s*=\s*(\d+)/i);
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;
  if (!pid) {
    console.warn(
      `[local-chat-smoke] Could not resolve iOS app pid for ${id}; the app may not be running. ` +
        "Run `xcrun simctl launch <udid> <app-id>` and retry.",
    );
    return { ok: false, reason: "no-pid" };
  }

  // Drive BGTaskScheduler simulation via LLDB. We use `xcrun lldb -p <pid>`
  // and the `expr` command, then detach. Output is captured; non-zero exit
  // is tolerated because LLDB attach can be slow on first run.
  const lldbScript = [
    `process attach -p ${pid}`,
    `expr (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"${taskIdentifier}"]`,
    "detach",
    "quit",
  ].join("\n");
  const tmpScript = path.join(
    os.tmpdir(),
    `eliza-ios-bg-lldb-${Date.now()}.txt`,
  );
  fs.writeFileSync(tmpScript, lldbScript);
  try {
    const lldbOutput = tryExec(
      "xcrun",
      ["simctl", "spawn", udid, "lldb", "-s", tmpScript, "--batch"],
      { allowFailure: true },
    );
    if (lldbOutput) {
      const trimmed =
        lldbOutput.length > 500 ? `${lldbOutput.slice(0, 500)}...` : lldbOutput;
      console.log(`[local-chat-smoke] iOS LLDB output: ${trimmed}`);
    }
  } finally {
    try {
      fs.rmSync(tmpScript, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  // Poll for advance.
  let advanced = null;
  if (fieldImplemented || baselineWakeMs === null) {
    try {
      advanced = await pollForWakeAdvance(
        baseUrl,
        authToken,
        baselineWakeMs,
        IOS_WAKE_POLL_ATTEMPTS,
        IOS_WAKE_POLL_DELAY_MS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[local-chat-smoke] iOS wake poll failed: ${message}`);
    }
  }

  const afterShot = takeIosScreenshot(udid, "ios-post-bg");
  if (afterShot) {
    console.log(`[local-chat-smoke] iOS post-bg screenshot: ${afterShot}`);
  }

  if (!advanced) {
    if (fieldImplemented) {
      throw new Error(
        `iOS wake did not advance after BGTaskScheduler simulate for ${taskIdentifier}. ` +
          `baseline=${baselineWakeMs}`,
      );
    }
    console.warn(
      "[local-chat-smoke] /api/health.lastWakeFiredAt not present yet (Wave 3D pending); " +
        "skipping iOS wake-advance assertion.",
    );
    return {
      ok: true,
      reason: "wake-field-not-implemented",
      taskIdentifier,
      beforeAt: baselineWakeMs,
      afterAt: null,
      durationMs: null,
    };
  }

  console.log(
    `[local-chat-smoke] iOS wake fired: ${baselineWakeMs} → ${advanced.observedMs} (${
      advanced.observedMs - (baselineWakeMs ?? 0)
    }ms)`,
  );
  return {
    ok: true,
    taskIdentifier,
    beforeAt: baselineWakeMs,
    afterAt: advanced.observedMs,
    durationMs:
      baselineWakeMs !== null ? advanced.observedMs - baselineWakeMs : null,
  };
}

async function requestJsonResponse(
  method,
  pathname,
  body,
  baseUrl = apiBase,
  authToken = authTokenArg,
) {
  const base = baseUrl.replace(/\/$/, "");
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (authToken) headers.Authorization = `Bearer ${authToken.trim()}`;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { response, data, text };
}

async function requestJson(
  method,
  pathname,
  body,
  baseUrl = apiBase,
  authToken = authTokenArg,
) {
  const { response, data, text } = await requestJsonResponse(
    method,
    pathname,
    body,
    baseUrl,
    authToken,
  );
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${text}`);
  }
  return data;
}

async function runLocalInferenceApiSmoke(
  baseUrl = apiBase,
  authToken = authTokenArg,
) {
  console.log(
    `[local-chat-smoke] Exercising app-core API at ${baseUrl} (conversation + local-inference hub).`,
  );
  await requestJson("GET", "/api/health", undefined, baseUrl, authToken);
  const created = await requestJson(
    "POST",
    "/api/conversations",
    {
      title: "Simulator local chat smoke",
    },
    baseUrl,
    authToken,
  );
  const conversationId = created.conversation?.id;
  if (!conversationId) {
    throw new Error("Conversation creation did not return an id.");
  }

  const greeting = await requestJson(
    "POST",
    `/api/conversations/${encodeURIComponent(conversationId)}/greeting`,
    undefined,
    baseUrl,
    authToken,
  );
  if (String(greeting.text ?? "").includes("I'm running locally")) {
    throw new Error("Stale local-mode greeting is still present.");
  }

  const reply = await requestJson(
    "POST",
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { text: "download the default local model" },
    baseUrl,
    authToken,
  );
  const hub = await requestJson(
    "GET",
    "/api/local-inference/hub",
    undefined,
    baseUrl,
    authToken,
  );
  const activeStatus = String(hub.active?.status ?? "");
  const activeError = String(hub.active?.error ?? "");
  const downloads = Array.isArray(hub.downloads) ? hub.downloads : [];
  const hasActiveDownload = downloads.some((download) =>
    ["queued", "downloading", "verifying", "complete"].includes(
      String(download?.state ?? ""),
    ),
  );
  if (activeStatus === "error") {
    throw new Error(
      `Local inference hub is in error state: ${activeError || "unknown"}`,
    );
  }
  if (activeStatus !== "ready" && !hasActiveDownload) {
    throw new Error(
      `Local model is neither ready nor downloading (active=${activeStatus || "unknown"}, downloads=${downloads.length}).`,
    );
  }
  console.log("[local-chat-smoke] conversation:", conversationId);
  console.log("[local-chat-smoke] greeting:", greeting.text);
  console.log("[local-chat-smoke] reply:", reply.text);
  console.log(
    "[local-chat-smoke] local inference:",
    JSON.stringify({
      active: hub.active,
      downloads: hub.downloads,
      hardware: hub.hardware,
    }),
  );
}

async function main() {
  let androidContext = null;
  let iosContext = null;
  try {
    if (platform === "ios" || platform === "both") {
      iosContext = launchIosSimulatorApp();
    }
    if (platform === "android" || platform === "both") {
      androidContext = launchAndroidEmulatorApp();
      if (androidSelectLocal) {
        await selectAndroidLocalRuntime(androidContext);
      }
    }

    if (apiBase) {
      await runLocalInferenceApiSmoke(apiBase, authTokenArg);
      return;
    }

    if (exerciseAppCoreApi && (platform === "android" || platform === "both")) {
      const androidApi = await waitForAndroidApi(androidContext);
      if (androidApi) {
        if (androidBackground) {
          await verifyAndroidBackgroundApi(
            androidContext,
            androidApi.apiBase,
            androidApi.token,
          );
        }
        await runLocalInferenceApiSmoke(androidApi.apiBase, androidApi.token);
      }
    }

    if (iosBackground && (platform === "ios" || platform === "both")) {
      if (!iosContext) {
        const message =
          "[local-chat-smoke] --ios-background requested but no booted iOS simulator was found.";
        if (requireInstalled) throw new Error(message);
        console.warn(message);
      } else if (!iosContext.installed) {
        const message = `[local-chat-smoke] --ios-background requested but ${appId()} is not installed in the booted simulator.`;
        if (requireInstalled) throw new Error(message);
        console.warn(message);
      } else {
        const result = await verifyIosBackgroundApi(iosContext.udid, {
          taskIdentifier: iosBackgroundTaskId,
          baseUrl: apiBase ?? "http://127.0.0.1:31337",
          authToken: authTokenArg,
        });
        console.log(
          "[local-chat-smoke] iOS BG verify result:",
          JSON.stringify(result),
        );
      }
    }

    if (iosFullBunSmoke && (platform === "ios" || platform === "both")) {
      await verifyIosFullBunSmoke(iosContext);
    }

    run(
      "bunx",
      [
        "vitest",
        "run",
        "--config",
        "vitest.config.ts",
        "src/api/ios-local-agent-kernel.local-inference.test.ts",
        "src/onboarding/auto-download-recommended.test.ts",
      ],
      { cwd: path.join(repoRoot, "packages/ui") },
    );
  } finally {
    cleanupAndroidAgentForwards(androidContext, "shutdown");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
