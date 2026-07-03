#!/usr/bin/env node
/**
 * #11373 — iOS device AEC acoustic-loop driver.
 *
 * Web Inspector cannot be enabled tap-free on the target device, so this
 * driver uses the committed tap-free path instead of CDP:
 *
 *   1. launches the app (devicectl), waits for boot;
 *   2. opens the `elizaos://aec-loop?...` deep link (devicectl launches the
 *      URL) — the committed `installAecLoopHarness` hash watcher runs the
 *      whole loop on-device (real mic + real speaker + production
 *      /api/voice/* routes into the in-process agent);
 *   3. (double-talk pass) loops near-end speech from the host with `say`;
 *   4. polls-pulls Documents/eliza-aec-loop-result.json from the app data
 *      container (`devicectl device copy from`) and saves it per pass.
 *
 * Usage:
 *   node ios-device-driver.mjs --device <devicectl-id> [--out <dir>]
 *     [--skip-double-talk] [--pass echo-only|double-talk|both]
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const argvArg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DEVICE = argvArg("--device");
const OUT = path.resolve(argvArg("--out") ?? ".");
const PASS = argvArg("--pass") ?? "both";
const BUNDLE_ID = "ai.elizaos.app";
const RESULT_PATH = "Documents/eliza-aec-loop-result.json";
if (!DEVICE) throw new Error("--device <devicectl-id> required");
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[ios-driver] ${m}`);

function devicectl(args, opts = {}) {
  return spawnSync("xcrun", ["devicectl", ...args], {
    encoding: "utf8",
    ...opts,
  });
}

function launchUrl(url) {
  // `process launch <url>` mis-parses the URL as a bundle path; the URL must be
  // handed to the app via --payload-url (LaunchServices openURL), with the app
  // bundle id as the launch target. The app's URL handler (main.tsx) maps
  // elizaos://aec-loop?… onto the #aec-loop hash the harness watches.
  const res = devicectl([
    "device",
    "process",
    "launch",
    "--device",
    DEVICE,
    "--payload-url",
    url,
    BUNDLE_ID,
  ]);
  if (res.status !== 0) {
    throw new Error(`deep link launch failed: ${res.stderr || res.stdout}`);
  }
}

function pullResult(dest) {
  rmSync(dest, { force: true });
  const res = devicectl([
    "device",
    "copy",
    "from",
    "--device",
    DEVICE,
    "--domain-type",
    "appDataContainer",
    "--domain-identifier",
    BUNDLE_ID,
    "--source",
    RESULT_PATH,
    "--destination",
    dest,
  ]);
  return res.status === 0 && existsSync(dest);
}

async function runPass({ tag, doubleTalk }) {
  log(`pass "${tag}": clearing any previous result`);
  // Overwrite marker: pull whatever exists now; the pass is done when the
  // pulled file's tag matches this pass.
  const dest = path.join(OUT, `aec-loop-result-${tag}.json`);

  const params = new URLSearchParams({
    tag,
    maxSeconds: "30",
    warmupMs: "1500",
    tailMs: "2000",
  });
  const url = `elizaos://aec-loop?${params.toString()}`;
  log(`pass "${tag}": opening ${url}`);
  launchUrl(url);

  let sayLoop = null;
  let sayStop = false;
  if (doubleTalk) {
    // Near-end speech from the host, looped so it overlaps the TTS whenever
    // the on-device pass reaches playback (TTS synth time varies on-device).
    log(`pass "${tag}": looping near-end host speech (say)`);
    sayLoop = (async () => {
      while (!sayStop) {
        await new Promise((resolve) => {
          const p = spawn(
            "say",
            [
              "-r",
              "180",
              "This is the near end talker. Sphinx of black quartz, judge my vow.",
            ],
            { stdio: "ignore" },
          );
          p.on("exit", resolve);
        });
        await new Promise((r) => setTimeout(r, 700));
      }
    })();
  }

  const deadline = Date.now() + 6 * 60_000;
  const tmp = path.join(OUT, `.pull-${tag}.json`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    if (pullResult(tmp)) {
      try {
        const parsed = JSON.parse(
          execFileSync("cat", [tmp], { encoding: "utf8" }),
        );
        if (parsed.tag === tag) {
          renameSync(tmp, dest);
          sayStop = true;
          if (sayLoop) await sayLoop;
          if (parsed.error) {
            throw new Error(`pass "${tag}" harness error: ${parsed.error}`);
          }
          log(
            `pass "${tag}": done — micFrames=${parsed.micFramesSent} playFrames=${parsed.playFramesSent} counters=${JSON.stringify(parsed.statusAfter?.aec ?? {})}`,
          );
          return dest;
        }
      } catch (err) {
        if (String(err).includes("harness error")) {
          sayStop = true;
          if (sayLoop) await sayLoop;
          throw err;
        }
        // Partial/old file — keep polling.
      }
    }
    if (Date.now() > deadline) {
      sayStop = true;
      if (sayLoop) await sayLoop;
      throw new Error(`pass "${tag}" timed out waiting for the result file`);
    }
  }
}

log("launching app for boot");
const launch = devicectl([
  "device",
  "process",
  "launch",
  "--terminate-existing",
  "--device",
  DEVICE,
  BUNDLE_ID,
]);
if (launch.status !== 0) {
  throw new Error(`app launch failed: ${launch.stderr || launch.stdout}`);
}
log("waiting 20s for boot before the deep link");
await new Promise((r) => setTimeout(r, 20_000));

if (PASS === "both" || PASS === "echo-only") {
  await runPass({ tag: "echo-only", doubleTalk: false });
}
if (PASS === "both" || PASS === "double-talk") {
  await runPass({ tag: "double-talk", doubleTalk: true });
}
log("all passes complete");
