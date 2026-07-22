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
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertLiveReply } from "../test/liveness-contract.mjs";
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
const RELAUNCH_REQUEST_KEY = "eliza:ios-onboarding-relaunch-smoke:request";
const RELAUNCH_RESULT_KEY = "eliza:ios-onboarding-relaunch-smoke:result";
const IOS_SIMULATOR_CAPTURE_SETTLE_MS = 1_500;
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
  "eliza:permissions-primed",
  "eliza:mobile-runtime-mode",
  "elizaos:active-server",
  "elizaos:first-run:force-fresh",
  "steward_session_token",
  RELAUNCH_REQUEST_KEY,
  RELAUNCH_RESULT_KEY,
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
    // error-policy:J4 optional Simulator probes have explicit null fallbacks;
    // required commands use run() and fail the harness instead
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

export function findSimulator(target) {
  const json = tryRun("xcrun", [
    "simctl",
    "list",
    "devices",
    "available",
    "--json",
  ]);
  if (!json) return null;
  const parsed = JSON.parse(json);
  for (const devices of Object.values(parsed.devices ?? {})) {
    const simulator = devices.find(
      (device) => device.udid === target || device.name === target,
    );
    if (simulator?.udid) return simulator;
  }
  return null;
}

export function ensureSimulatorBooted() {
  const target = val("--device") ?? process.env.ELIZA_IOS_SIMULATOR_UDID;
  if (!target) {
    throw new Error(
      "iOS cloud onboarding requires an exact simulator via --device or ELIZA_IOS_SIMULATOR_UDID.",
    );
  }
  const simulator = findSimulator(target);
  if (!simulator) {
    throw new Error(`Simulator ${target} is not available.`);
  }
  if (simulator.state !== "Booted") {
    log(`booting simulator ${simulator.udid}`);
    simctl(["boot", simulator.udid], { stdio: "inherit" });
  } else {
    log(`reusing dedicated simulator ${simulator.udid}`);
  }
  tryRun("open", ["-a", "Simulator"]);
  simctl(["bootstatus", simulator.udid, "-b"], { stdio: "inherit" });
  return simulator.udid;
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

export function readSimulatorPreferenceString(
  udid,
  appId,
  key,
  { authoritativePlistAbsence = false } = {},
) {
  const container = tryRun("xcrun", [
    "simctl",
    "get_app_container",
    udid,
    appId,
    "data",
  ]);
  if (container) {
    const plistPath = path.join(
      container,
      "Library",
      "Preferences",
      `${appId}.plist`,
    );
    if (fs.existsSync(plistPath)) {
      const json = tryRun("plutil", ["-convert", "json", "-o", "-", plistPath]);
      if (json) {
        try {
          const preferences = JSON.parse(json);
          if (
            preferences &&
            typeof preferences === "object" &&
            !Array.isArray(preferences)
          ) {
            for (const nativeKey of preferenceNativeKeys(key)) {
              const value = preferences[nativeKey];
              if (typeof value === "string") return value;
            }
            if (authoritativePlistAbsence) {
              // Request consumption needs durable deletion semantics: asking
              // the defaults daemon here can resurrect its stale cache after
              // Preferences.remove. Result polling keeps the compatibility
              // fallback because a new value may reach cfprefsd before disk.
              return null;
            }
          }
        } catch {
          // error-policy:J3 a transient or malformed plist is an explicit miss;
          // defaults remains the compatibility fallback below
        }
      }
    }
  }
  return defaultsReadString(udid, appId, key);
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

async function pollResult(udid, appId, mode, runId) {
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
    lastRaw = readSimulatorPreferenceString(udid, appId, RESULT_KEY) ?? "";
    if (lastRaw) {
      let parsed = null;
      try {
        parsed = JSON.parse(lastRaw);
      } catch {
        parsed = null;
      }
      if (parsed?.runId !== runId || parsed?.mode !== mode) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      if (parsed.phase === "complete") return parsed;
      if (parsed.phase === "failed" || parsed.error) {
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

async function pollRelaunchResult(udid, appId, runId) {
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
    lastRaw =
      readSimulatorPreferenceString(udid, appId, RELAUNCH_RESULT_KEY) ?? "";
    if (lastRaw) {
      let parsed = null;
      try {
        parsed = JSON.parse(lastRaw);
      } catch {
        parsed = null;
      }
      if (parsed?.runId !== runId) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      if (parsed.phase === "complete") return parsed;
      if (parsed.phase === "failed" || parsed.error) {
        throw new Error(`iOS Cloud cold relaunch failed: ${lastRaw}`);
      }
      if (attempt % 20 === 0) {
        log(`still proving cold relaunch (${attempt}/${attempts}): ${lastRaw}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `iOS Cloud cold relaunch timed out. Last result: ${lastRaw || "<none>"}`,
  );
}

async function waitForRequestConsumption(udid, appId) {
  const attempts = Number.parseInt(
    process.env.IOS_CLOUD_ONBOARDING_ATTEMPTS ?? "240",
    10,
  );
  const delayMs = Number.parseInt(
    process.env.IOS_CLOUD_ONBOARDING_DELAY_MS ?? "1000",
    10,
  );
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (
      readSimulatorPreferenceString(udid, appId, REQUEST_KEY, {
        authoritativePlistAbsence: true,
      }) === null
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    "iOS Cloud onboarding app did not consume its one-shot smoke request before cold relaunch",
  );
}

export function activeCloudApiBase(result) {
  const raw = result.storage?.["elizaos:active-server"];
  if (typeof raw !== "string") {
    throw new Error("Cloud onboarding result did not include an active server");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Cloud onboarding active-server proof was malformed", {
      cause: error,
    });
  }
  if (
    parsed?.kind !== "cloud" ||
    typeof parsed.apiBase !== "string" ||
    !/^https:\/\/[a-z0-9-]+(?:\.staging)?\.elizacloud\.ai$/.test(parsed.apiBase)
  ) {
    throw new Error(
      `Cloud onboarding result selected an invalid API base: ${JSON.stringify(parsed)}`,
    );
  }
  return parsed.apiBase;
}

async function runMode({ udid, appId, mode, privateKey }) {
  const artifactDir = path.join(resultRoot, mode);
  fs.rmSync(artifactDir, { force: true, recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });

  tryRun("xcrun", ["simctl", "terminate", udid, appId]);
  for (const key of FIRST_RUN_STATE_KEYS) defaultsDelete(udid, appId, key);
  // Each lane proves a genuinely fresh login. Simulator app deletion does not
  // clear Keychain items, so a prior mode could otherwise silently restore its
  // Cloud credential and skip the sign-in surface under test.
  simctl(["keychain", udid, "reset"]);
  installLatestApp(udid, appId);
  simctl(["privacy", udid, "reset", "all", appId]);
  for (const key of FIRST_RUN_STATE_KEYS) defaultsDelete(udid, appId, key);

  const runId = randomUUID();
  const liveness =
    has("--liveness") || process.env.ELIZA_CLOUD_ONBOARDING_LIVENESS === "1";
  const livenessExpectedReply = `IOS-CLOUD-${runId.slice(0, 8).toUpperCase()}`;
  const requestedLivenessPrompt = val("--liveness-prompt");
  const livenessPrompt = requestedLivenessPrompt
    ? `${requestedLivenessPrompt}\nReply with exactly this verification token and nothing else: ${livenessExpectedReply}`
    : `Reply with exactly this verification token and nothing else: ${livenessExpectedReply}`;
  defaultsWriteString(udid, appId, E2E_WALLET_KEY, privateKey);
  if (mode === "autologin") {
    defaultsWriteString(udid, appId, E2E_WALLET_AUTOLOGIN_KEY, "1");
  }
  defaultsWriteString(
    udid,
    appId,
    REQUEST_KEY,
    JSON.stringify({
      mode,
      runId,
      liveness,
      livenessPrompt,
      livenessExpectedReply,
      completePermissionPriming: true,
    }),
  );
  defaultsWriteString(
    udid,
    appId,
    RESULT_KEY,
    JSON.stringify({
      ok: false,
      phase: "requested",
      mode,
      runId,
      updatedAt: new Date().toISOString(),
    }),
  );
  flushPreferences(udid);

  let recording = startVideo(udid, artifactDir, mode);
  let relaunchRecording = null;
  let completionCaptureLabel = `${mode}-failed`;
  try {
    log(`launching ${appId} for ${mode}`);
    simctl(["launch", udid, appId]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    takeScreenshot(udid, artifactDir, `${mode}-start`);
    const result = await pollResult(udid, appId, mode, runId);
    if (result.ok !== true) {
      throw new Error(
        `iOS cloud onboarding ${mode} completed with ok=false: ${JSON.stringify(result)}`,
      );
    }
    if (
      (result.firstRunPostExpectedCount !== 0 &&
        result.firstRunPostExpectedCount !== 1) ||
      result.firstRunPostCount !== result.firstRunPostExpectedCount
    ) {
      throw new Error(
        `iOS cloud onboarding ${mode} expected ${result.firstRunPostExpectedCount} /api/first-run POSTs for the selected backend, got ${result.firstRunPostCount}`,
      );
    }
    if (mode === "tap" && result.signInGreetingVisible !== true) {
      throw new Error("tap mode did not prove the sign-in greeting");
    }
    if (
      result.permissionPriming?.shown !== true ||
      result.permissionPriming?.skipped !== true ||
      result.permissionPriming?.hidden !== true
    ) {
      throw new Error(
        `iOS Cloud onboarding did not complete permission priming: ${JSON.stringify(result.permissionPriming)}`,
      );
    }
    if (result.notificationRoute?.ok !== true) {
      throw new Error(
        `iOS Cloud notification route failed: ${JSON.stringify(result.notificationRoute)}`,
      );
    }
    if (result.visual?.ready !== true) {
      throw new Error(
        `iOS Cloud home did not reach visual readiness: ${JSON.stringify(result.visual)}`,
      );
    }
    if (
      result.visual.notificationState !== "count" &&
      result.visual.notificationState !== "empty"
    ) {
      throw new Error(
        `iOS Cloud home lacked a healthy notification state after onboarding: ${JSON.stringify(result.visual.notificationState)}`,
      );
    }
    if (liveness) {
      const reply = assertLiveReply(result.livenessReply, {
        label: `ios-cloud-onboarding-${mode}`,
      });
      if (
        result.livenessExpectedReply !== livenessExpectedReply ||
        reply !== livenessExpectedReply
      ) {
        throw new Error(
          `iOS Cloud liveness reply was not correlated to run ${runId}: expected ${livenessExpectedReply}, got ${JSON.stringify(reply)}`,
        );
      }
      log(`liveness reply OK: ${JSON.stringify(result.livenessReply)}`);
    }

    await waitForRequestConsumption(udid, appId);

    const onboardingVideoPath = await recording?.stop();
    recording = null;
    if (onboardingVideoPath) log(`video: ${onboardingVideoPath}`);
    const homeScreenshot = takeScreenshot(udid, artifactDir, `${mode}-home`);
    const apiBase = activeCloudApiBase(result);
    defaultsWriteString(
      udid,
      appId,
      RELAUNCH_REQUEST_KEY,
      JSON.stringify({ apiBase, runId }),
    );
    defaultsWriteString(
      udid,
      appId,
      RELAUNCH_RESULT_KEY,
      JSON.stringify({
        ok: false,
        phase: "requested",
        apiBase,
        runId,
        updatedAt: new Date().toISOString(),
      }),
    );
    flushPreferences(udid);
    relaunchRecording = startVideo(udid, artifactDir, `${mode}-cold-relaunch`);
    log(`terminating ${appId} for ${mode} cold relaunch proof`);
    simctl(["terminate", udid, appId]);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    log(`relaunching ${appId} for ${mode} cold relaunch proof`);
    simctl(["launch", udid, appId]);
    const coldRelaunch = await pollRelaunchResult(udid, appId, runId);
    if (
      coldRelaunch.homeVisible !== true ||
      coldRelaunch.composerVisible !== true ||
      coldRelaunch.onboardingHidden !== true ||
      coldRelaunch.permissionPrimingHidden !== true ||
      coldRelaunch.runtime?.startupPhase !== "ready" ||
      coldRelaunch.runtime?.agentState !== "running" ||
      coldRelaunch.runtime?.connected !== true ||
      coldRelaunch.notificationRoute?.ok !== true ||
      coldRelaunch.visual?.ready !== true ||
      (coldRelaunch.visual?.notificationState !== "count" &&
        coldRelaunch.visual?.notificationState !== "empty")
    ) {
      throw new Error(
        `iOS Cloud cold relaunch lacked a clean home: ${JSON.stringify(coldRelaunch)}`,
      );
    }
    fs.writeFileSync(
      path.join(artifactDir, "result.json"),
      `${JSON.stringify(
        {
          ...result,
          homeScreenshot,
          coldRelaunch,
        },
        null,
        2,
      )}\n`,
    );
    completionCaptureLabel = `${mode}-cold-relaunch-home`;
    log(`${mode} PASS`);
  } finally {
    try {
      const onboardingVideoPath = await recording?.stop();
      if (onboardingVideoPath) log(`video: ${onboardingVideoPath}`);
      const relaunchVideoPath = await relaunchRecording?.stop();
      if (relaunchVideoPath) log(`video: ${relaunchVideoPath}`);
      if (relaunchRecording) {
        // CoreSimulator briefly presents a black framebuffer after screen
        // recording stops even though the WebView remains fully rendered.
        await new Promise((resolve) =>
          setTimeout(resolve, IOS_SIMULATOR_CAPTURE_SETTLE_MS),
        );
      }
    } finally {
      // Simulator video recording and still capture can contend for the same
      // framebuffer; stopping first makes the final proof deterministic.
      takeScreenshot(udid, artifactDir, completionCaptureLabel);
    }
  }
}

export async function main() {
  if (process.env.ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE !== "1") {
    throw new Error(
      "Set ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE=1 to run against real Eliza Cloud.",
    );
  }
  const modes = modesToRun();
  const { appId } = readAppIdentity();
  const udid = ensureSimulatorBooted();
  fs.rmSync(resultRoot, { force: true, recursive: true });
  fs.mkdirSync(resultRoot, { recursive: true });
  const privateKey = e2eWalletPrivateKey();
  for (const mode of modes) {
    await runMode({ udid, appId, mode, privateKey });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
