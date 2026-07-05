#!/usr/bin/env node
/**
 * Command-line helper for the Mobile Local Chat Smoke app packaging, mobile,
 * or Playwright automation lane.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  ANDROID_FULL_TURN_FAILURE_RE,
  IOS_FULL_BUN_SMOKE_FAILURE_RE,
} from "./lib/chat-failure-strings.mjs";
import { startDeviceE2eHostAgent } from "./lib/host-agent.mjs";
import { assertInstalledIosAppRendererFresh } from "./lib/ios-renderer-stamp.mjs";
import { clearIosSmokeDefaults } from "./lib/ios-sim-defaults-hygiene.mjs";
import { evaluateLocalInferenceReadiness } from "./lib/local-inference-readiness.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const appConfigPath = path.join(repoRoot, "packages/app/app.config.ts");
const iosLocalChatResultDir = path.join(
  repoRoot,
  "packages/app/test-results/ios-local-chat",
);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const platform = argValue("--platform") ?? "ios";
let apiBase = argValue("--api-base");
const authTokenArg = argValue("--auth-token");
const startHostAgent = process.argv.includes("--start-host-agent");
const hostAgentPort = argValue("--host-agent-port");
const requireInstalled = process.argv.includes("--require-installed");
const exerciseAppCoreApi =
  process.argv.includes("--live") || Boolean(apiBase) || startHostAgent;
const iosSelectLocal = process.argv.includes("--ios-select-local");
const iosFullBunSmoke = process.argv.includes("--ios-full-bun-smoke");
const androidSelectLocal = process.argv.includes("--android-select-local");
const androidBackground = process.argv.includes("--android-background");
const androidStageSmokeModel = process.argv.includes(
  "--android-stage-smoke-model",
);
const iosBackground = process.argv.includes("--ios-background");
const iosBackgroundTaskId =
  argValue("--ios-background-task-id") ?? "ai.eliza.tasks.refresh";
const IOS_FULL_BUN_SMOKE_REQUEST_KEY = "eliza:ios-full-bun-smoke:request";
const IOS_FULL_BUN_SMOKE_RESULT_KEY = "eliza:ios-full-bun-smoke:result";
const IOS_FULL_BUN_PREWARM_RESULT_KEY = "eliza:ios-full-bun-prewarm:result";
const IOS_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";
const ANDROID_LOCAL_AGENT_IPC_BASE = IOS_LOCAL_AGENT_IPC_BASE;
const IOS_FULL_BUN_SMOKE_MODEL_ID = "eliza-1-2b";
const IOS_FULL_BUN_SMOKE_MODEL_RELATIVE_PATH =
  "models/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf";
// Cap the on-device context window. The bundled eliza-1 GGUF advertises a 128k
// max context; loading it at full width allocates a multi-GB KV cache that is
// impractically slow (and OOMs) on a phone/simulator, so the first reply never
// lands. 4096 mirrors the Android smoke and keeps model load + generation fast.
const IOS_FULL_BUN_SMOKE_CONTEXT_SIZE = Number.parseInt(
  process.env.IOS_FULL_BUN_SMOKE_CONTEXT_SIZE?.trim() || "4096",
  10,
);
const IOS_FULL_BUN_SMOKE_ATTEMPTS = 180;
const IOS_FULL_BUN_SMOKE_DELAY_MS = 2000;
const IOS_FULL_BUN_SMOKE_EXPECTED_REPLY = "ios smoke model works";
// IOS_FULL_BUN_SMOKE_FAILURE_RE / ANDROID_FULL_TURN_FAILURE_RE are derived from
// the single checked-in failure-string source of truth
// (./lib/chat-failure-strings.mjs), which also generates the Swift artifact the
// on-device XCUITest reply verifier consumes (issue #13687). A parity test keeps
// the two sides in lockstep.
const ANDROID_HEALTH_ATTEMPTS = 240;
const ANDROID_FULL_TURN_TIMEOUT_MS = Number.parseInt(
  process.env.ANDROID_FULL_TURN_TIMEOUT_MS?.trim() || String(10 * 60_000),
  10,
);
// In-process CPU-only decode on a phone is slow (~0.2 tok/s generate, observed
// ~41s end-to-end for a short reply). A single slow/blip read must not abort
// the turn, so the per-request HTTP timeout sits well above that envelope.
const ANDROID_HEALTH_PROBE_TIMEOUT_MS = Number.parseInt(
  process.env.ANDROID_HEALTH_PROBE_TIMEOUT_MS?.trim() || String(30_000),
  10,
);
// Bounded transient retry for accepted-but-empty / reset / 5xx / timeout reads
// against the forwarded local-agent API. The boot/restart window briefly
// accepts the socket and closes it with an empty body; retry rides that out.
const ANDROID_TRANSIENT_RETRY_ATTEMPTS = Number.parseInt(
  process.env.ANDROID_TRANSIENT_RETRY_ATTEMPTS?.trim() || "5",
  10,
);
const ANDROID_TRANSIENT_RETRY_DELAY_MS = Number.parseInt(
  process.env.ANDROID_TRANSIENT_RETRY_DELAY_MS?.trim() || "2000",
  10,
);
// Process-stability gate: require monotonic uptime across N consecutive
// /api/health samples (agentState==running, startup.attempt not climbing)
// before exercising, so a turn is never fired mid-restart.
const ANDROID_STABILITY_SAMPLES = Number.parseInt(
  process.env.ANDROID_STABILITY_SAMPLES?.trim() || "3",
  10,
);
const ANDROID_STABILITY_DELAY_MS = Number.parseInt(
  process.env.ANDROID_STABILITY_DELAY_MS?.trim() || "2000",
  10,
);
const ANDROID_STABILITY_ATTEMPTS = Number.parseInt(
  process.env.ANDROID_STABILITY_ATTEMPTS?.trim() || "60",
  10,
);
const ANDROID_LOCAL_INFERENCE_READY_ATTEMPTS = Number.parseInt(
  process.env.ANDROID_LOCAL_INFERENCE_READY_ATTEMPTS?.trim() || "180",
  10,
);
const ANDROID_LOCAL_INFERENCE_READY_DELAY_MS = Number.parseInt(
  process.env.ANDROID_LOCAL_INFERENCE_READY_DELAY_MS?.trim() || "2000",
  10,
);
const ANDROID_FULL_TURN_PROMPT =
  "Reply with exactly these four words: android smoke model works.";
const ANDROID_FULL_TURN_EXPECTED_REPLY = "android smoke model works";
const ANDROID_SMOKE_MODEL_CONTEXT_SIZE = Number.parseInt(
  process.env.ANDROID_SMOKE_MODEL_CONTEXT_SIZE?.trim() || "4096",
  10,
);
const ANDROID_SMOKE_MODEL_ID =
  process.env.ANDROID_SMOKE_MODEL_ID?.trim() || "eliza-1-2b";
const DEFAULT_ANDROID_SMOKE_MODEL = {
  relativePath: "bundles/e2b/text/eliza-1-e2b-32k.gguf",
  file: "eliza-1-e2b-32k.gguf",
  sizeBytes: 1_270_808_512,
};
const ANDROID_SMOKE_MODEL_RELATIVE_PATH =
  process.env.ANDROID_SMOKE_MODEL_RELATIVE_PATH?.trim() ||
  DEFAULT_ANDROID_SMOKE_MODEL.relativePath;
const ANDROID_SMOKE_MODEL_FILE =
  process.env.ANDROID_SMOKE_MODEL_FILE?.trim() ||
  DEFAULT_ANDROID_SMOKE_MODEL.file;
const androidSmokeModelSizeOverride =
  process.env.ANDROID_SMOKE_MODEL_SIZE_BYTES?.trim();
const ANDROID_SMOKE_MODEL_SIZE_BYTES = androidSmokeModelSizeOverride
  ? Number.parseInt(androidSmokeModelSizeOverride, 10)
  : ANDROID_SMOKE_MODEL_RELATIVE_PATH ===
        DEFAULT_ANDROID_SMOKE_MODEL.relativePath &&
      ANDROID_SMOKE_MODEL_FILE === DEFAULT_ANDROID_SMOKE_MODEL.file
    ? DEFAULT_ANDROID_SMOKE_MODEL.sizeBytes
    : Number.NaN;
const ANDROID_SMOKE_MODEL_SHA256 =
  process.env.ANDROID_SMOKE_MODEL_SHA256?.trim() || "";
const ANDROID_SMOKE_MODEL_URL =
  process.env.ANDROID_SMOKE_MODEL_URL?.trim() ||
  `https://huggingface.co/elizaos/eliza-1/resolve/main/${ANDROID_SMOKE_MODEL_RELATIVE_PATH.split(
    "/",
  )
    .map((segment) => encodeURIComponent(segment))
    .join("/")}?download=true`;
const IOS_WAKE_POLL_ATTEMPTS = 30;
const IOS_WAKE_POLL_DELAY_MS = 1000;
const ANDROID_WAKE_POLL_ATTEMPTS = 30;
const ANDROID_WAKE_POLL_DELAY_MS = 1000;
const ANDROID_CONFLICTING_AGENT_PACKAGES = [
  "ai.eliza.eliza",
  "ai.elizaos.eliza",
];
const IOS_SMOKE_STATE_KEYS = [
  IOS_FULL_BUN_SMOKE_REQUEST_KEY,
  IOS_FULL_BUN_SMOKE_RESULT_KEY,
  IOS_FULL_BUN_PREWARM_RESULT_KEY,
  "eliza:ios-background:request",
  "eliza:ios-background:result",
  "elizaos:active-server",
  "eliza:first-run-complete",
  "eliza:mobile-runtime-mode",
];

function printHelp() {
  console.log(`Usage: node packages/app/scripts/mobile-local-chat-smoke.mjs [options]

Options:
  --platform ios|android|both       Simulator platform to launch (default: ios)
  --require-installed              Fail when the selected app/simulator is unavailable
  --live                           Exercise the app-core local-agent HTTP API on Android
  --api-base URL                   Exercise an already-reachable app-core HTTP API
  --start-host-agent               Start the deterministic host app-core API when --api-base is omitted
  --host-agent-port PORT           Port for --start-host-agent (default: 31338, or a free port if busy)
  --auth-token TOKEN               Bearer token for protected app-core API routes
  --ios-select-local               Pre-seed iOS first-run/runtime state for Local mode before launch
  --ios-full-bun-smoke             Run a WebView-executed full Bun backend smoke in the iOS app
  --android-select-local           Tap through Android first-run Local runtime selection
  --android-stage-smoke-model      Stage the smallest active Eliza-1 GGUF into Android app data
  --android-background             Background Android, force-fire the WorkManager job, and poll /api/health
  --ios-background                 Background iOS, fire a BGTaskScheduler task via LLDB, and poll /api/health
  --ios-background-task-id ID      iOS BGTask identifier to simulate (default: ai.eliza.tasks.refresh)
  --help                           Print this help

Notes:
  --live validates the running app-core/local-agent API. It is not a remote
  service test. The chat step requires local-inference readiness and a completed
  streamed model reply from the local Android agent.
  ANDROID_SERIAL selects a specific Android device or emulator when set.`);
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
  // White-label builds install under a different bundle id than the eliza
  // package config. Allow targeting the installed app explicitly so the smoke can
  // validate whichever shell was actually built.
  if (process.env.ELIZA_SMOKE_APP_ID) return process.env.ELIZA_SMOKE_APP_ID;
  const config = fs.readFileSync(appConfigPath, "utf8");
  return config.match(/appId:\s*["']([^"']+)["']/)?.[1] ?? "app.eliza";
}

function androidSdkRoot() {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;
  if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT;
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library/Android/sdk");
  }
  if (process.platform === "win32") {
    return path.join(home, "AppData/Local/Android/Sdk");
  }
  return path.join(home, "Android/Sdk");
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
  clearIosSmokeDefaults({
    udid,
    bundleId: id,
    extraKeys: IOS_SMOKE_STATE_KEYS,
    log: (message) => console.log(`[local-chat-smoke] ${message}`),
  });
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
    stageIosFullBunSmokeModel(udid, id);
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

/**
 * Assert the renderer baked into the INSTALLED app bundle is the freshly built
 * one — the on-device proof that the simulator is running the latest UI, not
 * stale code (issue #9309). Reads the build stamp Capacitor copied into the
 * .app (`<App.app>/public/eliza-renderer-build.json`) and compares its buildId
 * to the freshly built `packages/app/dist` manifest. Skips gracefully when
 * either manifest is absent (e.g. a build without the manifest plugin); throws
 * only on a genuine stale-UI mismatch.
 */
function assertInstalledIosRendererIsFresh(udid) {
  assertInstalledIosAppRendererFresh({
    udid,
    bundleId: appId(),
    repoRoot,
    log: (message) => console.log(`[local-chat-smoke] ${message}`),
  });
}
function writeIosDefaultsString(udid, domain, key, value) {
  const nativeKey = `CapacitorStorage.${key}`;
  const dataContainer = tryExec(
    "xcrun",
    ["simctl", "get_app_container", udid, domain, "data"],
    { allowFailure: true },
  );
  if (dataContainer) {
    const prefsDomain = path.join(
      dataContainer,
      "Library",
      "Preferences",
      domain,
    );
    fs.mkdirSync(path.dirname(prefsDomain), { recursive: true });
    requireExec(
      "defaults",
      ["write", prefsDomain, nativeKey, "-string", value],
      `Failed to write iOS preference ${key}.`,
    );
    return;
  }

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
  const dataContainer = tryExec(
    "xcrun",
    ["simctl", "get_app_container", udid, domain, "data"],
    { allowFailure: true },
  );
  if (dataContainer) {
    const prefsDomain = path.join(
      dataContainer,
      "Library",
      "Preferences",
      domain,
    );
    tryExec("defaults", ["delete", prefsDomain, `CapacitorStorage.${key}`], {
      allowFailure: true,
    });
    return;
  }

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

function iosAppDataContainer(udid, id) {
  return requireExec(
    "xcrun",
    ["simctl", "get_app_container", udid, id, "data"],
    `Failed to resolve iOS data container for ${id}.`,
  );
}

function iosAppSupportContainer(udid, id) {
  return path.join(
    iosAppDataContainer(udid, id),
    "Library",
    "Application Support",
    "Eliza",
  );
}

function copyFileIfChanged(source, destination) {
  const sourceStats = fs.statSync(source);
  try {
    const destinationStats = fs.statSync(destination);
    if (
      destinationStats.isFile() &&
      destinationStats.size === sourceStats.size &&
      Math.floor(destinationStats.mtimeMs) >= Math.floor(sourceStats.mtimeMs)
    ) {
      return false;
    }
  } catch {
    // Copy below.
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.utimesSync(destination, sourceStats.atime, sourceStats.mtime);
  return true;
}

function stageIosFullBunSmokeModel(udid, id) {
  const source =
    process.env.ELIZA_IOS_FULL_BUN_SMOKE_MODEL_PATH ??
    path.join(
      os.homedir(),
      ".eliza",
      "local-inference",
      IOS_FULL_BUN_SMOKE_MODEL_RELATIVE_PATH,
    );
  if (!fs.existsSync(source)) {
    throw new Error(
      `iOS full-Bun smoke model is missing: ${source}. Set ELIZA_IOS_FULL_BUN_SMOKE_MODEL_PATH to an Eliza-1 GGUF file.`,
    );
  }
  const sourceStats = fs.statSync(source);
  if (!sourceStats.isFile()) {
    throw new Error(`iOS full-Bun smoke model is not a file: ${source}`);
  }

  const localInferenceRoot = path.join(
    iosAppSupportContainer(udid, id),
    "local-inference",
  );
  const modelPath = path.join(
    localInferenceRoot,
    IOS_FULL_BUN_SMOKE_MODEL_RELATIVE_PATH,
  );
  const copied = copyFileIfChanged(source, modelPath);
  const now = new Date().toISOString();
  const registry = {
    models: [
      {
        id: IOS_FULL_BUN_SMOKE_MODEL_ID,
        displayName: "eliza-1-2B",
        path: modelPath,
        sizeBytes: sourceStats.size,
        installedAt: now,
        lastUsedAt: now,
        source: "ios-full-bun-smoke",
        bundleVerifiedAt: now,
        contextSize: IOS_FULL_BUN_SMOKE_CONTEXT_SIZE,
      },
    ],
  };
  const assignments = {
    assignments: Object.fromEntries(
      [
        "TEXT_NANO",
        "TEXT_SMALL",
        "TEXT_MEDIUM",
        "TEXT_LARGE",
        "RESPONSE_HANDLER",
        "ACTION_PLANNER",
        "TEXT_COMPLETION",
      ].map((slot) => [slot, IOS_FULL_BUN_SMOKE_MODEL_ID]),
    ),
  };
  fs.mkdirSync(localInferenceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(localInferenceRoot, "registry.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(localInferenceRoot, "assignments.json"),
    `${JSON.stringify(assignments, null, 2)}\n`,
  );
  console.log(
    `[local-chat-smoke] ${copied ? "Staged" : "Reused"} iOS full-Bun smoke model ${IOS_FULL_BUN_SMOKE_MODEL_ID}: ${modelPath}`,
  );
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
  writeIosDefaultsString(udid, id, "eliza:first-run-complete", "1");
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
  const connected = devices
    .split("\n")
    .slice(1)
    .map((entry) => entry.trim())
    .filter((entry) => entry.endsWith("\tdevice"))
    .map((entry) => entry.split(/\s+/)[0]);
  const requested = process.env.ANDROID_SERIAL?.trim();
  if (requested) {
    if (connected.includes(requested)) return requested;
    const state = tryExec(adb, ["-s", requested, "get-state"], {
      allowFailure: true,
    });
    if (state === "device") return requested;
    if (requireInstalled) {
      throw new Error(
        `ANDROID_SERIAL=${requested} is not an attached Android device/emulator.`,
      );
    }
  }
  return (
    connected.find((serial) => serial.startsWith("emulator-")) ??
    connected[0] ??
    null
  );
}

async function launchAndroidEmulatorApp() {
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

  const context = { adb, serial, installed: true };
  if (androidSelectLocal) {
    forceStopConflictingAndroidAgents(context);
    preseedAndroidLocalRuntime(context);
  }
  if (androidStageSmokeModel) {
    await stageAndroidSmokeModel(context);
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
  return context;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function writeAndroidCapacitorPreferences(context, entries) {
  const xml = [
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
    "<map>",
    ...Object.entries(entries).map(
      ([key, value]) =>
        `    <string name="${xmlEscape(key)}">${xmlEscape(value)}</string>`,
    ),
    "</map>",
    "",
  ].join("\n");
  const encoded = Buffer.from(xml, "utf8").toString("base64");
  const script = [
    "mkdir -p shared_prefs",
    `(printf %s ${encoded} | base64 -d > shared_prefs/CapacitorStorage.xml) || (printf %s ${encoded} | toybox base64 -d > shared_prefs/CapacitorStorage.xml)`,
    "chmod 660 shared_prefs/CapacitorStorage.xml",
  ].join(" && ");
  requireExec(
    context.adb,
    [
      "-s",
      context.serial,
      "shell",
      `run-as ${shellQuote(appId())} sh -c ${shellQuote(script)}`,
    ],
    "Failed to pre-seed Android Capacitor Preferences.",
  );
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function verifySmokeModelFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (Number.isFinite(ANDROID_SMOKE_MODEL_SIZE_BYTES)) {
    if (stat.size !== ANDROID_SMOKE_MODEL_SIZE_BYTES) return false;
  }
  if (ANDROID_SMOKE_MODEL_SHA256) {
    const actual = await sha256File(filePath);
    if (actual !== ANDROID_SMOKE_MODEL_SHA256) return false;
  }
  return true;
}

function describeAndroidSmokeModelSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes)) return "unknown size";
  return `${sizeBytes} bytes`;
}

async function ensureAndroidSmokeModelLocalFile() {
  const explicit = process.env.ANDROID_SMOKE_MODEL_PATH?.trim();
  if (explicit) {
    if (!(await verifySmokeModelFile(explicit))) {
      throw new Error(
        `ANDROID_SMOKE_MODEL_PATH did not match expected size/hash: ${explicit}`,
      );
    }
    return explicit;
  }

  const cacheDir =
    process.env.ANDROID_SMOKE_MODEL_CACHE_DIR?.trim() ||
    path.join(os.homedir(), ".cache", "eliza", "android-smoke-models");
  fs.mkdirSync(cacheDir, { recursive: true });
  const finalPath = path.join(cacheDir, ANDROID_SMOKE_MODEL_FILE);
  if (await verifySmokeModelFile(finalPath)) return finalPath;

  const stagingPath = `${finalPath}.part`;
  try {
    fs.unlinkSync(stagingPath);
  } catch {
    // stale partial is fine
  }
  console.log(
    `[local-chat-smoke] Downloading Android smoke model ${ANDROID_SMOKE_MODEL_ID} from ${ANDROID_SMOKE_MODEL_URL}.`,
  );
  const response = await fetch(ANDROID_SMOKE_MODEL_URL, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download ${ANDROID_SMOKE_MODEL_ID}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(stagingPath),
  );
  if (!(await verifySmokeModelFile(stagingPath))) {
    try {
      fs.unlinkSync(stagingPath);
    } catch {
      // best effort
    }
    throw new Error(
      `Downloaded Android smoke model failed size/hash verification: ${stagingPath}`,
    );
  }
  fs.renameSync(stagingPath, finalPath);
  return finalPath;
}

function androidRunAs(context, script, label, options = {}) {
  const output = tryExec(
    context.adb,
    [
      "-s",
      context.serial,
      "shell",
      `run-as ${shellQuote(appId())} sh -c ${shellQuote(script)}`,
    ],
    options.allowFailure ? { allowFailure: true } : undefined,
  );
  if (output === null && !options.allowFailure) {
    throw new Error(label);
  }
  return output;
}

async function stageAndroidSmokeModel(context) {
  const localInferenceDir = "files/.eliza/local-inference";
  const targetDir = `${localInferenceDir}/models`;
  const targetFile = `${targetDir}/${ANDROID_SMOKE_MODEL_FILE}`;
  const existingBytes = androidRunAs(
    context,
    `test -f ${shellQuote(targetFile)} && wc -c < ${shellQuote(targetFile)}`,
    "Failed to inspect Android smoke model.",
    { allowFailure: true },
  );
  const expectedSize = Number.isFinite(ANDROID_SMOKE_MODEL_SIZE_BYTES)
    ? String(ANDROID_SMOKE_MODEL_SIZE_BYTES)
    : null;
  if (
    expectedSize
      ? existingBytes?.trim() === expectedSize
      : Boolean(existingBytes?.trim())
  ) {
    writeAndroidSmokeModelManifest(context, targetDir);
    writeAndroidLocalInferenceRegistry(context, localInferenceDir);
    console.log(
      `[local-chat-smoke] Reused staged Android smoke model ${ANDROID_SMOKE_MODEL_ID} (${existingBytes.trim()} bytes): ${targetFile}`,
    );
    return;
  }

  const source = await ensureAndroidSmokeModelLocalFile();
  const sourceSize = fs.statSync(source).size;
  const tmpTarget = `/data/local/tmp/${ANDROID_SMOKE_MODEL_FILE}`;
  requireExec(
    context.adb,
    ["-s", context.serial, "push", source, tmpTarget],
    "Failed to push Android smoke model.",
  );
  tryExec(
    context.adb,
    ["-s", context.serial, "shell", "chmod", "0644", tmpTarget],
    {
      allowFailure: true,
    },
  );
  const copyScript = [
    `mkdir -p ${shellQuote(targetDir)}`,
    `cp ${shellQuote(tmpTarget)} ${shellQuote(targetFile)}`,
    `chmod 600 ${shellQuote(targetFile)}`,
  ].join(" && ");
  androidRunAs(context, copyScript, "Failed to stage Android smoke model.");
  writeAndroidSmokeModelManifest(context, targetDir);
  writeAndroidLocalInferenceRegistry(context, localInferenceDir);
  tryExec(context.adb, ["-s", context.serial, "shell", "rm", "-f", tmpTarget], {
    allowFailure: true,
  });
  console.log(
    `[local-chat-smoke] Staged Android smoke model ${ANDROID_SMOKE_MODEL_ID} (${describeAndroidSmokeModelSize(sourceSize)}): ${targetFile}`,
  );
}

function writeAndroidJsonFile(context, targetDir, fileName, value, label) {
  const encoded = Buffer.from(
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  ).toString("base64");
  const target = `${targetDir}/${fileName}`;
  const script = [
    `mkdir -p ${shellQuote(targetDir)}`,
    `(printf %s ${encoded} | base64 -d > ${shellQuote(target)}) || (printf %s ${encoded} | toybox base64 -d > ${shellQuote(target)})`,
    `chmod 600 ${shellQuote(target)}`,
  ].join(" && ");
  androidRunAs(context, script, label);
}

function writeAndroidSmokeModelManifest(context, targetDir) {
  writeAndroidJsonFile(
    context,
    targetDir,
    "manifest.json",
    {
      models: [
        {
          id: ANDROID_SMOKE_MODEL_ID,
          role: "chat",
          filename: ANDROID_SMOKE_MODEL_FILE,
          ggufFile: ANDROID_SMOKE_MODEL_FILE,
          sha256: ANDROID_SMOKE_MODEL_SHA256,
          sizeBytes: ANDROID_SMOKE_MODEL_SIZE_BYTES,
          contextSize: ANDROID_SMOKE_MODEL_CONTEXT_SIZE,
          useGpu: false,
          maxThreads: 2,
        },
      ],
    },
    "Failed to write Android smoke model manifest.",
  );
}

/**
 * Stage the eliza-local-inference provider's registry.json + assignments.json
 * into files/.eliza/local-inference/, mirroring the iOS staging block. The
 * registry uses the ABSOLUTE on-device model path so the provider reports the
 * model installed; assignments map the chat/completion slots to the model id so
 * the provider's slots resolve. Today the staging only writes manifest.json,
 * which the eliza-local-inference provider does not read for installed/slots.
 */
function writeAndroidLocalInferenceRegistry(context, localInferenceDir) {
  // `localInferenceDir` already starts with `files/` (it is run-as-home
  // relative), so the on-device absolute path is the app home + that dir — do
  // NOT prepend another `files/` (that produced a dead `files/files/...` path
  // whose fs.stat failed, so the provider reported "No Eliza-1 bundle installed").
  const absoluteModelPath = `/data/data/${appId()}/${localInferenceDir}/models/${ANDROID_SMOKE_MODEL_FILE}`;
  const now = new Date().toISOString();
  writeAndroidJsonFile(
    context,
    localInferenceDir,
    "registry.json",
    {
      models: [
        {
          id: ANDROID_SMOKE_MODEL_ID,
          displayName: "eliza-1-2B",
          path: absoluteModelPath,
          sizeBytes: ANDROID_SMOKE_MODEL_SIZE_BYTES,
          installedAt: now,
          lastUsedAt: now,
          source: "android-local-chat-smoke",
          bundleVerifiedAt: now,
        },
      ],
    },
    "Failed to write Android local-inference registry.",
  );
  writeAndroidJsonFile(
    context,
    localInferenceDir,
    "assignments.json",
    {
      assignments: Object.fromEntries(
        [
          "TEXT_SMALL",
          "TEXT_LARGE",
          "RESPONSE_HANDLER",
          "ACTION_PLANNER",
          "TEXT_COMPLETION",
        ].map((slot) => [slot, ANDROID_SMOKE_MODEL_ID]),
      ),
    },
    "Failed to write Android local-inference assignments.",
  );
  console.log(
    `[local-chat-smoke] Staged Android local-inference registry + assignments for ${ANDROID_SMOKE_MODEL_ID}: ${absoluteModelPath}`,
  );
}

function forceStopConflictingAndroidAgents(context) {
  const id = appId();
  for (const packageName of [id, ...ANDROID_CONFLICTING_AGENT_PACKAGES]) {
    if (!packageName || packageName === id) {
      tryExec(context.adb, [
        "-s",
        context.serial,
        "shell",
        "am",
        "force-stop",
        id,
      ]);
      continue;
    }
    tryExec(context.adb, [
      "-s",
      context.serial,
      "shell",
      "am",
      "force-stop",
      packageName,
    ]);
  }
}

function preseedAndroidLocalRuntime(context) {
  const activeServer = JSON.stringify({
    id: "local:android",
    kind: "remote",
    label: "On-device agent",
    apiBase: ANDROID_LOCAL_AGENT_IPC_BASE,
  });
  writeAndroidCapacitorPreferences(context, {
    "eliza:mobile-runtime-mode": "local",
    "eliza:first-run-complete": "1",
    "elizaos:active-server": activeServer,
  });
  console.log(
    `[local-chat-smoke] Pre-seeded Android Local runtime preferences for ${appId()}.`,
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
      `[local-chat-smoke] Removed Android harness adb forward(s) for tcp:31337 (${reason}): ${forwardedPorts.join(", ")}.`,
    );
  }
}

async function selectAndroidLocalRuntime(context) {
  if (!context?.installed) return;
  if (readAndroidLocalAgentToken(context)) return;
  console.log("[local-chat-smoke] Waiting for Android Local runtime service.");
  for (let attempt = 1; attempt <= 24; attempt += 1) {
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
          `[local-chat-smoke] Android smoke harness forwarded local-agent diagnostics to ${forwardedApiBase}; the app remains preseeded with ${ANDROID_LOCAL_AGENT_IPC_BASE}.`,
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

function normalizeSmokeReply(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
    normalizeSmokeReply(reply) !== IOS_FULL_BUN_SMOKE_EXPECTED_REPLY ||
    IOS_FULL_BUN_SMOKE_FAILURE_RE.test(reply)
  ) {
    throw new Error(
      `iOS full Bun sendMessage did not return the expected local model reply: ${JSON.stringify(sendMessage)}`,
    );
  }
  const streamMessage = String(result.streamMessage ?? "");
  if (
    !streamMessage.includes('"type":"done"') ||
    IOS_FULL_BUN_SMOKE_FAILURE_RE.test(streamMessage) ||
    !normalizeSmokeReply(streamMessage).includes(
      IOS_FULL_BUN_SMOKE_EXPECTED_REPLY,
    )
  ) {
    throw new Error(
      `iOS full Bun stream did not return the expected local model reply: ${streamMessage.slice(0, 500)}`,
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
    // /api/health omits `lastWakeFiredAt` until Wave 3D lands; emit a warning
    // but don't fail the run when the field is simply absent
    // (baselineWakeMs === null AND every poll observed null too). Treat that
    // as a missing wake field so this script is usable before Wave 3D merges.
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
      reason: "wake-field-absent",
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
 * against the running app process, then polls an explicitly supplied agent
 * route surface until `lastWakeFiredAt` advances past the pre-fire baseline.
 * iOS full-Bun/local mode must use the in-app IPC bridge; this harness no
 * longer fabricates a loopback default.
 *
 * Notes:
 *   - The wake field is required for this check. Missing or unreachable route
 *     data fails the run instead of silently passing.
 *   - The LLDB invocation is the documented Apple test path for BG task
 *     simulation. See "Simulating Background Fetch and Refresh Behavior"
 *     in Apple's docs and `BGTaskSchedulerPermittedIdentifiers` in Info.plist.
 */
async function verifyIosBackgroundApi(udid, opts = {}) {
  if (!udid) {
    return { ok: false, reason: "no-simulator" };
  }
  const taskIdentifier = opts.taskIdentifier ?? "ai.eliza.tasks.refresh";
  const baseUrl = opts.baseUrl;
  if (!baseUrl) {
    throw new Error(
      "iOS background verification requires an explicit agent route surface. " +
        "The loopback default is disabled for iOS local/full-Bun builds; use the WebView IPC smoke instead.",
    );
  }
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

  // Capture the pre-fire wake baseline from the caller-supplied route surface.
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
    throw new Error(
      `[local-chat-smoke] iOS /api/health is not reachable: ${message}`,
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
    if (!fieldImplemented) {
      throw new Error(
        "iOS /api/health.lastWakeFiredAt is missing; background wake verification cannot pass without it.",
      );
    }
    throw new Error(
      `iOS wake did not advance after BGTaskScheduler simulate for ${taskIdentifier}. ` +
        `baseline=${baselineWakeMs}`,
    );
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
  options = {},
) {
  const base = baseUrl.replace(/\/$/, "");
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (authToken) headers.Authorization = `Bearer ${authToken.trim()}`;
  const timeoutMs = options.timeoutMs;
  const controller =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? new AbortController()
      : null;
  const timeout =
    controller !== null
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  try {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      ...(controller ? { signal: controller.signal } : {}),
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
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new Error(`${method} ${pathname} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
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

async function requestTextResponse(
  method,
  pathname,
  body,
  baseUrl = apiBase,
  authToken = authTokenArg,
  timeoutMs = ANDROID_FULL_TURN_TIMEOUT_MS,
) {
  const { response, text } = await requestJsonResponse(
    method,
    pathname,
    body,
    baseUrl,
    authToken,
    { timeoutMs },
  );
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${text}`);
  }
  return text;
}

async function requestOptionalJson(method, pathname, baseUrl, authToken) {
  const { response, data, text } = await requestJsonResponse(
    method,
    pathname,
    undefined,
    baseUrl,
    authToken,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${text}`);
  }
  return data;
}

const TRANSIENT_ERROR_RE =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|empty body|timed out|aborted|terminated|premature close|other side closed|status 5\d\d/i;

function isTransientFailure(error) {
  const message =
    error instanceof Error ? `${error.message} ${error.cause ?? ""}` : "";
  return TRANSIENT_ERROR_RE.test(message);
}

/**
 * Run a request closure with bounded retry for transient blips only
 * (fetch failed / ECONNRESET / 5xx / timeout / accepted-but-empty body).
 * Non-transient failures (e.g. a 4xx assertion mismatch) rethrow immediately.
 */
async function withTransientRetry(label, fn, options = {}) {
  const attempts = options.attempts ?? ANDROID_TRANSIENT_RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? ANDROID_TRANSIENT_RETRY_DELAY_MS;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientFailure(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[local-chat-smoke] ${label} hit a transient failure (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms: ${message}`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error(`${label} failed after ${attempts} attempts.`);
}

/**
 * GET /api/health with a bounded HTTP timeout and transient retry. Treats an
 * accepted-but-empty body as a transient failure (the boot/restart window
 * accepts the socket then closes it empty).
 */
async function probeHealth(baseUrl, authToken) {
  return withTransientRetry("health probe", async () => {
    const { response, data, text } = await requestJsonResponse(
      "GET",
      "/api/health",
      undefined,
      baseUrl,
      authToken,
      { timeoutMs: ANDROID_HEALTH_PROBE_TIMEOUT_MS },
    );
    if (!response.ok) {
      throw new Error(`GET /api/health failed: ${response.status} ${text}`);
    }
    if (!text || !data || typeof data !== "object") {
      throw new Error("GET /api/health returned an empty body.");
    }
    return data;
  });
}

function readStartupAttempt(health) {
  const attempt = health?.startup?.attempt;
  return typeof attempt === "number" && Number.isFinite(attempt)
    ? attempt
    : null;
}

/**
 * Process-stability gate. Requires ANDROID_STABILITY_SAMPLES consecutive
 * /api/health reads with: agentState==running, ready==true, monotonically
 * increasing uptime, and a non-climbing startup.attempt. Keyed on PROCESS
 * health only — NOT on device-bridge connected:true, which is legitimately
 * false now that inference is served in-process.
 */
async function waitForAndroidProcessStability(baseUrl, authToken) {
  let consecutive = 0;
  let previousUptime = null;
  let previousAttempt = null;
  let lastHealth = null;
  for (let attempt = 1; attempt <= ANDROID_STABILITY_ATTEMPTS; attempt += 1) {
    let health;
    try {
      health = await probeHealth(baseUrl, authToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consecutive = 0;
      previousUptime = null;
      previousAttempt = null;
      if (attempt % 10 === 0) {
        console.warn(
          `[local-chat-smoke] Android process not stable yet (${attempt}/${ANDROID_STABILITY_ATTEMPTS}): ${message}`,
        );
      }
      await sleep(ANDROID_STABILITY_DELAY_MS);
      continue;
    }
    lastHealth = health;
    const uptime = typeof health.uptime === "number" ? health.uptime : null;
    const startupAttempt = readStartupAttempt(health);
    const running = health.agentState === "running" && health.ready === true;
    const uptimeMonotonic =
      uptime !== null && (previousUptime === null || uptime >= previousUptime);
    const attemptStable =
      previousAttempt === null ||
      startupAttempt === null ||
      startupAttempt <= previousAttempt;

    if (running && uptimeMonotonic && attemptStable) {
      consecutive += 1;
      if (consecutive >= ANDROID_STABILITY_SAMPLES) {
        console.log(
          `[local-chat-smoke] Android process stable: ${consecutive} consecutive healthy samples (uptime=${uptime}, startupAttempt=${startupAttempt}).`,
        );
        return health;
      }
    } else {
      // A restart reset the process; uptime dropped or attempt climbed.
      consecutive = running && uptimeMonotonic ? consecutive : 0;
    }
    previousUptime = uptime;
    previousAttempt = startupAttempt;
    await sleep(ANDROID_STABILITY_DELAY_MS);
  }
  throw new Error(
    `Android process did not reach ${ANDROID_STABILITY_SAMPLES} consecutive stable health samples in time. ` +
      `Last health: ${JSON.stringify(lastHealth)}`,
  );
}

function parseSseEvents(text) {
  const events = [];
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    const dataLines = [];
    let event = null;
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const sep = line.indexOf(":");
      const field = sep >= 0 ? line.slice(0, sep) : line;
      let value = sep >= 0 ? line.slice(sep + 1) : "";
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") {
        event = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }
    if (dataLines.length === 0) continue;
    const dataText = dataLines.join("\n");
    let data = dataText;
    try {
      data = JSON.parse(dataText);
    } catch {
      // Keep raw SSE payloads for diagnostics.
    }
    events.push({ event, data, dataText });
  }
  return events;
}

function assertObjectLike(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
  }
  return value;
}

function localInferenceSummary({ hub, device, providers }) {
  return {
    hubActive: hub?.active ?? null,
    hubDownloads: Array.isArray(hub?.downloads) ? hub.downloads : [],
    device: device ?? null,
    providers: Array.isArray(providers?.providers) ? providers.providers : [],
  };
}

async function requireLocalInferenceReady(baseUrl, authToken) {
  let lastSnapshot = null;
  for (
    let attempt = 1;
    attempt <= ANDROID_LOCAL_INFERENCE_READY_ATTEMPTS;
    attempt += 1
  ) {
    // The local-inference "hub" route lives in @elizaos/plugin-local-inference,
    // which the mobile bundle intentionally stubs — on mobile, local inference
    // is served by the on-device device-bridge (capacitor-llama), surfaced via
    // /api/local-inference/device below. So treat /hub as OPTIONAL: a 404 here
    // is expected on device and must not throw, otherwise readiness can never
    // fall through to the device-bridge path (deviceConnected && modelPath).
    const hub = await requestOptionalJson(
      "GET",
      "/api/local-inference/hub",
      baseUrl,
      authToken,
    );
    const device = await requestOptionalJson(
      "GET",
      "/api/local-inference/device",
      baseUrl,
      authToken,
    );
    const providers = await requestOptionalJson(
      "GET",
      "/api/local-inference/providers",
      baseUrl,
      authToken,
    );

    lastSnapshot = localInferenceSummary({ hub, device, providers });

    // Three accepted serving paths (see local-inference-readiness.mjs):
    // hub-active (desktop), device-bridge (paired cross-process device), and
    // bionic-host (Android in-process GPU host, #11498). Anything else keeps
    // polling and fails loudly after the attempt budget.
    const readiness = evaluateLocalInferenceReadiness({
      hub,
      device,
      providers,
    });
    if (readiness.error) {
      throw new Error(readiness.error);
    }
    if (readiness.ready) {
      console.log(
        `[local-chat-smoke] Local inference ready via ${readiness.via}.`,
      );
      return { hub, device, providers };
    }

    if (attempt % 10 === 0) {
      console.warn(
        `[local-chat-smoke] Local inference not ready yet (${attempt}/${ANDROID_LOCAL_INFERENCE_READY_ATTEMPTS}): ${JSON.stringify(lastSnapshot)}`,
      );
    }
    await sleep(ANDROID_LOCAL_INFERENCE_READY_DELAY_MS);
  }

  throw new Error(
    `Local inference is not ready for a full turn: ${JSON.stringify(
      lastSnapshot,
    )}`,
  );
}

function extractDoneEventFromSse(text) {
  const events = parseSseEvents(text);
  const errorEvent = events.find(
    (event) =>
      event.data &&
      typeof event.data === "object" &&
      event.data.type === "error",
  );
  if (errorEvent) {
    throw new Error(`Stream returned error event: ${errorEvent.dataText}`);
  }
  const done = events
    .map((event) => event.data)
    .find((data) => data && typeof data === "object" && data.type === "done");
  if (!done) {
    throw new Error(
      `Stream did not return a done event: ${text.slice(0, 500)}`,
    );
  }
  return done;
}

function requireUsableFullTurnReply(done, rawStreamText) {
  const doneObject = assertObjectLike(done, "Stream done event");
  if (doneObject.failureKind) {
    throw new Error(
      `Full-turn smoke returned failureKind=${doneObject.failureKind}: ${JSON.stringify(doneObject)}`,
    );
  }
  if (doneObject.noResponseReason) {
    throw new Error(
      `Full-turn smoke returned noResponseReason=${doneObject.noResponseReason}`,
    );
  }
  const reply = String(doneObject.fullText ?? doneObject.text ?? "").trim();
  if (!reply) {
    throw new Error(`Full-turn smoke returned empty reply: ${rawStreamText}`);
  }
  if (ANDROID_FULL_TURN_FAILURE_RE.test(reply)) {
    throw new Error(`Full-turn smoke returned unusable reply: ${reply}`);
  }
  const normalizedReply = reply
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (normalizedReply !== ANDROID_FULL_TURN_EXPECTED_REPLY) {
    throw new Error(
      `Full-turn smoke returned the wrong reply: ${reply} (expected ${ANDROID_FULL_TURN_EXPECTED_REPLY})`,
    );
  }
  return reply;
}

async function runLocalInferenceApiSmoke(
  baseUrl = apiBase,
  authToken = authTokenArg,
) {
  console.log(
    `[local-chat-smoke] Exercising app-core API at ${baseUrl} (conversation + local-inference full turn).`,
  );
  // Process-stability gate: wait for a settled agent process (monotonic uptime,
  // agentState==running, startup.attempt not climbing) before exercising, so a
  // turn is never fired mid-restart. Keyed on process health, NOT device-bridge
  // connected:true (inference is in-process now, so the bridge stays detached).
  await waitForAndroidProcessStability(baseUrl, authToken);
  const readiness = await requireLocalInferenceReady(baseUrl, authToken);
  const greetingCreated = await requestJson(
    "POST",
    "/api/conversations",
    {
      title: "Simulator local chat greeting smoke",
    },
    baseUrl,
    authToken,
  );
  const greetingConversationId = greetingCreated.conversation?.id;
  if (!greetingConversationId) {
    throw new Error(
      "Greeting smoke conversation creation did not return an id.",
    );
  }

  const greeting = await requestJson(
    "POST",
    `/api/conversations/${encodeURIComponent(greetingConversationId)}/greeting`,
    undefined,
    baseUrl,
    authToken,
  );
  if (String(greeting.text ?? "").includes("I'm running locally")) {
    throw new Error("Stale local-mode greeting is still present.");
  }

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

  const { done, reply } = await withTransientRetry(
    "streamed full turn",
    async () => {
      const streamText = await requestTextResponse(
        "POST",
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
        {
          text: ANDROID_FULL_TURN_PROMPT,
          channelType: "DM",
        },
        baseUrl,
        authToken,
        ANDROID_FULL_TURN_TIMEOUT_MS,
      );
      if (!streamText) {
        throw new Error("Streamed full turn returned an empty body.");
      }
      const doneEvent = extractDoneEventFromSse(streamText);
      return {
        done: doneEvent,
        reply: requireUsableFullTurnReply(doneEvent, streamText),
      };
    },
  );
  // Evidence that a local model served the turn. In-process inference
  // (aosp-local-llama / mobile-local-direct-reply) reports the model on the
  // SSE done event's usage block; the capacitor device bridge is legitimately
  // detached now, so its loadedPath is corroborating-only, not required.
  const usageModel =
    typeof done?.usage?.model === "string" ? done.usage.model : null;
  const usageProvider =
    typeof done?.usage?.provider === "string" ? done.usage.provider : null;
  const postTurnDevice = await requestOptionalJson(
    "GET",
    "/api/local-inference/device",
    baseUrl,
    authToken,
  );
  const loadedPath = postTurnDevice?.devices?.find?.(
    (device) => typeof device?.loadedPath === "string" && device.loadedPath,
  )?.loadedPath;
  if (!usageModel && !loadedPath) {
    throw new Error(
      `Full-turn smoke produced no local-model evidence (no usage.model and no device loadedPath): ${JSON.stringify(
        { usage: done?.usage ?? null, device: postTurnDevice },
      )}`,
    );
  }
  console.log("[local-chat-smoke] conversation:", conversationId);
  console.log("[local-chat-smoke] greeting:", greeting.text);
  console.log("[local-chat-smoke] reply:", reply);
  console.log(
    "[local-chat-smoke] served by:",
    usageModel
      ? `${usageModel}${usageProvider ? ` (${usageProvider})` : ""}`
      : `device-bridge ${loadedPath}`,
  );
  console.log(
    "[local-chat-smoke] local inference:",
    JSON.stringify(localInferenceSummary(readiness)),
  );
}

async function main() {
  let androidContext = null;
  let iosContext = null;
  let hostAgent = null;
  try {
    if (startHostAgent) {
      if (apiBase) {
        throw new Error(
          "--start-host-agent cannot be combined with --api-base.",
        );
      }
      hostAgent = await startDeviceE2eHostAgent({
        repoRoot,
        artifactDir: iosLocalChatResultDir,
        requestedPort: hostAgentPort,
        log: (message) => console.log(`[local-chat-smoke] ${message}`),
      });
      apiBase = hostAgent.apiBase;
    }

    if (platform === "ios" || platform === "both") {
      iosContext = launchIosSimulatorApp();
      if (iosContext?.installed) {
        assertInstalledIosRendererIsFresh(iosContext.udid);
      }
    }
    if (platform === "android" || platform === "both") {
      androidContext = await launchAndroidEmulatorApp();
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
          baseUrl: apiBase,
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

    if (platform === "ios" || platform === "both") {
      run(
        "bunx",
        [
          "vitest",
          "run",
          "--config",
          "vitest.config.ts",
          "src/api/ios-local-agent-kernel.local-inference.test.ts",
          "src/first-run/auto-download-recommended.test.ts",
        ],
        { cwd: path.join(repoRoot, "packages/ui") },
      );
    }
  } finally {
    await hostAgent?.stop();
    if (iosContext?.udid) {
      clearIosSmokeDefaults({
        udid: iosContext.udid,
        bundleId: appId(),
        extraKeys: IOS_SMOKE_STATE_KEYS,
        log: (message) => console.log(`[local-chat-smoke] ${message}`),
      });
    }
    cleanupAndroidAgentForwards(androidContext, "shutdown");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
