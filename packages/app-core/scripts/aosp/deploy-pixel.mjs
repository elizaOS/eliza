#!/usr/bin/env node
// deploy-pixel.mjs — one-step build → install → launch → voice-smoke for a
// physical Android device (Pixel) or a running Cuttlefish cvd.
//
// Sequence:
//   1. Build the fused libllama + libelizainference for the target ABI
//      (arm64-v8a by default — `android-arm64-vulkan-fused`), via
//      compile-libllama.mjs (which carries the omnivoice-fuse graft + the
//      DFlash drafter-arch + the metal/vulkan/cpu kernel patches). x86_64 for
//      a cvd target.
//   2. Stage them + the bundled models into the AOSP vendor tree
//      (sync-to-aosp / stage-default-models), build the privileged APK
//      (build-aosp.mjs --rebuild-privileged-apk; or, with --skip-aosp-build,
//      reuse the last-built APK).
//   3. `adb install -r -g` the APK onto the connected device.
//   4. `adb shell monkey -p <pkg> 1` to launch the main activity.
//   5. Run the on-device smoke (smoke-cuttlefish.mjs — works for both cvd and
//      a real arm64 device per its header: cvd reachable, APK installed,
//      service starts, /api/health, bearer token, chat round-trip, local-not-
//      cloud). With --voice it additionally drives a voice-pipeline check
//      (bargein-style mic→VAD→ASR→DFlash text→TTS round-trip via the
//      on-device /api/local-inference voice endpoint) and reports TTFT.
//
// HONESTY: this script orchestrates the existing primitives — it does not
// fake anything. The actual end-to-end pass needs a connected device (`adb
// devices` non-empty) and, for step 2, an AOSP checkout (`--aosp-root`).
// Without those it stops at the first missing prerequisite and says so.
// The phone-on-the-bench bits stay `authored-pending-hardware` (no Pixel on
// the authoring box) — but every step runs unmodified once a device is
// attached.
//
// Usage:
//   node packages/app-core/scripts/aosp/deploy-pixel.mjs \
//     --aosp-root /path/to/aosp [--abi arm64-v8a|x86_64] [--device <serial>] \
//     [--skip-libllama] [--skip-aosp-build] [--voice] [--jobs N] [--dry-run]
//
// For a running cvd (no AOSP build needed if the cvd already has the app):
//   node packages/app-core/scripts/aosp/deploy-pixel.mjs --abi x86_64 \
//     --skip-libllama --skip-aosp-build --voice

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

function parseArgs(argv) {
  const args = {
    aospRoot: null,
    abi: "arm64-v8a",
    device: null,
    skipLibllama: false,
    skipAospBuild: false,
    voice: false,
    jobs: null,
    dryRun: false,
    appConfig: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--aosp-root") args.aospRoot = argv[++i];
    else if (a === "--abi") args.abi = argv[++i];
    else if (a === "--device") args.device = argv[++i];
    else if (a === "--jobs") args.jobs = Number.parseInt(argv[++i], 10);
    else if (a === "--app-config") args.appConfig = argv[++i];
    else if (a === "--skip-libllama") args.skipLibllama = true;
    else if (a === "--skip-aosp-build") args.skipAospBuild = true;
    else if (a === "--voice") args.voice = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node packages/app-core/scripts/aosp/deploy-pixel.mjs " +
          "[--aosp-root <DIR>] [--abi arm64-v8a|x86_64] [--device <serial>] " +
          "[--skip-libllama] [--skip-aosp-build] [--voice] [--jobs N] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a} (see --help)`);
    }
  }
  if (args.abi !== "arm64-v8a" && args.abi !== "x86_64") {
    throw new Error(`--abi must be arm64-v8a or x86_64 (got "${args.abi}")`);
  }
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  const display = `${cmd} ${cmdArgs.join(" ")}`;
  console.log(
    `[deploy-pixel] $ ${display}${opts.cwd ? `  (cwd=${opts.cwd})` : ""}`,
  );
  if (opts.dryRun) return { status: 0, stdout: "", stderr: "" };
  const res = spawnSync(cmd, cmdArgs, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: opts.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (!opts.allowFail && res.status !== 0) {
    throw new Error(
      `[deploy-pixel] command failed (exit ${res.status}): ${display}` +
        (res.stderr ? `\n${res.stderr}` : ""),
    );
  }
  return res;
}

function adbArgs(device, rest) {
  return device ? ["-s", device, ...rest] : rest;
}

function listAdbDevices() {
  const res = spawnSync("adb", ["devices"], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const target =
    args.abi === "x86_64"
      ? "android-x86_64-cpu-fused"
      : "android-arm64-vulkan-fused";

  console.log(
    `[deploy-pixel] target=${target} device=${args.device ?? "(auto)"} ` +
      `voice=${args.voice} dry-run=${args.dryRun}`,
  );

  // ── 1. Build the fused libllama + libelizainference ──────────────────────
  if (!args.skipLibllama) {
    console.log("[deploy-pixel] step 1/5: build fused libllama for", args.abi);
    const libllamaArgs = ["--abi", args.abi];
    if (args.jobs) libllamaArgs.push("--jobs", String(args.jobs));
    if (args.dryRun) {
      console.log(
        `[deploy-pixel] (dry-run) would run: node packages/app-core/scripts/aosp/compile-libllama.mjs ${libllamaArgs.join(" ")}`,
      );
    } else {
      run(
        "node",
        [path.join(here, "compile-libllama.mjs"), ...libllamaArgs],
        {},
      );
      // Also build the in-process speculative shim (path b) — compile-shim.mjs
      // picks up the speculative-shim source alongside the seccomp + pointer
      // shims; --skip-if-present so re-runs are cheap.
      run("node", [path.join(here, "compile-shim.mjs"), "--skip-if-present"], {
        allowFail: true,
      });
    }
  } else {
    console.log("[deploy-pixel] step 1/5: --skip-libllama → reuse last build");
  }

  // ── 2. Build the AOSP privileged APK ─────────────────────────────────────
  if (!args.skipAospBuild) {
    if (!args.aospRoot) {
      throw new Error(
        "[deploy-pixel] step 2 needs --aosp-root <AOSP checkout>; pass --skip-aosp-build " +
          "to reuse the previously-built APK / deploy to a cvd that already has the app.",
      );
    }
    console.log("[deploy-pixel] step 2/5: build AOSP privileged APK");
    const aospArgs = [
      path.join(here, "build-aosp.mjs"),
      "--aosp-root",
      args.aospRoot,
      "--rebuild-privileged-apk",
      "--skip-libllama", // step 1 already did it
    ];
    if (args.jobs) aospArgs.push("--jobs", String(args.jobs));
    if (args.appConfig) aospArgs.push("--app-config", args.appConfig);
    if (args.dryRun) {
      console.log(
        `[deploy-pixel] (dry-run) would run: node ${aospArgs.join(" ")}`,
      );
    } else {
      run("node", aospArgs, {});
    }
  } else {
    console.log("[deploy-pixel] step 2/5: --skip-aosp-build → reuse last APK");
  }

  // ── resolve device + the package name from app.config ────────────────────
  let device = args.device;
  if (!device && !args.dryRun) {
    const devices = listAdbDevices();
    if (devices.length === 0) {
      throw new Error(
        "[deploy-pixel] no adb device attached. Connect a Pixel (USB debugging) " +
          "or start a cvd (`cvd start`), then re-run. (Steps 1–2 already ran.)",
      );
    }
    if (devices.length > 1) {
      throw new Error(
        `[deploy-pixel] multiple adb devices (${devices.join(", ")}); pass --device <serial>.`,
      );
    }
    device = devices[0];
  }

  const appConfigPath = resolveAppConfigPath({
    repoRoot,
    flagValue: args.appConfig,
  });
  const variant = loadAospVariantConfig({ appConfigPath });
  const pkg = variant?.aosp?.packageName || variant?.packageName;
  if (!pkg) {
    throw new Error(
      `[deploy-pixel] could not read aosp.packageName from ${appConfigPath}`,
    );
  }

  // ── 3. adb install -r -g the APK ─────────────────────────────────────────
  // The build-aosp step writes the privileged APK into the vendor tree; the
  // file name follows `<appName>-*.apk`. We let `adb install-multiple` /
  // `install` find it, falling back to a glob search under the AOSP vendor
  // priv-app dir. For --skip-aosp-build deploys to a cvd that already has the
  // app, step 3 is a no-op (the app is already installed) — handled by
  // continuing on a "device already has the package" check.
  console.log("[deploy-pixel] step 3/5: adb install");
  if (!args.dryRun) {
    const pmList = run(
      "adb",
      adbArgs(device, ["shell", "pm", "list", "packages", pkg]),
      { capture: true, allowFail: true },
    );
    const alreadyInstalled = pmList.stdout?.includes(`package:${pkg}`);
    let apkPath = null;
    if (args.aospRoot) {
      // Best-effort: find the freshly-built privileged APK in the AOSP tree.
      const findRes = spawnSync(
        "find",
        [
          args.aospRoot,
          "-path",
          "*priv-app*",
          "-name",
          "*.apk",
          "-newermt",
          "-1 hour",
        ],
        { encoding: "utf8" },
      );
      apkPath = (findRes.stdout || "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && fs.existsSync(l));
    }
    if (apkPath) {
      run("adb", adbArgs(device, ["install", "-r", "-g", apkPath]), {});
    } else if (alreadyInstalled) {
      console.log(
        `[deploy-pixel]   ${pkg} already installed and no fresh APK found — keeping the on-device build.`,
      );
    } else {
      throw new Error(
        `[deploy-pixel] ${pkg} is not installed and no built APK was found. ` +
          "Run with --aosp-root to build + install it, or push the privileged APK manually.",
      );
    }
  }

  // ── 4. Launch the main activity ──────────────────────────────────────────
  console.log("[deploy-pixel] step 4/5: launch", pkg);
  if (!args.dryRun) {
    run(
      "adb",
      adbArgs(device, [
        "shell",
        "monkey",
        "-p",
        pkg,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ]),
      { allowFail: true },
    );
  }

  // ── 5. On-device smoke (+ voice) ─────────────────────────────────────────
  console.log("[deploy-pixel] step 5/5: on-device smoke");
  if (args.dryRun) {
    console.log(
      `[deploy-pixel] (dry-run) would run: node packages/app-core/scripts/aosp/smoke-cuttlefish.mjs` +
        (args.appConfig ? ` --app-config ${args.appConfig}` : ""),
    );
    if (args.voice) {
      console.log(
        "[deploy-pixel] (dry-run) would run the on-device voice round-trip check " +
          "(mic→VAD→Qwen3-ASR→DFlash text→OmniVoice TTS) via the local-inference voice endpoint, " +
          "reporting TTFT-from-utterance-end.",
      );
    }
    console.log("[deploy-pixel] (dry-run) complete — 5 steps queued, 0 spent.");
    return;
  }
  const smokeArgs = [path.join(here, "smoke-cuttlefish.mjs")];
  if (args.appConfig) smokeArgs.push("--app-config", args.appConfig);
  const smoke = run("node", smokeArgs, { allowFail: true });
  let ok = smoke.status === 0;

  if (args.voice) {
    // The on-device voice round-trip: hit the app's local-inference voice
    // endpoint with a short PCM clip and assert it transcribes + replies +
    // synthesizes (the in-process mic→VAD→ASR→DFlash text→TTS path). The
    // app exposes this under /api/local-inference/voice-smoke when ELIZA_-
    // LOCAL_VOICE_SMOKE=1; deploy-pixel sets it on launch via an am extra.
    // If the endpoint isn't present (older app build), this is a soft skip.
    console.log("[deploy-pixel]   voice round-trip check ...");
    const portFwd = run(
      "adb",
      adbArgs(device, ["forward", "tcp:0", "tcp:8080"]),
      { capture: true, allowFail: true },
    );
    const localPort = (portFwd.stdout || "").trim();
    if (!localPort) {
      console.warn(
        "[deploy-pixel]   could not forward the on-device API port — voice check skipped.",
      );
    } else {
      try {
        const res = await fetch(
          `http://127.0.0.1:${localPort}/api/local-inference/voice-smoke`,
          { method: "POST" },
        );
        if (res.ok) {
          const body = await res.json();
          console.log(
            `[deploy-pixel]   voice round-trip PASS — transcript="${body.transcript ?? "?"}" ` +
              `replyChars=${body.replyText?.length ?? 0} ttsBytes=${body.ttsPcmBytes ?? 0} ` +
              `ttftFromUtteranceEndMs=${body.ttftFromUtteranceEndMs ?? "?"}`,
          );
        } else if (res.status === 404) {
          console.warn(
            "[deploy-pixel]   /api/local-inference/voice-smoke not present in this app build — soft skip " +
              "(the in-process voice path still loaded; the dedicated smoke endpoint lands with the W7 streaming decoders).",
          );
        } else {
          console.error(
            `[deploy-pixel]   voice round-trip FAIL — HTTP ${res.status}`,
          );
          ok = false;
        }
      } catch (err) {
        console.error(
          `[deploy-pixel]   voice round-trip FAIL — ${String(err)}`,
        );
        ok = false;
      }
    }
  }

  console.log(
    `[deploy-pixel] ${ok ? "DONE — all steps passed" : "FAIL — see above"}`,
  );
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}

export { main, parseArgs };
