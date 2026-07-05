#!/usr/bin/env node
// Android end-to-end orchestrator. Single entrypoint that brings the device into
// a known-good state and runs the real-backend e2e suites, surfacing every
// failure loudly (non-zero exit). Steps:
//   1. Ensure an emulator/device is attached (boots an AVD with adequate RAM if
//      none is running) and, for emulators, SELinux is permissive so the
//      embedded on-device agent can run.
//   2. Ensure the WebView-debuggable debug APK is installed.
//   3. Local route: bring up the on-device agent + smallest model and assert a
//      real chat round-trip (mobile-local-chat-smoke). Loud fail if the local
//      runtime or model does not come up.
//   4. Playwright route coverage: drive the real WebView across every route.
//   5. (optional) Cloud route: real Hetzner provisioning probe.
//
// Flags: --serial <s>  --skip-local-chat  --skip-route-coverage  --cloud
//        --launcher-loop (≥200-action seeded launcher gesture loop; opt-in)
//        --force-build/--build (build the APK first)  --skip-build
//        --no-emulator-boot
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  androidApkNeedsBuild,
  androidDistNeedsBuild,
  androidInstallDecision,
  ensureEmulatorBooted,
  ensureEmulatorPermissive,
  installApk,
  readFreshAndroidRendererStamp,
  readInstalledRendererStamp,
  readRendererStampFromApk,
  resolveAdb,
  resolveApk,
  resolveSerial,
} from "./lib/android-device.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const elizaRoot = path.resolve(appDir, "..", "..");

const has = (flag) => process.argv.includes(flag);
const val = (flag, fb) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fb;
};
const log = (m) => console.log(`[android-e2e] ${m}`);

// Smallest local tier; same id the smoke + catalog use.
const SMOKE_MODEL = {
  id: "eliza-1-2b",
  file: "eliza-1-e2b-32k.gguf",
  sizeBytes: 1_270_808_512,
  url: "https://huggingface.co/elizaos/eliza-1/resolve/main/bundles/e2b/text/eliza-1-e2b-32k.gguf?download=true",
  cacheDir: path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".cache/eliza/android-smoke-models",
  ),
};

// On-device voice (STT/TTS) GGUFs the voice-selftest needs alongside the chat
// model. Unlike the chat smoke model these are not auto-downloaded by the
// harness; they live in the host's local-inference cache. Defaults match where
// the desktop runtime stores them; override per env for CI.
const VOICE_MODELS = (() => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const asrDir =
    process.env.ELIZA_ANDROID_ASR_MODEL_DIR ??
    path.join(home, ".cache/eliza/asr-model");
  const ttsDir =
    process.env.ELIZA_ANDROID_TTS_MODEL_DIR ??
    path.join(home, ".local/state/eliza/local-inference/models/omnivoice");
  const dev = "/data/data/ai.elizaos.app/files/.eliza/local-inference/models";
  return [
    {
      host: path.join(asrDir, "eliza-1-asr.gguf"),
      dev: `${dev}/asr/eliza-1-asr.gguf`,
    },
    {
      host: path.join(asrDir, "eliza-1-asr-mmproj.gguf"),
      dev: `${dev}/asr/eliza-1-asr-mmproj.gguf`,
    },
    {
      host: path.join(ttsDir, "omnivoice-base-q4_k_m.gguf"),
      dev: `${dev}/tts/omnivoice-base-q4_k_m.gguf`,
    },
    {
      host: path.join(ttsDir, "omnivoice-tokenizer-q4_k_m.gguf"),
      dev: `${dev}/tts/omnivoice-tokenizer-q4_k_m.gguf`,
    },
  ];
})();

// Stage the ASR/TTS GGUFs the voice round-trip needs. Idempotent (skips files
// already present at the right size, so it no-ops on a real device that already
// carries them), and never the failure point — if the host cache lacks them we
// log and move on so voice-selftest fails loudly with the real "ASR assets
// missing" rather than a push error. Emulators are root (ensureEmulatorPermissive
// ran), so the push into the app data dir succeeds.
function stageVoiceModels(adb, serial) {
  const toStage = VOICE_MODELS.filter((m) => {
    if (!fs.existsSync(m.host)) return false;
    const probe = spawnSync(
      adb,
      ["-s", serial, "shell", "stat", "-c", "%s", m.dev],
      {
        encoding: "utf8",
      },
    );
    return (probe.stdout ?? "").trim() !== String(fs.statSync(m.host).size);
  });
  const missingHost = VOICE_MODELS.filter((m) => !fs.existsSync(m.host));
  if (missingHost.length > 0) {
    log(
      `voice models: ${missingHost.length}/${VOICE_MODELS.length} absent from the host cache ` +
        `(${missingHost.map((m) => path.basename(m.host)).join(", ")}) — skipping voice-model staging; ` +
        `voice-selftest will report the real on-device gap. Set ELIZA_ANDROID_ASR_MODEL_DIR / ELIZA_ANDROID_TTS_MODEL_DIR.`,
    );
    return;
  }
  if (toStage.length === 0) {
    log("voice models already staged on device.");
    return;
  }
  const devModels =
    "/data/data/ai.elizaos.app/files/.eliza/local-inference/models";
  spawnSync(
    adb,
    [
      "-s",
      serial,
      "shell",
      "mkdir",
      "-p",
      `${devModels}/asr`,
      `${devModels}/tts`,
    ],
    {
      stdio: "ignore",
    },
  );
  for (const m of toStage) {
    log(`staging voice model ${path.basename(m.host)}…`);
    const res = spawnSync(adb, ["-s", serial, "push", m.host, m.dev], {
      stdio: "inherit",
    });
    if (res.status !== 0) {
      throw new Error(`adb push ${m.host} exited with code ${res.status}`);
    }
  }
  spawnSync(
    adb,
    [
      "-s",
      serial,
      "shell",
      "chmod",
      "-R",
      "755",
      `${devModels}/asr`,
      `${devModels}/tts`,
    ],
    {
      stdio: "ignore",
    },
  );
  log(`voice models staged for on-device ASR/TTS (${toStage.length} pushed).`);
}

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    cwd: appDir,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${res.status}`);
  }
}

function currentHeadCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: elizaRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function buildAndroidApk() {
  log("building WebView-debuggable APK…");
  run("bun", ["run", "build:android"], {
    ELIZA_MOBILE_REPO_ROOT: elizaRoot,
    ELIZA_WEBVIEW_DEBUG: "1",
    ELIZA_BUN_RISCV64_OPTIONAL: "1",
  });
}

function stampLabel(stamp) {
  if (!stamp) return "missing";
  const buildId = String(stamp.buildId ?? "unknown").slice(0, 12);
  const commit = stamp.commit
    ? ` commit=${String(stamp.commit).slice(0, 12)}`
    : "";
  return `${buildId}${commit}`;
}

function readApkRendererStamp(apk) {
  try {
    return readRendererStampFromApk(apk);
  } catch (error) {
    log(
      `APK renderer stamp unavailable from ${apk}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function ensureFreshApkInstalled(adb, serial) {
  const forceBuild = has("--force-build") || has("--build");
  const skipBuild = has("--skip-build");
  const headCommit = currentHeadCommit();
  let freshStamp = readFreshAndroidRendererStamp();
  const buildDecision = androidDistNeedsBuild({ freshStamp, headCommit });

  if (forceBuild) {
    buildAndroidApk();
  } else if (buildDecision.build) {
    if (skipBuild) {
      throw new Error(
        `--skip-build requested, but Android dist is not usable: ${buildDecision.reason}`,
      );
    }
    log(`${buildDecision.reason} — rebuilding before install check.`);
    buildAndroidApk();
  } else {
    log(`fresh dist renderer stamp: ${stampLabel(freshStamp)}`);
  }

  freshStamp = readFreshAndroidRendererStamp();
  if (!freshStamp) {
    throw new Error(
      "Android build did not produce dist/eliza-renderer-build.json; refusing to install an unverifiable APK.",
    );
  }

  let apk = resolveApk(process.env.ELIZA_ANDROID_APK);
  let apkStamp = readApkRendererStamp(apk);
  let apkDecision = androidApkNeedsBuild({ freshStamp, apkStamp });
  if (apkDecision.build) {
    if (skipBuild) {
      throw new Error(
        `--skip-build requested, but Android APK is not usable: ${apkDecision.reason}`,
      );
    }
    if (!forceBuild) {
      log(`${apkDecision.reason} — rebuilding APK before install.`);
      buildAndroidApk();
      freshStamp = readFreshAndroidRendererStamp();
      if (!freshStamp) {
        throw new Error(
          "Android build did not produce dist/eliza-renderer-build.json; refusing to install an unverifiable APK.",
        );
      }
      apk = resolveApk(process.env.ELIZA_ANDROID_APK);
      apkStamp = readApkRendererStamp(apk);
      apkDecision = androidApkNeedsBuild({ freshStamp, apkStamp });
    }
  }
  if (apkDecision.build) {
    throw new Error(
      `Android build did not produce an APK with the fresh renderer stamp: ${apkDecision.reason}`,
    );
  }
  log(`${apkDecision.reason} in ${apk}`);

  const installedStamp = readInstalledRendererStamp(adb, serial, { log });
  const installDecision = forceBuild
    ? { install: true, reason: "--force-build/--build requested" }
    : androidInstallDecision({ freshStamp, installedStamp });
  if (installDecision.install) {
    log(`${installDecision.reason} — installing ${apk}`);
    installApk(adb, serial, apk);
    const readback = readInstalledRendererStamp(adb, serial, { log });
    const readbackDecision = androidInstallDecision({
      freshStamp,
      installedStamp: readback,
    });
    if (readbackDecision.install) {
      throw new Error(
        `Android install did not produce the fresh renderer stamp: ${readbackDecision.reason}`,
      );
    }
    log(`installed renderer stamp verified: ${stampLabel(readback)}`);
    return;
  }

  log(`${installDecision.reason} — skipping APK install.`);
}

// Node's fetch chokes on the HF Xet LFS redirect; curl handles it. Pre-cache the
// model so the smoke reuses it offline instead of failing on the redirect.
function ensureSmokeModelCached() {
  const dest = path.join(SMOKE_MODEL.cacheDir, SMOKE_MODEL.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size === SMOKE_MODEL.sizeBytes) {
    log(`smoke model cached: ${dest} (${SMOKE_MODEL.sizeBytes} bytes)`);
    return dest;
  }
  fs.mkdirSync(SMOKE_MODEL.cacheDir, { recursive: true });
  log(`downloading smoke model ${SMOKE_MODEL.id} via curl…`);
  execFileSync("curl", ["-fsSL", "-o", dest, SMOKE_MODEL.url], {
    stdio: "inherit",
  });
  const actualSize = fs.statSync(dest).size;
  if (actualSize !== SMOKE_MODEL.sizeBytes) {
    throw new Error(
      `downloaded smoke model ${SMOKE_MODEL.file} size mismatch: expected ${SMOKE_MODEL.sizeBytes} bytes, got ${actualSize} bytes`,
    );
  }
  return dest;
}

async function main() {
  const adb = resolveAdb();

  let serial = val("--serial", process.env.ANDROID_SERIAL);
  if (!has("--no-emulator-boot")) {
    serial = await ensureEmulatorBooted({ adb, avd: val("--avd"), log });
  }
  serial = resolveSerial(adb, serial);
  process.env.ANDROID_SERIAL = serial;
  log(`device serial=${serial}`);

  await ensureEmulatorPermissive(adb, serial, { log });

  ensureFreshApkInstalled(adb, serial);

  if (!has("--skip-local-chat")) {
    const modelPath = ensureSmokeModelCached();
    log("local route: on-device agent + smallest model + real chat…");
    run(
      "node",
      [
        "scripts/mobile-local-chat-smoke.mjs",
        "--platform",
        "android",
        "--require-installed",
        "--live",
        "--android-select-local",
        "--android-stage-smoke-model",
        "--serial",
        serial,
      ],
      { ANDROID_SMOKE_MODEL_PATH: modelPath, ANDROID_SERIAL: serial },
    );
  }

  if (!has("--skip-route-coverage")) {
    // The Playwright config runs route-coverage AND the on-device voice
    // round-trip; the latter needs the ASR/TTS GGUFs staged (the chat smoke only
    // stages the text model, and an `adb install -r` cycle can drop the
    // separately-pushed voice models).
    stageVoiceModels(adb, serial);
    log("route coverage: driving every route on the real WebView…");
    run("node", [
      "scripts/run-ui-playwright.mjs",
      "--config",
      "playwright.android.config.ts",
    ]);
  }

  if (has("--launcher-loop")) {
    // Long seeded launcher gesture loop (≥200 real device actions). Opt-in: it
    // adds several minutes, so it does not run in the default sweep. The seed is
    // printed by the spec and honored via ELIZA_LOOP_SEED for reproduction.
    log("launcher loop: ≥200 real device gestures with per-action invariants…");
    run(
      "bunx",
      [
        "playwright",
        "test",
        "--config",
        "playwright.android.config.ts",
        "test/android/launcher-gesture-loop.android.spec.ts",
      ],
      {
        ELIZA_ANDROID_BACKEND: process.env.ELIZA_ANDROID_BACKEND ?? "host",
        ELIZA_ANDROID_REQUIRE_AGENT:
          process.env.ELIZA_ANDROID_REQUIRE_AGENT ?? "1",
        ANDROID_SERIAL: serial,
      },
    );
  }

  if (has("--cloud")) {
    log(
      "cloud route: real Hetzner provisioning probe (loud-fails if it can't)…",
    );
    run("node", ["scripts/cloud-provisioning-e2e.mjs"]);
  }

  log("ALL ANDROID E2E PASSED ✅");
}

main().catch((error) => {
  console.error(`[android-e2e] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
