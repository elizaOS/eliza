#!/usr/bin/env node
// iOS Simulator native attachment smoke for #10936. WKWebView is not
// CDP-drivable, so this mirrors ios-onboarding-smoke: seed Capacitor
// Preferences, launch the installed app, let the in-app onboarding verifier
// connect it to a real local agent, then let the attachment verifier exercise
// the media store + Capacitor Filesystem/Share plugins and report back via
// Preferences.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureIosSimulatorScreenshot,
  startIosSimulatorVideo,
} from "./lib/ios-simulator-capture.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = path.resolve(appDir, "..", "..");
const resultDir = path.join(appDir, "test-results", "ios-attachment-smoke");
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

const ONBOARDING_REQUEST_KEY = "eliza:ios-onboarding-smoke:request";
const ONBOARDING_RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const ATTACHMENT_REQUEST_KEY = "eliza:ios-attachment-smoke:request";
const ATTACHMENT_RESULT_KEY = "eliza:ios-attachment-smoke:result";
const DEFAULT_API_BASE = "http://127.0.0.1:31338";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const has = (flag) => process.argv.includes(flag);
const val = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const log = (message) => console.log(`[ios-attachment-smoke] ${message}`);

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
  } catch {
    return null;
  }
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
    throw new Error("iOS attachment smoke requires macOS with xcrun simctl.");
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

function deleteSimulatorPreferenceDomainKeys(udid, appId, keys) {
  for (const key of keys) {
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
        } catch {
          // Fall through.
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

const FIRST_RUN_STATE_KEYS = [
  ONBOARDING_REQUEST_KEY,
  ONBOARDING_RESULT_KEY,
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

function clearState(udid, appId) {
  for (const key of FIRST_RUN_STATE_KEYS) {
    defaultsDelete(udid, appId, key);
  }
}

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
    filename: "attachment-smoke.mp4",
    log,
  });
}

async function stopVideo(recording) {
  if (!recording) return null;
  return recording.stop();
}

async function pollResult(udid, appId) {
  const attempts = Number.parseInt(
    process.env.IOS_ATTACHMENT_SMOKE_ATTEMPTS ?? "210",
    10,
  );
  const delayMs = Number.parseInt(
    process.env.IOS_ATTACHMENT_SMOKE_DELAY_MS ?? "1000",
    10,
  );
  let lastRaw = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastRaw = defaultsReadString(udid, appId, ATTACHMENT_RESULT_KEY) ?? "";
    if (lastRaw) {
      let parsed = null;
      try {
        parsed = JSON.parse(lastRaw);
      } catch {
        parsed = null;
      }
      if (parsed?.ok === true) return parsed;
      if (parsed?.phase === "failed" || parsed?.error) {
        throw new Error(`iOS attachment smoke failed: ${lastRaw}`);
      }
      if (attempt % 15 === 0) {
        log(`still running (${attempt}/${attempts}): ${lastRaw}`);
      }
    }
    await sleep(delayMs);
  }
  throw new Error(
    `iOS attachment smoke timed out after ${attempts} attempts. Last result: ${lastRaw || "<none>"}`,
  );
}

async function main() {
  const { appId, urlScheme } = readAppIdentity();
  const apiBase = val("--api-base", DEFAULT_API_BASE);
  const filename = val("--filename", "eliza-ios-attachment-smoke.png");
  const udid = ensureSimulatorBooted();
  removePathRecursive(resultDir);
  fs.mkdirSync(resultDir, { recursive: true });

  deleteSimulatorPreferenceDomainKeys(udid, appId, FIRST_RUN_STATE_KEYS);
  flushPreferences(udid);
  installLatestApp(udid, appId);
  tryRun("xcrun", ["simctl", "terminate", udid, appId]);
  clearState(udid, appId);
  defaultsWriteString(
    udid,
    appId,
    ONBOARDING_REQUEST_KEY,
    JSON.stringify({ apiBase }),
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
  defaultsWriteString(
    udid,
    appId,
    ATTACHMENT_REQUEST_KEY,
    JSON.stringify({
      apiBase,
      filename,
      dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    }),
  );
  defaultsWriteString(
    udid,
    appId,
    ATTACHMENT_RESULT_KEY,
    JSON.stringify({
      ok: false,
      phase: "requested",
      apiBase,
      updatedAt: new Date().toISOString(),
    }),
  );
  flushPreferences(udid);

  const recording = startVideo(udid);
  try {
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
    takeScreenshot(udid, "fresh-launch");
    const result = await pollResult(udid, appId);
    const screenshot = takeScreenshot(udid, "attachment-result");
    const video = await stopVideo(recording);
    fs.writeFileSync(
      path.join(resultDir, "result.json"),
      `${JSON.stringify({ ...result, screenshot, video }, null, 2)}\n`,
    );
    log(`PASS ${JSON.stringify({ screenshot, video })}`);
  } catch (error) {
    const screenshot = takeScreenshot(udid, "failure");
    await stopVideo(recording);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${screenshot ? ` (screenshot: ${screenshot})` : ""}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
