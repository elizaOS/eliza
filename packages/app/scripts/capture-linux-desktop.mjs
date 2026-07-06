#!/usr/bin/env node
// Linux desktop capture (issue #9944): screenshot + screen recording + an info
// log of the headed X11 desktop (incl. the Electrobun window), written to the
// generated capture-output directory.
// Skips with a reason (exit 0) when no X display exists; ffmpeg is a required
// capture dependency and is resolved or installed before recording.
//
// Usage (from packages/app):
//   bun run capture:linux-desktop -- --issue <n> --slug <s> [--duration <sec>]
//   --issue <n> --slug <s>   name artifacts `<n>-<s>-linux-desktop.{png,mp4,log}`
//   --duration <seconds>     recording length (default 6)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import {
  captureBackendLog,
  evidenceBaseName,
  evidencePath,
  logFor,
  mirrorToRecordings,
  parseFlags,
  skip,
} from "./lib/capture-output.mjs";
import { resolveRequiredFfmpeg } from "./lib/ffmpeg.mjs";

const PLATFORM = "linux-desktop";
const log = logFor(PLATFORM);

/** Screen geometry from xdpyinfo, else a safe 1920x1080 default. */
function screenSize(display) {
  const res = spawnSync("xdpyinfo", [], {
    env: { ...process.env, DISPLAY: display },
    encoding: "utf8",
  });
  const m = res.stdout?.match(/dimensions:\s+(\d+)x(\d+)/);
  return m ? `${m[1]}x${m[2]}` : "1920x1080";
}

function captureScreenshot(ffmpeg, display, size, outPath) {
  const res = spawnSync(
    ffmpeg,
    [
      "-y",
      "-f",
      "x11grab",
      "-video_size",
      size,
      "-i",
      display,
      "-frames:v",
      "1",
      outPath,
    ],
    { stdio: "ignore" },
  );
  return res.status === 0 && existsSync(outPath);
}

function recordVideo(ffmpeg, display, size, outPath, durationSec) {
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpeg,
      [
        "-y",
        "-f",
        "x11grab",
        "-framerate",
        "15",
        "-video_size",
        size,
        "-i",
        display,
        "-t",
        String(durationSec),
        "-pix_fmt",
        "yuv420p",
        outPath,
      ],
      { stdio: "ignore" },
    );
    proc.on("close", () => resolve(existsSync(outPath)));
    proc.on("error", () => resolve(false));
  });
}

async function main() {
  if (process.platform !== "linux") {
    skip(
      PLATFORM,
      `linux-desktop capture requires a linux host (host is ${process.platform})`,
    );
  }
  const display = process.env.DISPLAY;
  if (!display) {
    skip(PLATFORM, "no $DISPLAY (headless host — no X11 desktop to capture)");
  }
  const ffmpeg = resolveRequiredFfmpeg({ log });

  const flags = parseFlags();
  const base = evidenceBaseName({
    issue: flags.issue,
    slug: flags.slug,
    platform: PLATFORM,
  });
  const durationSec = Number(flags.duration ?? 6);
  const size = screenSize(display);
  log(`capturing X11 desktop ${display} @ ${size}`);

  const pngPath = evidencePath(base, "png");
  if (captureScreenshot(ffmpeg, display, size, pngPath)) {
    log(`screenshot → ${pngPath} (${statSync(pngPath).size} bytes)`);
  } else {
    log("screenshot failed (no file written)");
  }

  const mp4Path = evidencePath(base, "mp4");
  log(`recording ${durationSec}s → ${mp4Path}`);
  const recorded = await recordVideo(
    ffmpeg,
    display,
    size,
    mp4Path,
    durationSec,
  );
  log(
    recorded
      ? `recording → ${mp4Path} (${statSync(mp4Path).size} bytes)`
      : "recording produced no file",
  );

  const infoPath = evidencePath(base, "log");
  writeFileSync(
    infoPath,
    `[capture:${PLATFORM}] host=${process.platform} display=${display} size=${size}\n` +
      `ffmpeg=${spawnSync(ffmpeg, ["-version"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? "?"}\n`,
    "utf8",
  );
  log(`info log → ${infoPath}`);
  const backendLog = captureBackendLog(base);
  if (backendLog) log(`backend log → ${backendLog}`);

  mirrorToRecordings(PLATFORM, pngPath);
  if (recorded) mirrorToRecordings(PLATFORM, mp4Path);
  log("done");
}

main();
