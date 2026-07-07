#!/usr/bin/env node
/**
 * iOS Simulator cloud-onboarding smoke for the production first-run path.
 *
 * The harness seeds a throwaway e2e-wallet private key into Capacitor
 * Preferences, launches a fresh simulator install, and lets the WebView run the
 * genuine SIWE login plus cloud-agent provisioning path. WKWebView is not
 * CDP-drivable, so the app reports structured pass/fail details through a
 * simulator Preference key while this script records screenshots and video.
 */
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
const resultRoot = path.join(appDir, "test-results", "ios-cloud-onboarding");

const REQUEST_KEY = "eliza:ios-cloud-onboarding-smoke:request";
const RESULT_KEY = "eliza:ios-cloud-onboarding-smoke:result";
const E2E_WALLET_KEY = "eliza:e2e-wallet:pk";
const E2E_WALLET_AUTOLOGIN_KEY = "eliza:e2e-wallet:autologin";
const DEFAULT_E2E_WALLET_PRIVATE_KEY_PARTS = [
  "0x",
  "59c6995e",
  "998f97a5",
  "a0044966",
  "f094538d",
  "5f7e9e7f",
  "5b4c5f2f",
  "5a4f5c6e",
  "8f2d3a22",
];

const FIRST_RUN_STATE_KEYS = [
  REQUEST_KEY,
  RESULT_KEY,
  E2E_WALLET_KEY,
  E2E_WALLET_AUTOLOGIN_KEY,
  "eliza:first-run-complete",
  "eliza:onboarding-complete",
  "eliza:setup:step",
  "eliza:mobile-runtime-mode",
  "elizaos:active-server",
  "elizaos:first-run:force-fresh",
  "steward_session_token",
];

const has = (flag) => process.argv.includes(flag);
const val = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const log = (message) => console.log(`[ios-cloud-onboarding] ${message}`);

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

function readAppIdentity() {
  const src = fs.readFileSync(path.join(appDir, "app.config.ts"), "utf8");
  return {
    appId:
      val("--app-id") ??
      src.match(/appId:\s*["']([^"']+)["']/)?.[1] ??
      "ai.elizaos.app",
  };
}

function simctl(args, options = {}) {
  return run("xcrun", ["simctl", ...args], { stdio: "pipe", ...options });
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
    throw new Error("iOS cloud onboarding requires macOS with xcrun simctl.");
  }
  const existing = bootedUdid();
  if (existing) {
    log(`reusing booted simulator ${existing}`);
    return existing;
  }
  const target = val("--device", "iPhone 16 Pro");
  log(`booting simulator ${target}`);
  simctl(["boot", target], { stdio: "inherit" });
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
}

function preferenceNativeKeys(key) {
  return [`CapacitorStorage.${key}`, key];
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
}

function defaultsReadString(udid, appId, key) {
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

function e2eWalletPrivateKey() {
  return (
    process.env.ELIZA_E2E_WALLET_PK?.trim() ||
    DEFAULT_E2E_WALLET_PRIVATE_KEY_PARTS.join("")
  );
}

function modesToRun() {
  const mode = val("--mode", "both");
  if (mode === "tap" || mode === "autologin") return [mode];
  if (mode === "both") return ["tap", "autologin"];
  throw new Error(`Unsupported --mode ${mode}`);
}

function takeScreenshot(udid, artifactDir, label) {
  try {
    return captureIosSimulatorScreenshot({
      target: udid,
      artifactDir,
      filename: `${label}.png`,
      log,
    });
  } catch (error) {
    log(
      `screenshot ${label} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function startVideo(udid, artifactDir, mode) {
  if (has("--no-video")) return null;
  return startIosSimulatorVideo({
    target: udid,
    artifactDir,
    filename: `cloud-onboarding-${mode}.mov`,
    log,
  });
}

async function pollResult(udid, appId, mode) {
  const attempts = Number.parseInt(
    process.env.IOS_CLOUD_ONBOARDING_ATTEMPTS ?? "240",
    10,
  );
  const delayMs = Number.parseInt(
    process.env.IOS_CLOUD_ONBOARDING_DELAY_MS ?? "1000",
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
        parsed = null;
      }
      if (parsed?.phase === "complete") return parsed;
      if (parsed?.phase === "failed" || parsed?.error) {
        throw new Error(`iOS cloud onboarding ${mode} failed: ${lastRaw}`);
      }
      if (attempt % 20 === 0) {
        log(`still running ${mode} (${attempt}/${attempts}): ${lastRaw}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `iOS cloud onboarding ${mode} timed out. Last result: ${lastRaw || "<none>"}`,
  );
}

async function runMode({ udid, appId, mode, privateKey }) {
  const artifactDir = path.join(resultRoot, mode);
  fs.rmSync(artifactDir, { force: true, recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });

  tryRun("xcrun", ["simctl", "terminate", udid, appId]);
  for (const key of FIRST_RUN_STATE_KEYS) defaultsDelete(udid, appId, key);
  installLatestApp(udid, appId);
  for (const key of FIRST_RUN_STATE_KEYS) defaultsDelete(udid, appId, key);

  defaultsWriteString(udid, appId, E2E_WALLET_KEY, privateKey);
  if (mode === "autologin") {
    defaultsWriteString(udid, appId, E2E_WALLET_AUTOLOGIN_KEY, "1");
  }
  defaultsWriteString(udid, appId, REQUEST_KEY, JSON.stringify({ mode }));
  defaultsWriteString(
    udid,
    appId,
    RESULT_KEY,
    JSON.stringify({
      ok: false,
      phase: "requested",
      mode,
      updatedAt: new Date().toISOString(),
    }),
  );
  flushPreferences(udid);

  const recording = startVideo(udid, artifactDir, mode);
  try {
    log(`launching ${appId} for ${mode}`);
    simctl(["launch", udid, appId]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    takeScreenshot(udid, artifactDir, `${mode}-start`);
    const result = await pollResult(udid, appId, mode);
    takeScreenshot(udid, artifactDir, `${mode}-home`);
    if (result.ok !== true) {
      throw new Error(
        `iOS cloud onboarding ${mode} completed with ok=false: ${JSON.stringify(result)}`,
      );
    }
    if (result.firstRunPostCount !== 1) {
      throw new Error(
        `iOS cloud onboarding ${mode} expected exactly one /api/first-run POST, got ${result.firstRunPostCount}`,
      );
    }
    if (mode === "tap" && result.signInGreetingVisible !== true) {
      throw new Error("tap mode did not prove the sign-in greeting");
    }
    fs.writeFileSync(
      path.join(artifactDir, "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    log(`${mode} PASS`);
  } finally {
    const videoPath = await recording?.stop();
    if (videoPath) log(`video: ${videoPath}`);
  }
}

async function main() {
  if (process.env.ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE !== "1") {
    throw new Error(
      "Set ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE=1 to run against real Eliza Cloud.",
    );
  }
  const { appId } = readAppIdentity();
  const udid = ensureSimulatorBooted();
  fs.rmSync(resultRoot, { force: true, recursive: true });
  fs.mkdirSync(resultRoot, { recursive: true });
  const privateKey = e2eWalletPrivateKey();
  for (const mode of modesToRun()) {
    await runMode({ udid, appId, mode, privateKey });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
