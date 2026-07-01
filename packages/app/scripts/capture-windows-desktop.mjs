#!/usr/bin/env node
// Windows desktop evidence capture (issue #9944): screenshot + screen recording
// + an info log of the headed desktop (incl. the Electrobun window) via ffmpeg
// `gdigrab`, written to `.github/issue-evidence/`.
// Skips with a reason (exit 0) when not on Windows or ffmpeg is missing — so a
// non-Windows CI run is a clean no-op.
//
// Usage (from packages/app):
//   bun run capture:windows-desktop -- --issue <n> --slug <s> [--duration <sec>]
//   --issue <n> --slug <s>   name artifacts `<n>-<s>-windows-desktop.{png,mp4,log}`
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
} from "./lib/issue-evidence.mjs";

const PLATFORM = "windows-desktop";
const log = logFor(PLATFORM);

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

function captureScreenshot(outPath) {
  const res = spawnSync(
    "ffmpeg",
    ["-y", "-f", "gdigrab", "-i", "desktop", "-frames:v", "1", outPath],
    { stdio: "ignore" },
  );
  return res.status === 0 && existsSync(outPath);
}

function recordVideo(outPath, durationSec) {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "gdigrab",
        "-framerate",
        "15",
        "-i",
        "desktop",
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
  if (process.platform !== "win32") {
    skip(
      PLATFORM,
      `windows-desktop capture requires a windows host (host is ${process.platform})`,
    );
  }
  if (!hasFfmpeg()) {
    skip(PLATFORM, "ffmpeg not found (install ffmpeg for gdigrab capture)");
  }

  const flags = parseFlags();
  const base = evidenceBaseName({
    issue: flags.issue,
    slug: flags.slug,
    platform: PLATFORM,
  });
  const durationSec = Number(flags.duration ?? 6);
  log("capturing windows desktop via gdigrab");

  const pngPath = evidencePath(base, "png");
  if (captureScreenshot(pngPath)) {
    log(`screenshot → ${pngPath} (${statSync(pngPath).size} bytes)`);
  } else {
    log("screenshot failed (no file written)");
  }

  const mp4Path = evidencePath(base, "mp4");
  log(`recording ${durationSec}s → ${mp4Path}`);
  const recorded = await recordVideo(mp4Path, durationSec);
  log(
    recorded
      ? `recording → ${mp4Path} (${statSync(mp4Path).size} bytes)`
      : "recording produced no file",
  );

  const infoPath = evidencePath(base, "log");
  writeFileSync(
    infoPath,
    `[capture:${PLATFORM}] host=${process.platform}\n` +
      `ffmpeg=${spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? "?"}\n`,
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
