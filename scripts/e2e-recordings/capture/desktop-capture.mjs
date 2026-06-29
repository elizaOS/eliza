#!/usr/bin/env node
// Desktop (Linux / Windows) evidence capture (issue #9944).
//
// Uses ffmpeg's native screen grabbers — x11grab on Linux, gdigrab on Windows —
// to produce three real artifacts:
//   <evidence>/<platform>/screen.png   single-frame screenshot
//   <evidence>/<platform>/screen.mp4   short screen recording
//   <evidence>/<platform>/desktop.log  host/display info + ffmpeg stderr
// where <platform> is "linux" or "windows". Skips with a reason (clean exit)
// on unsupported platforms, when ffmpeg is missing, or (Linux) when $DISPLAY is
// unset / no X server is reachable. macOS desktop capture is the iOS/simctl
// path's sibling and is intentionally out of scope here.
import { spawnSync } from "node:child_process";
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
} from "./common.mjs";

const CLASS = "DesktopCapture";

function ffmpegAvailable() {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

/** Resolve "<W>x<H>" for the primary X display, or null if undetectable. */
function linuxScreenSize() {
  const xrandr = spawnSync("xrandr", [], { encoding: "utf8" });
  if (xrandr.status === 0 && xrandr.stdout) {
    const match = xrandr.stdout.match(/\b(\d{3,5})x(\d{3,5})\+\d+\+\d+/);
    if (match) return `${match[1]}x${match[2]}`;
  }
  const xdpy = spawnSync("xdpyinfo", [], { encoding: "utf8" });
  if (xdpy.status === 0 && xdpy.stdout) {
    const match = xdpy.stdout.match(/dimensions:\s+(\d{3,5})x(\d{3,5})/);
    if (match) return `${match[1]}x${match[2]}`;
  }
  return null;
}

function xServerReachable() {
  return spawnSync("xdpyinfo", [], { stdio: "ignore" }).status === 0;
}

/**
 * Capture a screenshot, a short recording, and an info/ffmpeg log from the
 * Linux or Windows desktop.
 *
 * @returns {Promise<{className:string, skipped:boolean, reason?:string,
 *   artifacts:{screenshot?:string, video?:string, log?:string}, error?:string}>}
 */
export async function captureDesktop(options = {}) {
  const log = makeLogger(CLASS);
  const issue = options.issue ?? DEFAULT_ISSUE;
  const slug = options.slug ?? DEFAULT_SLUG;
  const seconds = Number(options.seconds ?? DEFAULT_SECONDS);

  const platform = process.platform; // "linux" | "win32" | "darwin" | …
  if (platform !== "linux" && platform !== "win32") {
    return skipped(
      CLASS,
      `desktop capture supports linux/windows only (host is ${platform})`,
    );
  }
  // A named target (capture:linux / capture:windows) only runs on its own host
  // OS; on a foreign host it skips with a reason instead of grabbing the wrong
  // desktop (e.g. `capture:windows` on Linux).
  const target = options.target;
  if (target) {
    const wantPlatform = target === "windows" ? "win32" : "linux";
    if (platform !== wantPlatform) {
      return skipped(
        CLASS,
        `${target}-desktop capture requires a ${target} host (host is ${platform})`,
      );
    }
  }
  if (!ffmpegAvailable()) {
    return skipped(CLASS, "ffmpeg not found on PATH");
  }

  let inputFormat;
  let inputSpec;
  let videoSize = null;
  let platformDir;

  if (platform === "linux") {
    const display = process.env.DISPLAY;
    if (!display) {
      return skipped(CLASS, "$DISPLAY is unset (no X session to capture)");
    }
    if (!xServerReachable()) {
      return skipped(CLASS, `X server on DISPLAY=${display} not reachable`);
    }
    inputFormat = "x11grab";
    inputSpec = display;
    videoSize = linuxScreenSize();
    platformDir = "linux";
    log(`capturing X display ${display}${videoSize ? ` @ ${videoSize}` : ""}`);
  } else {
    inputFormat = "gdigrab";
    inputSpec = "desktop";
    platformDir = "windows";
    log("capturing Windows desktop via gdigrab");
  }

  const outDir = evidenceDir({
    issue,
    slug,
    platform: platformDir,
    out: options.out,
  });
  const screenshotPath = path.join(outDir, "screen.png");
  const videoPath = path.join(outDir, "screen.mp4");
  const logPath = path.join(outDir, "desktop.log");

  const sizeArgs = videoSize ? ["-video_size", videoSize] : [];

  // ── Screenshot (single frame) ──────────────────────────────────────────
  log("capturing screenshot frame");
  const shot = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-f",
      inputFormat,
      ...sizeArgs,
      "-i",
      inputSpec,
      "-frames:v",
      "1",
      screenshotPath,
    ],
    { encoding: "utf8" },
  );
  const shotOk =
    fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 0;
  if (!shotOk) {
    return {
      className: CLASS,
      skipped: false,
      artifacts: {},
      error: `ffmpeg screenshot failed: ${(shot.stderr ?? "").split(/\r?\n/).slice(-3).join(" ")}`,
    };
  }
  log(
    `screenshot → ${screenshotPath} (${fs.statSync(screenshotPath).size} bytes)`,
  );

  // ── Screen recording ───────────────────────────────────────────────────
  log(`recording screen for ${seconds}s`);
  const rec = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-f",
      inputFormat,
      "-framerate",
      "15",
      ...sizeArgs,
      "-i",
      inputSpec,
      "-t",
      String(seconds),
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const videoOk = fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0;
  if (videoOk) {
    log(`recording → ${videoPath} (${fs.statSync(videoPath).size} bytes)`);
  } else {
    log("recording produced no file (continuing)");
  }

  // ── Info + ffmpeg log ──────────────────────────────────────────────────
  const info = [
    `# desktop capture — ${new Date().toISOString()}`,
    `platform: ${platform}`,
    `input: -f ${inputFormat} -i ${inputSpec}${videoSize ? ` (video_size ${videoSize})` : ""}`,
    `display: ${process.env.DISPLAY ?? "(n/a)"}`,
    "",
    "## ffmpeg recording stderr",
    rec.stderr ?? "",
  ].join("\n");
  fs.writeFileSync(logPath, info);
  log(`log → ${logPath} (${fs.statSync(logPath).size} bytes)`);

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
  captureDesktop(flags)
    .then(reportAndExit)
    .catch((error) => {
      console.error(`[${CLASS}] fatal: ${error.stack || error}`);
      process.exit(1);
    });
}
