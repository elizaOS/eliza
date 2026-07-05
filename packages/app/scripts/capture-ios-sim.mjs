#!/usr/bin/env node
// iOS-simulator evidence capture (issue #9944): screenshot + screen recording
// + best-effort backend logs from a booted simulator, written to
// `.github/issue-evidence/`. Skips with a reason (exit 0) when not on macOS or
// no simulator is booted, so it is safe inside the e2e-recordings sweep on any
// host. Uses only `xcrun simctl io` — no app build, no Playwright.
//
// Flags:
//   --issue <n> --slug <s>   name artifacts `<n>-<s>-ios-sim.{png,mov,log}`
//   --device <udid>          target a specific booted sim (default: first booted)
//   --duration <seconds>     recording length (default 6)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolveApiPort } from "../../../scripts/e2e-recordings/native-capture-common.mjs";
import {
  captureBackendLog,
  evidenceBaseName,
  evidencePath,
  logFor,
  mirrorToRecordings,
  parseFlags,
  skip,
} from "./lib/issue-evidence.mjs";

const PLATFORM = "ios-sim";
const log = logFor(PLATFORM);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function simctl(args) {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8" });
}

function bootedUdid(requested) {
  try {
    const json = JSON.parse(simctl(["list", "devices", "booted", "--json"]));
    const all = [];
    for (const runtime of Object.values(json.devices ?? {})) {
      for (const device of runtime) {
        if (device.state === "Booted") all.push(device.udid);
      }
    }
    if (requested) return all.includes(requested) ? requested : null;
    return all[0] ?? null;
  } catch {
    return null;
  }
}

async function recordVideo(udid, outPath, durationSec) {
  // simctl finalizes the .mov only on SIGINT; --codec h264 for broad playback
  // (default is hevc), --force overwrites a stale file.
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
      outPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let started = false;
  recorder.stderr.on("data", (chunk) => {
    if (String(chunk).includes("Recording started")) started = true;
  });
  // Wait for the first frame (readiness on stderr) or a short grace period.
  const startDeadline = Date.now() + 5_000;
  while (!started && Date.now() < startDeadline) await delay(200);
  await delay(Math.max(1, durationSec) * 1000);
  recorder.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => recorder.once("close", resolve)),
    delay(5_000),
  ]);
  return existsSync(outPath) ? outPath : null;
}

async function main() {
  const flags = parseFlags();
  if (process.platform !== "darwin") {
    skip(PLATFORM, "not macOS — xcrun simctl unavailable");
  }
  const udid = bootedUdid(flags.device);
  if (!udid) {
    skip(
      PLATFORM,
      "no booted iOS simulator (boot one with `xcrun simctl boot <device>` / open Simulator.app)",
    );
  }
  log(`capturing from booted simulator ${udid}`);

  const base = evidenceBaseName({
    issue: flags.issue,
    slug: flags.slug,
    platform: PLATFORM,
  });
  const durationSec = Number(flags.duration ?? 6);

  const pngPath = evidencePath(base, "png");
  simctl(["io", udid, "screenshot", "--type=png", pngPath]);
  log(`screenshot → ${pngPath} (${statSync(pngPath).size} bytes)`);

  const movPath = evidencePath(base, "mov");
  log(`recording ${durationSec}s → ${movPath}`);
  const recorded = await recordVideo(udid, movPath, durationSec);
  if (recorded) {
    log(`recording → ${movPath} (${statSync(movPath).size} bytes)`);
  } else {
    log("recording produced no file (simulator finalize failed)");
  }

  // Backend-log port: an explicit `--api-port <n>` wins (shared resolver, keeps
  // 31337 as the final fallback); otherwise captureBackendLog keeps resolving
  // from ELIZA_API_PORT / ELIZA_PORT so port-shifted parallel stacks still work.
  const logPath =
    flags["api-port"] !== undefined
      ? captureBackendLog(base, {
          port: resolveApiPort(process.argv.slice(2), process.env),
        })
      : captureBackendLog(base);
  log(
    logPath
      ? `backend log → ${logPath}`
      : "backend log endpoint not reachable (skipped — N/A)",
  );

  mirrorToRecordings(PLATFORM, pngPath);
  if (recorded) mirrorToRecordings(PLATFORM, movPath);

  log("done");
}

main().catch((error) => {
  console.error(`[capture:${PLATFORM}] failed: ${error.message}`);
  process.exit(1);
});
