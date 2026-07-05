#!/usr/bin/env node
// iOS Simulator first-run REMOTE-CONNECT smoke. WKWebView is not CDP-drivable
// like Android, so the harness writes a Capacitor Preferences request, launches
// the installed app, and lets the in-app verifier drive the same hardened
// first-run remote-connect handler used by the OS deep-link path. The verifier
// proves the app landed on home and reports back via Preferences. No onboarding
// DOM is driven, so the lane survives the in-chat redesign.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HOST_AGENT_PORT,
  startDeviceE2eHostAgent,
} from "./lib/host-agent.mjs";
import {
  assertCandidateIosAppRendererFresh,
  assertInstalledIosAppRendererFresh,
} from "./lib/ios-renderer-stamp.mjs";
import { clearIosSmokeDefaults } from "./lib/ios-sim-defaults-hygiene.mjs";
import {
  captureIosSimulatorScreenshot,
  startIosSimulatorVideo,
} from "./lib/ios-simulator-capture.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = path.resolve(appDir, "..", "..");
const resultDir = path.join(appDir, "test-results", "ios-onboarding-to-home");
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const REQUEST_KEY = "eliza:ios-onboarding-smoke:request";
const RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const RELAUNCH_REQUEST_KEY = "eliza:ios-onboarding-relaunch-smoke:request";
const RELAUNCH_RESULT_KEY = "eliza:ios-onboarding-relaunch-smoke:result";
const MIXED_CONTENT_REQUEST_KEY = "eliza:ios-mixed-content-smoke:request";
const MIXED_CONTENT_RESULT_KEY = "eliza:ios-mixed-content-smoke:result";
const ATTACHMENT_REQUEST_KEY = "eliza:ios-attachment-smoke:request";
const ATTACHMENT_RESULT_KEY = "eliza:ios-attachment-smoke:result";
const DEFAULT_HOST_AGENT_PORT_STRING = String(DEFAULT_HOST_AGENT_PORT);

const has = (flag) => process.argv.includes(flag);
const val = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const log = (message) => console.log(`[ios-onboarding-smoke] ${message}`);

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

function removePathRecursive(targetPath) {
  const result = spawnSync(
    "node",
    [cleanupHelperScript, path.relative(repoRoot, targetPath)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
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

function tryRun(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
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
    throw new Error("iOS onboarding smoke requires macOS with xcrun simctl.");
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
  if (has("--skip-install")) {
    assertInstalledIosAppRendererFresh({
      udid,
      bundleId: appId,
      repoRoot,
      log,
    });
    return;
  }
  const appPath = val("--app-path") ?? latestBuiltApp();
  if (!appPath) {
    throw new Error(
      "Could not find a Debug-iphonesimulator App.app. Build the iOS simulator app first or pass --app-path.",
    );
  }
  assertCandidateIosAppRendererFresh({
    appPath,
    bundleId: appId,
    repoRoot,
    log,
  });
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
  assertInstalledIosAppRendererFresh({
    udid,
    bundleId: appId,
    repoRoot,
    log,
  });
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

function defaultsWriteString(udid, appId, key, value) {
  const nativeKeys = preferenceNativeKeys(key);
  // Write through the simulator defaults domain. Host-path `defaults write`
  // can be visible to the host polling process while remaining invisible to
  // the running simulator app's UserDefaults/Capacitor Preferences bridge.
  for (const [index, nativeKey] of nativeKeys.entries()) {
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
    if (index === 0) {
      run("xcrun", args, { stdio: "ignore" });
    } else {
      tryRun("xcrun", args);
    }
  }
}

function defaultsReadString(udid, appId, key) {
  const nativeKeys = preferenceNativeKeys(key);
  const domainPath = prefsDomainPath(udid, appId);
  if (domainPath) {
    const plist = `${domainPath}.plist`;
    if (fs.existsSync(plist)) {
      const json = tryRun("plutil", ["-convert", "json", "-o", "-", plist]);
      if (json) {
        try {
          const parsed = JSON.parse(json);
          for (const nativeKey of nativeKeys) {
            if (typeof parsed[nativeKey] === "string") return parsed[nativeKey];
          }
        } catch {
          // Fall through to defaults read.
        }
      }
    }
    for (const nativeKey of nativeKeys) {
      const value = tryRun("defaults", ["read", domainPath, nativeKey]);
      if (value !== null) return value;
    }
  }

  for (const nativeKey of nativeKeys) {
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

const FIRST_RUN_STATE_KEYS = [
  REQUEST_KEY,
  RESULT_KEY,
  RELAUNCH_REQUEST_KEY,
  RELAUNCH_RESULT_KEY,
  MIXED_CONTENT_REQUEST_KEY,
  MIXED_CONTENT_RESULT_KEY,
  ATTACHMENT_REQUEST_KEY,
  ATTACHMENT_RESULT_KEY,
  "elizaos:active-server",
  "eliza:first-run-complete",
  "eliza:setup:step",
  "eliza:onboarding-complete",
  "eliza:mobile-runtime-mode",
  "eliza.background.config",
  "elizaos:first-run:force-fresh",
];

function takeScreenshot(udid, label) {
  try {
    return captureIosSimulatorScreenshot({
      target: udid,
      artifactDir: resultDir,
      filename: `${label}.png`,
      log,
    });
  } catch {
    return null;
  }
}

function startVideo(udid) {
  if (has("--no-video")) return null;
  return startIosSimulatorVideo({
    target: udid,
    artifactDir: resultDir,
    filename: "onboarding-to-home.mp4",
    log,
  });
}

async function stopVideo(recording) {
  if (!recording) return null;
  return recording.stop();
}

async function pollResult(udid, appId) {
  const attempts = Number.parseInt(
    process.env.IOS_ONBOARDING_SMOKE_ATTEMPTS ?? "180",
    10,
  );
  const delayMs = Number.parseInt(
    process.env.IOS_ONBOARDING_SMOKE_DELAY_MS ?? "1000",
    10,
  );
  let lastRaw = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastRaw = defaultsReadString(udid, appId, RESULT_KEY) ?? "";
    if (lastRaw) {
      let parsed = null;
      try {
        parsed = JSON.parse(lastRaw);
      } catch {
        // error-policy:J3 malformed simulator preference is not a completed result
        parsed = null;
      }
      if (parsed?.ok === true) return parsed;
      if (parsed?.phase === "failed" || parsed?.error) {
        throw new Error(`iOS onboarding smoke failed: ${lastRaw}`);
      }
      if (attempt % 15 === 0) {
        log(`still running (${attempt}/${attempts}): ${lastRaw}`);
      }
    }
    await sleep(delayMs);
  }
  throw new Error(
    `iOS onboarding smoke timed out after ${attempts} attempts. Last result: ${lastRaw || "<none>"}`,
  );
}

async function pollRelaunchResult(udid, appId) {
  const attempts = Number.parseInt(
    process.env.IOS_ONBOARDING_SMOKE_ATTEMPTS ?? "180",
    10,
  );
  const delayMs = Number.parseInt(
    process.env.IOS_ONBOARDING_SMOKE_DELAY_MS ?? "1000",
    10,
  );
  let lastRaw = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastRaw = defaultsReadString(udid, appId, RELAUNCH_RESULT_KEY) ?? "";
    if (lastRaw) {
      let parsed = null;
      try {
        parsed = JSON.parse(lastRaw);
      } catch {
        // error-policy:J3 malformed simulator preference is not a completed result
        parsed = null;
      }
      if (parsed?.ok === true) return parsed;
      if (parsed?.phase === "failed" || parsed?.error) {
        throw new Error(`iOS relaunch smoke failed: ${lastRaw}`);
      }
      if (attempt % 15 === 0) {
        log(`still proving relaunch (${attempt}/${attempts}): ${lastRaw}`);
      }
    }
    await sleep(delayMs);
  }
  throw new Error(
    `iOS relaunch smoke timed out after ${attempts} attempts. Last result: ${lastRaw || "<none>"}`,
  );
}

async function pollMixedContentResult(udid, appId) {
  const attempts = Number.parseInt(
    process.env.IOS_ONBOARDING_SMOKE_ATTEMPTS ?? "180",
    10,
  );
  const delayMs = Number.parseInt(
    process.env.IOS_ONBOARDING_SMOKE_DELAY_MS ?? "1000",
    10,
  );
  let lastRaw = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastRaw = defaultsReadString(udid, appId, MIXED_CONTENT_RESULT_KEY) ?? "";
    if (lastRaw) {
      let parsed = null;
      try {
        parsed = JSON.parse(lastRaw);
      } catch {
        parsed = null;
      }
      if (parsed?.ok === true) return parsed;
      if (parsed?.phase === "failed" || parsed?.error) {
        throw new Error(`iOS mixed-content smoke failed: ${lastRaw}`);
      }
      if (attempt % 15 === 0) {
        log(
          `still proving mixed-content fallback (${attempt}/${attempts}): ${lastRaw}`,
        );
      }
    }
    await sleep(delayMs);
  }
  throw new Error(
    `iOS mixed-content smoke timed out after ${attempts} attempts. Last result: ${lastRaw || "<none>"}`,
  );
}

async function main() {
  const { appId, urlScheme } = readAppIdentity();
  let apiBase = val("--api-base");
  const udid = ensureSimulatorBooted();
  removePathRecursive(resultDir);
  fs.mkdirSync(resultDir, { recursive: true });
  const hostAgent = apiBase
    ? null
    : await startDeviceE2eHostAgent({
        repoRoot,
        artifactDir: resultDir,
        requestedPort: val("--host-agent-port"),
        preferredPort:
          process.env.ELIZA_IOS_HOST_AGENT_PORT ??
          DEFAULT_HOST_AGENT_PORT_STRING,
        log,
      });
  apiBase = apiBase ?? hostAgent.apiBase;
  let recording = null;

  try {
    clearIosSmokeDefaults({
      udid,
      bundleId: appId,
      extraKeys: FIRST_RUN_STATE_KEYS,
      log,
    });
    installLatestApp(udid, appId);
    tryRun("xcrun", ["simctl", "terminate", udid, appId]);
    clearIosSmokeDefaults({
      udid,
      bundleId: appId,
      extraKeys: FIRST_RUN_STATE_KEYS,
      log,
    });
    defaultsWriteString(udid, appId, REQUEST_KEY, JSON.stringify({ apiBase }));
    defaultsWriteString(
      udid,
      appId,
      RESULT_KEY,
      JSON.stringify({
        ok: false,
        phase: "requested",
        apiBase,
        updatedAt: new Date().toISOString(),
      }),
    );
    flushPreferences(udid);
    defaultsWriteString(
      udid,
      appId,
      MIXED_CONTENT_REQUEST_KEY,
      JSON.stringify({ apiBase }),
    );
    defaultsWriteString(
      udid,
      appId,
      MIXED_CONTENT_RESULT_KEY,
      JSON.stringify({
        ok: false,
        phase: "requested",
        apiBase,
        updatedAt: new Date().toISOString(),
      }),
    );
    flushPreferences(udid);

    recording = startVideo(udid);
    log(`launching ${appId} on ${udid}`);
    simctl(["launch", udid, appId]);
    await sleep(1500);
    const deepLink = `${urlScheme}://first-run/runtime/remote?api=${encodeURIComponent(apiBase)}`;
    if (has("--os-deep-link")) {
      log(`opening first-run remote deep link: ${deepLink}`);
      simctl(["openurl", udid, deepLink]);
    } else {
      log(`armed in-app first-run remote connect for ${apiBase}`);
    }
    takeScreenshot(udid, "fresh-onboarding");
    const result = await pollResult(udid, appId);
    const screenshot = takeScreenshot(udid, "home-landing");
    if (result.homeVisible !== true || result.composerVisible !== true) {
      throw new Error(
        `iOS onboarding smoke result lacked home/composer: ${JSON.stringify(result)}`,
      );
    }
    if (result.onboardingHidden !== true) {
      throw new Error(
        `iOS onboarding smoke did not prove onboarding was hidden: ${JSON.stringify(result)}`,
      );
    }
    const activeServer = result.storage?.["elizaos:active-server"];
    if (typeof activeServer !== "string" || !activeServer.includes(apiBase)) {
      throw new Error(
        `iOS onboarding smoke did not persist active server ${apiBase}: ${JSON.stringify(result.storage)}`,
      );
    }
    const mixedContentResult = await pollMixedContentResult(udid, appId);
    if (
      !String(mixedContentResult.webViewOrigin).startsWith("https://localhost")
    ) {
      throw new Error(
        `iOS mixed-content smoke did not run from https://localhost: ${JSON.stringify(mixedContentResult)}`,
      );
    }
    if (mixedContentResult.mixedContentWouldBlockWebSocket !== true) {
      throw new Error(
        `iOS mixed-content smoke did not prove an insecure ws:// would be mixed content: ${JSON.stringify(mixedContentResult)}`,
      );
    }
    if (
      !Array.isArray(mixedContentResult.webSocketConstructorCalls) ||
      mixedContentResult.webSocketConstructorCalls.length !== 0
    ) {
      throw new Error(
        `iOS mixed-content smoke attempted a WebSocket: ${JSON.stringify(mixedContentResult.webSocketConstructorCalls)}`,
      );
    }
    if (mixedContentResult.connectionState?.state !== "connected") {
      throw new Error(
        `iOS mixed-content smoke was not connected-over-REST: ${JSON.stringify(mixedContentResult.connectionState)}`,
      );
    }
    if (mixedContentResult.lostBackendOverlayAbsent !== true) {
      throw new Error(
        `iOS mixed-content smoke found the lost backend overlay: ${JSON.stringify(mixedContentResult)}`,
      );
    }
    if (mixedContentResult.restHealth?.ok !== true) {
      throw new Error(
        `iOS mixed-content smoke REST health failed: ${JSON.stringify(mixedContentResult.restHealth)}`,
      );
    }
    defaultsWriteString(
      udid,
      appId,
      RELAUNCH_REQUEST_KEY,
      JSON.stringify({ apiBase }),
    );
    defaultsWriteString(
      udid,
      appId,
      RELAUNCH_RESULT_KEY,
      JSON.stringify({
        ok: false,
        phase: "requested",
        apiBase,
        updatedAt: new Date().toISOString(),
      }),
    );
    flushPreferences(udid);
    log(`terminating ${appId} for cold relaunch proof`);
    simctl(["terminate", udid, appId]);
    await sleep(1000);
    log(`relaunching ${appId} for cold relaunch proof`);
    simctl(["launch", udid, appId]);
    const relaunchResult = await pollRelaunchResult(udid, appId);
    const relaunchScreenshot = takeScreenshot(udid, "cold-relaunch-home");
    const video = await stopVideo(recording);
    if (
      relaunchResult.homeVisible !== true ||
      relaunchResult.composerVisible !== true
    ) {
      throw new Error(
        `iOS relaunch smoke result lacked home/composer: ${JSON.stringify(relaunchResult)}`,
      );
    }
    if (relaunchResult.onboardingHidden !== true) {
      throw new Error(
        `iOS relaunch smoke did not prove onboarding was hidden: ${JSON.stringify(relaunchResult)}`,
      );
    }
    clearIosSmokeDefaults({
      udid,
      bundleId: appId,
      extraKeys: FIRST_RUN_STATE_KEYS,
      log,
    });
    fs.writeFileSync(
      path.join(resultDir, "result.json"),
      `${JSON.stringify(
        {
          ...result,
          screenshot,
          video,
          mixedContent: mixedContentResult,
          coldRelaunch: {
            ...relaunchResult,
            screenshot: relaunchScreenshot,
          },
        },
        null,
        2,
      )}\n`,
    );
    log(`PASS ${JSON.stringify({ screenshot, relaunchScreenshot, video })}`);
  } catch (error) {
    const screenshot = takeScreenshot(udid, "failure");
    await stopVideo(recording);
    clearIosSmokeDefaults({
      udid,
      bundleId: appId,
      extraKeys: FIRST_RUN_STATE_KEYS,
      log,
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${screenshot ? ` (screenshot: ${screenshot})` : ""}`,
    );
  } finally {
    await hostAgent?.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
