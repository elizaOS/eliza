#!/usr/bin/env node
// iOS Simulator validation for the native-transcript demo: proves the chat-UI
// harness actually pushes transcript frames over the NativeTranscript
// Capacitor plugin on a real simulator, by relaunching the installed harness
// app with its console attached (`simctl launch --console-pty` — the sim
// analog of the devicectl --console technique in ios-device-logs.mjs) and
// watching for Capacitor's bridge log line:
//
//   ⚡️  To Native ->  NativeTranscript setTranscript <callbackId>
//
// Exit 0 when the call appears (screenshot captured for eyeballing), non-zero
// when it never does within the timeout.
//
//   node scripts/ios-native-transcript-check.mjs                 # build + install + check
//   node scripts/ios-native-transcript-check.mjs -- --skip-build # reuse the last build
//   flags: --skip-build  --app-path <App.app>  --timeout <seconds>
//
// Flag seeding — why the build-time define: the harness demo gate honors
// localStorage["eliza:native-transcript-demo"]==="1" OR the Vite define
// __ELIZA_NATIVE_TRANSCRIPT_DEMO__ (env ELIZA_NATIVE_TRANSCRIPT_DEMO=1).
// `xcrun simctl spawn booted defaults write …` writes NSUserDefaults, which
// WKWebView localStorage NEVER reads, so a host cannot seed the runtime flag
// on a simulator. This script therefore builds the harness with
// ELIZA_NATIVE_TRANSCRIPT_DEMO=1 so the flag is baked into the bundle. The
// manual alternative on an already-installed build is Safari → Develop →
// Simulator → <app webview> → console:
//   localStorage.setItem("eliza:native-transcript-demo", "1")
// then relaunch the app.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = path.resolve(appDir, "..", "..");
const resultDir = path.join(
  appDir,
  "test-results",
  "ios-native-transcript-check",
);

const SET_TRANSCRIPT_MARKER =
  /To Native\s*->\s*NativeTranscript\s+setTranscript/;
const AVAILABILITY_MARKER = /To Native\s*->\s*NativeTranscript\s+isAvailable/;
const SIM_DEVICE_NAME = process.env.ELIZA_IOS_SIM_DEVICE || "iPhone 17 Pro";

const has = (flag) => process.argv.includes(flag);
const val = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
};
const log = (message) =>
  console.log(`[ios-native-transcript-check] ${message}`);
const fail = (message, code = 1) => {
  console.error(`[ios-native-transcript-check] FAIL: ${message}`);
  process.exit(code);
};

const bundleId = process.env.ELIZA_IOS_APP_ID || "ai.elizaos.app";
const derivedData =
  process.env.ELIZA_IOS_DERIVED_DATA_PATH ||
  path.join(
    os.homedir(),
    "Library/Developer/Xcode/DerivedData/eliza-chat-harness",
  );
const timeoutSeconds = Number(val("--timeout", "150"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "signal"}): ${
        result.stderr || result.stdout || ""
      }`,
    );
  }
  return result.stdout ?? "";
}

function tryRun(command, args) {
  spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
}

function listDevices(filter) {
  const raw = run("xcrun", ["simctl", "list", "devices", filter, "--json"]);
  return Object.values(JSON.parse(raw).devices).flat();
}

function resolveBootedUdid() {
  const booted = listDevices("booted").find((d) => d.state === "Booted");
  if (booted) return booted.udid;
  const target = listDevices("available").find(
    (d) => d.name === SIM_DEVICE_NAME,
  );
  if (!target) {
    fail(
      `no booted simulator and no available "${SIM_DEVICE_NAME}" to boot (override with ELIZA_IOS_SIM_DEVICE)`,
      2,
    );
  }
  log(`booting ${SIM_DEVICE_NAME} (${target.udid})…`);
  run("xcrun", ["simctl", "boot", target.udid]);
  run("xcrun", ["simctl", "bootstatus", target.udid, "-b"]);
  return target.udid;
}

function resolveAppPath() {
  const explicit = val("--app-path");
  if (explicit) {
    if (!fs.existsSync(explicit)) fail(`--app-path not found: ${explicit}`, 2);
    return explicit;
  }
  const primary = path.join(
    derivedData,
    "Build/Products/Debug-iphonesimulator/App.app",
  );
  if (fs.existsSync(primary)) return primary;
  // Fall back to the newest App.app in default DerivedData (pre-script builds).
  const ddRoot = path.join(os.homedir(), "Library/Developer/Xcode/DerivedData");
  const candidates = fs.existsSync(ddRoot)
    ? fs
        .readdirSync(ddRoot)
        .filter((name) => name.startsWith("App-"))
        .map((name) =>
          path.join(
            ddRoot,
            name,
            "Build/Products/Debug-iphonesimulator/App.app",
          ),
        )
        .filter((p) => fs.existsSync(p))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  if (candidates.length === 0) {
    fail("no built App.app found — run without --skip-build", 2);
  }
  return candidates[0];
}

function screenshot(udid, name) {
  fs.mkdirSync(resultDir, { recursive: true });
  const file = path.join(resultDir, `${name}-${Date.now()}.png`);
  try {
    run("xcrun", ["simctl", "io", udid, "screenshot", file]);
    log(`screenshot: ${file}`);
  } catch (error) {
    log(`screenshot failed: ${error.message}`);
  }
  return file;
}

if (os.platform() !== "darwin") {
  fail("requires macOS with xcrun simctl", 2);
}

if (!has("--skip-build")) {
  log(
    "building the chat-UI harness with the demo flag baked in (ELIZA_CHAT_UI_HARNESS=1 + ELIZA_NATIVE_TRANSCRIPT_DEMO=1)…",
  );
  const build = spawnSync("bun", ["run", "build:ios:chat-harness"], {
    cwd: appDir,
    stdio: "inherit",
    env: {
      ...process.env,
      ELIZA_NATIVE_TRANSCRIPT_DEMO: "1",
      // When this checkout is nested inside an outer monorepo, pin the mobile
      // build's repo-root walk to THIS checkout (see ios-chat-harness-preview.sh).
      ELIZA_MOBILE_REPO_ROOT: repoRoot,
      ELIZA_IOS_DERIVED_DATA_PATH: derivedData,
    },
  });
  if (build.status !== 0) fail("build:ios:chat-harness failed", 2);
}

const appPath = resolveAppPath();
const udid = resolveBootedUdid();
tryRun("open", ["-a", "Simulator"]);

log(`installing ${appPath}`);
run("xcrun", ["simctl", "install", udid, appPath]);
tryRun("xcrun", ["simctl", "terminate", udid, bundleId]);

log(
  `launching ${bundleId} with console attached; waiting up to ${timeoutSeconds}s for "To Native -> NativeTranscript setTranscript"…`,
);
const consoleLogPath = path.join(resultDir, `console-${Date.now()}.log`);
fs.mkdirSync(resultDir, { recursive: true });
const consoleLog = fs.createWriteStream(consoleLogPath);
const child = spawn(
  "xcrun",
  ["simctl", "launch", "--console-pty", udid, bundleId],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let sawSetTranscript = false;
let sawAvailabilityProbe = false;
let buffered = "";

function finish(code, summary) {
  consoleLog.end();
  // Killing the pty holder tears the launched app down with it; the
  // screenshot is already on disk, and the app relaunches fine from the sim.
  child.kill("SIGTERM");
  log(`console log: ${consoleLogPath}`);
  log(summary);
  process.exit(code);
}

const timeout = setTimeout(() => {
  screenshot(udid, "native-transcript-timeout");
  const hint = sawAvailabilityProbe
    ? "the harness probed NativeTranscript isAvailable but never called setTranscript — the plugin likely answered unavailable (native side not registered in this build?)"
    : "no NativeTranscript bridge traffic at all — was the app built with ELIZA_NATIVE_TRANSCRIPT_DEMO=1 (and ELIZA_CHAT_UI_HARNESS=1)?";
  finish(1, `setTranscript never appeared within ${timeoutSeconds}s. ${hint}`);
}, timeoutSeconds * 1000);

function scan(chunk) {
  consoleLog.write(chunk);
  buffered += chunk.toString();
  // Keep only the tail; markers never span more than one log line.
  if (buffered.length > 65536) buffered = buffered.slice(-16384);
  if (AVAILABILITY_MARKER.test(buffered)) sawAvailabilityProbe = true;
  if (!sawSetTranscript && SET_TRANSCRIPT_MARKER.test(buffered)) {
    sawSetTranscript = true;
    clearTimeout(timeout);
    // Give the native list a beat to paint before the evidence screenshot.
    setTimeout(() => {
      screenshot(udid, "native-transcript-live");
      finish(
        0,
        "OK: NativeTranscript setTranscript observed over the Capacitor bridge",
      );
    }, 2500);
  }
}

child.stdout.on("data", scan);
child.stderr.on("data", scan);
child.on("exit", (code) => {
  if (sawSetTranscript) return;
  clearTimeout(timeout);
  screenshot(udid, "native-transcript-early-exit");
  finish(
    1,
    `console process exited early (code ${code}) before setTranscript appeared`,
  );
});
