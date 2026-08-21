#!/usr/bin/env node
/**
 * Orchestrates Android device E2E from device preparation through a finalized
 * evidence bundle. The explicit host-emulator and ARM64-local probe sets keep
 * remote x86 coverage separate from embedded-agent and voice prerequisites;
 * every selected probe is a hard gate.
 *
 * Flags: --serial <s>, --skip-local-chat, --skip-route-coverage, --cloud,
 * --launcher-loop, --start-host-agent, --host-emulator-probes,
 * --arm64-local-probes, --host-agent-port <port>, --force-build/--build, --skip-build,
 * --no-emulator-boot, and --no-wait.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
  startAndroidScreenRecord,
} from "./lib/android-capture.mjs";
import {
  androidApkNeedsBuild,
  androidDistNeedsBuild,
  androidInstallDecision,
  ensureEmulatorBooted,
  ensureEmulatorPermissive,
  installApk,
  listDevices,
  readFreshAndroidRendererStamp,
  readInstalledRendererStamp,
  readRendererStampFromApk,
  resolveAdb,
  resolveApk,
  resolveSerial,
  verifyInstalledApkMatches,
} from "./lib/android-device.mjs";
import { resolveAndroidE2eBuildScript } from "./lib/android-e2e-build.mjs";
import {
  captureFailureForensics,
  createDeviceE2eBundle,
  finalizeDeviceE2eBundle,
  finishBundleStep,
  formatFailureForensicsBlock,
  parseOutputDirArg,
  recordBundleArtifact,
  runBundledCommand,
  setBundleBuild,
  setBundleDevice,
  startBundleStep,
} from "./lib/device-e2e-bundle.mjs";
import { acquireDeviceLease, isDeviceLeased } from "./lib/device-lease.mjs";
import { startDeviceE2eHostAgent } from "./lib/host-agent.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const elizaRoot = path.resolve(appDir, "..", "..");

const has = (flag) => process.argv.includes(flag);
const val = (flag, fb) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fb;
};
const log = (m) => console.log(`[android-e2e] ${m}`);

// These lists are intentionally explicit. The hosted x86_64 emulator must not
// accidentally inherit a new local-runtime, destructive lifecycle, or voice
// spec merely because it was added under test/android. ARM64 local proof owns
// the embedded agent and its WebView contract, while voice remains a separate
// hardware-qualified lane with its own model prerequisites.
const HOST_EMULATOR_PROBES = [
  "test/android/onboarding-to-home.android.spec.ts",
  "test/android/route-coverage.android.spec.ts",
  "test/android/native-plugin-view-smoke.android.spec.ts",
];
const ARM64_LOCAL_PROBES = [
  "test/android/local-runtime.android.spec.ts",
  "test/android/route-coverage.android.spec.ts",
];

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

function run(bundle, name, cmd, args, env = {}) {
  return runBundledCommand(bundle, name, cmd, args, {
    cwd: appDir,
    env,
    onFailure: (step, error) => captureAndroidFailure(bundle, step, error),
  });
}

let activeAndroidContext = { adb: null, serial: null };

function captureAndroidFailure(bundle, step, error) {
  const { adb, serial } = activeAndroidContext;
  return captureFailureForensics(
    bundle,
    step,
    ({ failureDir }) => {
      const files = [];
      const causePath = path.join(failureDir, "failure-cause.txt");
      fs.writeFileSync(causePath, `${error?.message ?? error}\n`);
      files.push(causePath);
      if (adb && serial) {
        files.push(
          captureAndroidScreenshot({
            adb,
            serial,
            artifactDir: failureDir,
            filename: "screen.png",
            log,
          }),
        );
        files.push(
          captureAndroidLogcat({
            adb,
            serial,
            artifactDir: failureDir,
            filename: "logcat.txt",
            lines: 2000,
            log,
          }),
        );
      }
      return files;
    },
    error,
  );
}

function failAndroidStep(bundle, step, error) {
  captureAndroidFailure(bundle, step, error);
  finishBundleStep(bundle, step, "failed", error);
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

function buildAndroidApk(bundle, backend) {
  const buildScript = resolveAndroidE2eBuildScript(backend);
  log(`building WebView-debuggable APK via ${buildScript}…`);
  run(bundle, "build Android APK", "bun", ["run", buildScript], {
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

function ensureFreshApkInstalled(bundle, adb, serial, backend) {
  const forceBuild = has("--force-build") || has("--build");
  const skipBuild = has("--skip-build");
  const headCommit = currentHeadCommit();
  let freshStamp = readFreshAndroidRendererStamp();
  const buildDecision = androidDistNeedsBuild({ freshStamp, headCommit });

  if (forceBuild) {
    buildAndroidApk(bundle, backend);
  } else if (buildDecision.build) {
    if (skipBuild) {
      throw new Error(
        `--skip-build requested, but Android dist is not usable: ${buildDecision.reason}`,
      );
    }
    log(`${buildDecision.reason} — rebuilding before install check.`);
    buildAndroidApk(bundle, backend);
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
      buildAndroidApk(bundle, backend);
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
    const step = startBundleStep(bundle, "install Android APK");
    try {
      installApk(adb, serial, apk);
      const hash = verifyInstalledApkMatches(adb, serial, apk);
      log(`installed APK bytes verified: sha256=${hash.sha256.slice(0, 12)}…`);
      finishBundleStep(bundle, step, "passed");
    } catch (error) {
      failAndroidStep(bundle, step, error);
      throw error;
    }
    // Byte identity with the local APK is the strongest post-install check:
    // the renderer stamp lives inside the verified bytes, so the stamp equals
    // the already-validated local `apkStamp` and no `adb pull` readback of the
    // whole APK is needed.
    setBundleBuild(bundle, {
      buildId: apkStamp?.buildId ?? freshStamp.buildId,
      commit: apkStamp?.commit ?? freshStamp.commit ?? null,
    });
    return;
  }

  setBundleBuild(bundle, {
    buildId: installedStamp?.buildId ?? freshStamp.buildId,
    commit: installedStamp?.commit ?? freshStamp.commit ?? null,
  });
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
  const bundle = createDeviceE2eBundle({
    appDir,
    lane: "android",
    outputDir: parseOutputDirArg(process.argv),
  });
  let adb = null;
  let serial;
  let lease = null;
  let finalResult = "failed";
  let finalError = null;
  let routeRecording = null;
  let hostAgent = null;

  const hostEmulatorProbes = has("--host-emulator-probes");
  const arm64LocalProbes = has("--arm64-local-probes");
  const backend = (process.env.ELIZA_ANDROID_BACKEND ?? "local").toLowerCase();

  try {
    {
      const step = startBundleStep(bundle, "validate Android lane selection");
      try {
        if (hostEmulatorProbes && arm64LocalProbes) {
          throw new Error(
            "--host-emulator-probes and --arm64-local-probes are mutually exclusive.",
          );
        }
        if (hostEmulatorProbes && backend !== "host") {
          throw new Error(
            "--host-emulator-probes requires ELIZA_ANDROID_BACKEND=host.",
          );
        }
        if (arm64LocalProbes && backend !== "local") {
          throw new Error(
            "--arm64-local-probes requires ELIZA_ANDROID_BACKEND=local.",
          );
        }
        if (hostEmulatorProbes && !has("--skip-local-chat")) {
          throw new Error(
            "--host-emulator-probes requires --skip-local-chat; x86 must not run the embedded local agent.",
          );
        }
        if (arm64LocalProbes && has("--skip-local-chat")) {
          throw new Error(
            "--arm64-local-probes must run the local chat smoke; remove --skip-local-chat.",
          );
        }
        if (has("--start-host-agent") && backend !== "host") {
          throw new Error(
            "--start-host-agent requires ELIZA_ANDROID_BACKEND=host.",
          );
        }
        finishBundleStep(bundle, step, "passed");
      } catch (error) {
        failAndroidStep(bundle, step, error);
        throw error;
      }
    }
    {
      const step = startBundleStep(bundle, "resolve Android SDK");
      try {
        adb = resolveAdb();
        activeAndroidContext = { adb, serial: null };
        finishBundleStep(bundle, step, "passed");
      } catch (error) {
        failAndroidStep(bundle, step, error);
        throw error;
      }
    }
    {
      const step = startBundleStep(bundle, "resolve Android device");
      try {
        serial = val("--serial", process.env.ANDROID_SERIAL);
        if (!serial && has("--no-emulator-boot")) {
          const unleased = listDevices(adb).find(
            (candidate) => !isDeviceLeased(`android:${candidate}`),
          );
          if (unleased) serial = unleased;
        }
        if (!has("--no-emulator-boot")) {
          const bootStep = startBundleStep(bundle, "boot Android device");
          try {
            serial = await ensureEmulatorBooted({
              adb,
              avd: val("--avd"),
              log,
            });
            finishBundleStep(bundle, bootStep, "passed");
          } catch (error) {
            finishBundleStep(bundle, bootStep, "failed", error);
            throw error;
          }
        }
        serial = resolveSerial(adb, serial);
        activeAndroidContext = { adb, serial };
        finishBundleStep(bundle, step, "passed");
      } catch (error) {
        failAndroidStep(bundle, step, error);
        throw error;
      }
    }
    process.env.ANDROID_SERIAL = serial;
    activeAndroidContext = { adb, serial };
    setBundleDevice(bundle, { serial, kind: "android" });
    log(`device serial=${serial}`);
    lease = await acquireDeviceLease(`android:${serial}`, {
      waitMs: has("--no-wait") ? 0 : undefined,
      log,
    });

    {
      const step = startBundleStep(bundle, "prepare Android device");
      try {
        await ensureEmulatorPermissive(adb, serial, { log });
        finishBundleStep(bundle, step, "passed");
      } catch (error) {
        failAndroidStep(bundle, step, error);
        throw error;
      }
    }

    ensureFreshApkInstalled(bundle, adb, serial, backend);

    if (has("--start-host-agent")) {
      const step = startBundleStep(bundle, "start deterministic host agent");
      try {
        const hostAgentToken = randomBytes(32).toString("hex");
        hostAgent = await startDeviceE2eHostAgent({
          repoRoot: elizaRoot,
          artifactDir: bundle.logsDir,
          requestedPort: val(
            "--host-agent-port",
            process.env.ELIZA_ANDROID_HOST_AGENT_PORT,
          ),
          env: { ...process.env, ELIZA_API_TOKEN: hostAgentToken },
          pairingDisabled: false,
          log,
        });
        process.env.ELIZA_ANDROID_HOST_AGENT_PORT = String(hostAgent.port);
        process.env.ELIZA_ANDROID_HOST_AGENT_TOKEN = hostAgentToken;
        finishBundleStep(bundle, step, "passed");
      } catch (error) {
        failAndroidStep(bundle, step, error);
        throw error;
      }
    }

    if (!has("--skip-local-chat")) {
      const modelPath = ensureSmokeModelCached();
      log("local route: on-device agent + smallest model + real chat…");
      run(
        bundle,
        "local chat smoke",
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
      // Only the legacy full-directory lane includes on-device voice. Explicit
      // host/local probe sets keep that hardware-and-model contract separate.
      if (!hostEmulatorProbes && !arm64LocalProbes) {
        const step = startBundleStep(bundle, "stage Android voice models");
        try {
          stageVoiceModels(adb, serial);
          finishBundleStep(bundle, step, "passed");
        } catch (error) {
          failAndroidStep(bundle, step, error);
          throw error;
        }
      }
      log("route coverage: driving every route on the real WebView…");
      routeRecording = await startAndroidScreenRecord({
        adb,
        serial,
        artifactDir: bundle.rawDir,
        filename: "android-route-coverage.mp4",
        remotePath: "/sdcard/eliza-android-route-coverage.mp4",
        log,
      });
      try {
        const selectedProbes = hostEmulatorProbes
          ? HOST_EMULATOR_PROBES
          : arm64LocalProbes
            ? ARM64_LOCAL_PROBES
            : [];
        run(
          bundle,
          "Android route coverage",
          "node",
          [
            "scripts/run-ui-playwright.mjs",
            "--config",
            "playwright.android.config.ts",
            ...selectedProbes,
          ],
          {
            ANDROID_SERIAL: serial,
            ELIZA_DEVICE_E2E_ARTIFACT_DIR: path.join(
              bundle.root,
              "test-results",
            ),
            ELIZA_ANDROID_ARTIFACT_DIR: path.join(
              bundle.root,
              "test-results",
              "android",
            ),
            ELIZA_ANDROID_PLAYWRIGHT_JUNIT: path.join(
              bundle.reportsDir,
              "android-playwright.junit.xml",
            ),
            ELIZA_ANDROID_PLAYWRIGHT_JSON: path.join(
              bundle.reportsDir,
              "android-playwright.json",
            ),
            PLAYWRIGHT_HTML_REPORT: path.join(
              bundle.reportsDir,
              "android-playwright-html",
            ),
          },
        );
      } finally {
        const videoPath = await routeRecording.stop();
        routeRecording = null;
        if (videoPath) recordBundleArtifact(bundle, videoPath, "video");
      }
    }

    if (has("--launcher-loop")) {
      // Long seeded launcher gesture loop (≥200 real device actions). Opt-in: it
      // adds several minutes, so it does not run in the default sweep. The seed is
      // printed by the spec and honored via ELIZA_LOOP_SEED for reproduction.
      log(
        "launcher loop: ≥200 real device gestures with per-action invariants…",
      );
      run(
        bundle,
        "Android launcher loop",
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
          ELIZA_DEVICE_E2E_ARTIFACT_DIR: path.join(bundle.root, "test-results"),
          ELIZA_ANDROID_ARTIFACT_DIR: path.join(
            bundle.root,
            "test-results",
            "android",
          ),
        },
      );
    }

    if (has("--cloud")) {
      log(
        "cloud route: real Hetzner provisioning probe (loud-fails if it can't)…",
      );
      run(bundle, "cloud provisioning", "node", [
        "scripts/cloud-provisioning-e2e.mjs",
      ]);
    }
    finalResult = "passed";
    log("ALL ANDROID E2E PASSED ✅");
  } catch (error) {
    finalError = error;
  } finally {
    if (routeRecording) {
      const videoPath = await routeRecording.stop();
      if (videoPath) recordBundleArtifact(bundle, videoPath, "video");
    }
    if (hostAgent) {
      const step = startBundleStep(bundle, "stop deterministic host agent");
      try {
        await hostAgent.stop();
        finishBundleStep(bundle, step, "passed");
      } catch (error) {
        // error-policy:J1 runner boundary records teardown failure before exiting
        finishBundleStep(bundle, step, "failed", error);
        finalResult = "failed";
        if (!finalError) {
          finalError = error;
        }
      }
    }
    if (adb && serial) {
      try {
        recordBundleArtifact(
          bundle,
          captureAndroidScreenshot({
            adb,
            serial,
            artifactDir: bundle.rawDir,
            filename: "android-final.png",
            log,
          }),
          "screenshot",
        );
      } catch (error) {
        // error-policy:J7 Bundle capture is diagnostic; preserve the runner result.
        bundle.warnings.push(
          `final Android screenshot failed: ${error?.message ?? error}`,
        );
      }
      try {
        recordBundleArtifact(
          bundle,
          captureAndroidLogcat({
            adb,
            serial,
            artifactDir: bundle.logsDir,
            filename: "android-logcat.txt",
            log,
          }),
          "log",
        );
      } catch (error) {
        // error-policy:J7 Bundle capture is diagnostic; preserve the runner result.
        bundle.warnings.push(
          `Android logcat capture failed: ${error?.message ?? error}`,
        );
      }
    }
    lease?.release();
    const bundleRoot = finalizeDeviceE2eBundle(bundle, finalResult);
    if (finalError) {
      const block = formatFailureForensicsBlock(bundle, finalError);
      if (block) process.stderr.write(`\n${block}`);
    }
    log(`bundle: ${bundleRoot}`);
  }
  if (finalError) throw finalError;
}

main().catch((error) => {
  console.error(`[android-e2e] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
