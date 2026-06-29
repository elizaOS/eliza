#!/usr/bin/env node
// iOS Simulator evidence capture (issue #9944).
//
// Produces three real artifacts from a booted iOS Simulator:
//   <evidence>/ios/screen.png    xcrun simctl io booted screenshot
//   <evidence>/ios/screen.mov    xcrun simctl io booted recordVideo
//   <evidence>/ios/simctl.log    xcrun simctl spawn booted log show (tail)
// Skips with a reason (clean exit) on non-macOS hosts, when xcrun is missing,
// or when no simulator is booted. On this Linux host it skips by design.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ISSUE,
  DEFAULT_SECONDS,
  DEFAULT_SLUG,
  evidenceDir,
  isMain,
  makeLogger,
  parseArgs,
  reportAndExit,
  skipped,
  sleep,
} from "./common.mjs";

const CLASS = "IosCapture";

function bootedSimulatorUdid() {
  const result = spawnSync("xcrun", ["simctl", "list", "devices", "booted"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return null;
  // Lines look like: "    iPhone 15 (UDID) (Booted)"
  const match = result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/\(([0-9A-Fa-f-]{36})\)\s*\(Booted\)/))
    .find(Boolean);
  return match ? match[1] : null;
}

/**
 * Capture a screenshot, a short recording, and a log tail from a booted iOS
 * Simulator.
 *
 * @returns {Promise<{className:string, skipped:boolean, reason?:string,
 *   artifacts:{screenshot?:string, video?:string, log?:string}, error?:string}>}
 */
export async function captureIos(options = {}) {
  const log = makeLogger(CLASS);
  const issue = options.issue ?? DEFAULT_ISSUE;
  const slug = options.slug ?? DEFAULT_SLUG;
  const seconds = Number(options.seconds ?? DEFAULT_SECONDS);

  if (process.platform !== "darwin") {
    return skipped(
      CLASS,
      `iOS Simulator requires macOS (host is ${process.platform})`,
    );
  }

  const xcrun = spawnSync("xcrun", ["--version"], { stdio: "ignore" });
  if (xcrun.status !== 0) {
    return skipped(CLASS, "xcrun not found (install Xcode command line tools)");
  }

  const udid = options.udid ?? bootedSimulatorUdid();
  if (!udid) {
    return skipped(
      CLASS,
      "no booted iOS Simulator (boot one with `xcrun simctl boot <udid>`)",
    );
  }
  log(`using booted simulator ${udid}`);

  const outDir = evidenceDir({
    issue,
    slug,
    platform: "ios",
    out: options.out,
  });
  const screenshotPath = path.join(outDir, "screen.png");
  const videoPath = path.join(outDir, "screen.mov");
  const logPath = path.join(outDir, "simctl.log");

  // ── Screenshot ─────────────────────────────────────────────────────────
  log("capturing screenshot via simctl io screenshot");
  const shot = spawnSync(
    "xcrun",
    ["simctl", "io", udid, "screenshot", screenshotPath],
    { encoding: "utf8" },
  );
  if (shot.status !== 0) {
    return {
      className: CLASS,
      skipped: false,
      artifacts: {},
      error: `simctl screenshot failed: ${shot.stderr ?? shot.status}`,
    };
  }

  // ── Screen recording ───────────────────────────────────────────────────
  log(`recording screen for ~${seconds}s`);
  const recorder = spawn(
    "xcrun",
    [
      "simctl",
      "io",
      udid,
      "recordVideo",
      "--codec",
      "h264",
      "--force",
      videoPath,
    ],
    { stdio: "ignore" },
  );
  await sleep(seconds * 1000);
  // simctl writes a valid moov atom only on a clean SIGINT.
  recorder.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => recorder.once("close", resolve)),
    sleep(5000),
  ]);
  const videoOk = fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0;

  // ── Simulator log tail ─────────────────────────────────────────────────
  log("capturing simulator log tail");
  const logShow = spawnSync(
    "xcrun",
    [
      "simctl",
      "spawn",
      udid,
      "log",
      "show",
      "--style",
      "compact",
      "--last",
      `${Math.max(seconds + 5, 10)}s`,
    ],
    { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
  );
  fs.writeFileSync(
    logPath,
    `# xcrun simctl spawn ${udid} log show — ${new Date().toISOString()}\n` +
      (logShow.stdout ?? logShow.stderr ?? ""),
  );

  return {
    className: CLASS,
    skipped: false,
    artifacts: {
      screenshot: screenshotPath,
      video: videoOk ? videoPath : undefined,
      log: logPath,
    },
  };
}

if (isMain(import.meta.url)) {
  const flags = parseArgs(process.argv.slice(2));
  captureIos(flags)
    .then(reportAndExit)
    .catch((error) => {
      console.error(`[${CLASS}] fatal: ${error.stack || error}`);
      process.exit(1);
    });
}
