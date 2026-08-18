#!/usr/bin/env node
/**
 * iOS Simulator voice round-trip lane (#13688). WKWebView is not CDP-drivable,
 * so this mirrors ios-attachment-smoke: seed Capacitor Preferences, launch the
 * installed app, let the in-app onboarding verifier connect it to a real host
 * agent, then let the in-app voice verifier drive the SAME production
 * `runVoiceSelfTest` harness — bundled speech clip ("what time is it") -> real
 * on-device/local ASR -> real agent over SSE -> real TTS decode+playback — and
 * report the machine-readable per-stage verdict back through Preferences.
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
  evaluateVoiceSelfTestReport,
  resolveVoiceSelfTestPollPolicy,
} from "./ios-voice-selftest-lib.mjs";
import { startDeviceE2eHostAgent } from "./lib/host-agent.mjs";
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

async function pollResult(udid, appId, { attempts, delayMs }) {
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
        return parsed;
      }
      if (parsed?.error) return parsed;
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
  // Validate poll knobs before simulator boot or host-agent spawn so a typo
  // cannot silently shrink the Preferences wait budget via partial parseInt.
  const pollPolicy = resolveVoiceSelfTestPollPolicy({ env: process.env });

  const { appId } = readAppIdentity();
  let apiBase = val("--api-base");
  const udid = ensureSimulatorBooted();
  removePathRecursive(resultDir);
  fs.mkdirSync(resultDir, { recursive: true });
  const hostAgent = apiBase
    ? null
    : await startDeviceE2eHostAgent({
        repoRoot,
        artifactDir: resultDir,
        requestedPort:
          val("--host-agent-port") ?? process.env.ELIZA_IOS_HOST_AGENT_PORT,
        log,
      });
  apiBase = apiBase ?? hostAgent.apiBase;
  let recording = null;

  try {
    clearState(udid, appId);
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
      VOICE_REQUEST_KEY,
      JSON.stringify({ apiBase }),
    );
    defaultsWriteString(
      udid,
      appId,
      VOICE_RESULT_KEY,
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
    takeScreenshot(udid, "fresh-launch");
    log(
      `armed in-app first-run remote connect + voice self-test for ${apiBase}`,
    );

    const result = await pollResult(udid, appId, pollPolicy);
    const screenshot = takeScreenshot(udid, "voice-selftest-result");
    const video = await stopVideo(recording);

    fs.writeFileSync(
      path.join(resultDir, "result.json"),
      `${JSON.stringify({ ...result, screenshot, video }, null, 2)}\n`,
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
