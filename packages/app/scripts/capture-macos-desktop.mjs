#!/usr/bin/env node
// macOS desktop evidence capture: screenshot + best-effort screen recording +
// backend log for headed Electrobun/manual voice runs. Skips cleanly on
// non-macOS hosts; ffmpeg is resolved or installed before recording.
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

const PLATFORM = "macos-desktop";
const log = logFor(PLATFORM);

function hasCommand(name) {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}

function captureScreenshot(outPath) {
  const res = spawnSync("screencapture", ["-x", outPath], { stdio: "ignore" });
  return res.status === 0 && existsSync(outPath);
}

function recordVideo(ffmpeg, outPath, durationSec) {
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpeg,
      [
        "-y",
        "-f",
        "avfoundation",
        "-framerate",
        "15",
        "-capture_cursor",
        "1",
        "-i",
        "Capture screen 0:none",
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
  if (process.platform !== "darwin") {
    skip(
      PLATFORM,
      `macos-desktop capture requires a macOS host (host is ${process.platform})`,
    );
  }
  if (!hasCommand("screencapture")) {
    skip(PLATFORM, "screencapture not found");
  }
  const ffmpeg = resolveRequiredFfmpeg({ log });

  const flags = parseFlags();
  const base = evidenceBaseName({
    issue: flags.issue,
    slug: flags.slug,
    platform: PLATFORM,
  });
  const durationSec = Number(flags.duration ?? 6);

  const pngPath = evidencePath(base, "png");
  if (captureScreenshot(pngPath)) {
    log(`screenshot -> ${pngPath} (${statSync(pngPath).size} bytes)`);
  } else {
    log("screenshot failed (screen capture permission may be missing)");
  }

  const mp4Path = evidencePath(base, "mp4");
  log(`recording ${durationSec}s -> ${mp4Path}`);
  const recorded = await recordVideo(ffmpeg, mp4Path, durationSec);
  log(
    recorded
      ? `recording -> ${mp4Path} (${statSync(mp4Path).size} bytes)`
      : "recording skipped or failed (ffmpeg avfoundation screen input unavailable)",
  );

  const infoPath = evidencePath(base, "log");
  writeFileSync(
    infoPath,
    `[capture:${PLATFORM}] host=${process.platform}\n` +
      `screencapture=${hasCommand("screencapture") ? "present" : "missing"}\n` +
      `ffmpeg=${spawnSync(ffmpeg, ["-version"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? "missing"}\n`,
    "utf8",
  );
  log(`info log -> ${infoPath}`);
  const backendLog = captureBackendLog(base);
  if (backendLog) log(`backend log -> ${backendLog}`);

  mirrorToRecordings(PLATFORM, pngPath);
  if (recorded) mirrorToRecordings(PLATFORM, mp4Path);
  log("done");
}

main().catch((error) => {
  console.error(`[capture:${PLATFORM}] failed: ${error.message}`);
  process.exit(1);
});
