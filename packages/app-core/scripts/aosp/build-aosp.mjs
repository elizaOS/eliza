#!/usr/bin/env node
// AOSP system-app build orchestrator.
//
// Sequence: compile libllama → stage bundled models → sync vendor →
// validate → run `m -j<N>` → optionally `cvd start --daemon` and run
// boot-validate. Reads `productLunch` + `vendorDir` + `appName` from
// `app.config.ts > aosp:`. CLI flags override per-run.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import { main as compileLibllamaMain } from "./compile-libllama.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";
import { main as stageDefaultModelsMain } from "./stage-default-models.mjs";
import { main as stageModelsDfmMain } from "./stage-models-dfm.mjs";
import { main as syncToAospMain } from "./sync-to-aosp.mjs";
import { main as validateMain, validateSepolicy } from "./validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

/**
 * Read `<PREFIX>_BUILD_FORMAT` from the environment. We accept any
 * env var ending in `_BUILD_FORMAT` so forks with different
 * envPrefix values (ELIZA, ACME, …) don't have to fork this
 * script. `apk` wins if multiple are set.
 */
function readBuildFormatFromEnv(env = process.env) {
  const candidates = Object.keys(env).filter((k) =>
    k.endsWith("_BUILD_FORMAT"),
  );
  for (const k of candidates) {
    if (env[k] === "aab") return "aab";
  }
  for (const k of candidates) {
    if (env[k] === "apk") return "apk";
  }
  return null;
}

// soong_build is single-process and routinely peaks at ~25 GB RSS for a
// trunk_staging build. Once the kati/clang phases start they fan out to -jN
// workers that each take a few GB. On a 30 GB host with -j24 we hit the
// kernel OOM killer; the safe heuristic is roughly one worker per 4 GB of
// physical RAM, leaving 4 GB headroom for the kernel + soong itself.
export function recommendedJobs(totalMemBytes, cpuCount) {
  const totalGiB = totalMemBytes / (1024 * 1024 * 1024);
  const ramCap = Math.max(1, Math.floor((totalGiB - 4) / 4));
  return Math.max(1, Math.min(cpuCount, ramCap));
}

export function parseArgs(argv) {
  const args = {
    aospRoot: null,
    jobs: recommendedJobs(os.totalmem(), os.cpus().length),
    sourceVendor: null,
    skipBuild: false,
    launch: false,
    bootValidate: false,
    skipStopCvd: false,
    // AOSP builds need a musl-linked libllama.so per ABI for the on-device
    // bun process to dlopen via bun:ffi (see compile-libllama.mjs and
    // eliza/packages/agent/src/runtime/aosp-llama-adapter.ts). Default on;
    // --skip-libllama lets developers iterate on non-inference paths
    // without paying the llama.cpp cross-compile cost.
    skipLibllama: false,
    // AOSP builds bundle Eliza-1 chat and embedding GGUFs into the APK
    // assets so first-boot chat works offline. Off-by-default would mean every fresh
    // install starts in "no model assigned" state and the user can't
    // chat until they download. ~400 MB APK growth; --skip-bundled-models
    // for builders who want runtime-download instead.
    skipBundledModels: false,
    // When set, also re-run `bun run build:android:system` with AOSP env
    // flags so the privileged APK staged into vendor/<vendorDir> is rebuilt
    // with libllama.so + BuildConfig.AOSP_BUILD=true. Off by default to
    // preserve the existing two-step contract documented in SETUP_AOSP.md.
    rebuildPrivilegedApk: false,
    // Output format for the privileged Capacitor APK rebuild path.
    //   "apk" — produce a base APK with all assets inline (the
    //           AOSP/cuttlefish path; cvd needs APKs).
    //   "aab" — produce an AAB for Play Store distribution. Splits the
    //           bundled GGUF models into a `:models` dynamic feature
    //           module so the base APK stays under Play's 200MB limit.
    // Defaults to "apk" because that's the AOSP build path; AAB is
    // explicitly requested by Play Store builders.
    buildFormat: readBuildFormatFromEnv() ?? "apk",
    appConfigPath: null,
  };

  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--aosp-root") {
      args.aospRoot = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--jobs" || arg === "-j") {
      args.jobs = Number.parseInt(readFlagValue(arg, i), 10);
      i += 1;
    } else if (arg === "--source-vendor") {
      args.sourceVendor = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--skip-build") {
      args.skipBuild = true;
    } else if (arg === "--launch") {
      args.launch = true;
    } else if (arg === "--boot-validate") {
      args.bootValidate = true;
    } else if (arg === "--skip-stop-cvd") {
      args.skipStopCvd = true;
    } else if (arg === "--skip-libllama") {
      args.skipLibllama = true;
    } else if (arg === "--skip-bundled-models") {
      args.skipBundledModels = true;
    } else if (arg === "--rebuild-privileged-apk") {
      args.rebuildPrivilegedApk = true;
    } else if (arg === "--build-format") {
      args.buildFormat = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--app-config") {
      args.appConfigPath = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/build-aosp.mjs --aosp-root <AOSP_ROOT> [--source-vendor <VENDOR_DIR>] [--jobs <N>] [--skip-build] [--skip-stop-cvd] [--skip-libllama] [--skip-bundled-models] [--rebuild-privileged-apk] [--build-format apk|aab] [--launch] [--boot-validate] [--app-config <PATH>]",
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (!args.aospRoot) {
      args.aospRoot = path.resolve(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.aospRoot) {
    throw new Error("--aosp-root is required");
  }
  if (!Number.isFinite(args.jobs) || args.jobs <= 0) {
    throw new Error("--jobs must be a positive integer");
  }
  if (args.buildFormat !== "apk" && args.buildFormat !== "aab") {
    throw new Error(
      `--build-format must be "apk" or "aab" (got "${args.buildFormat}")`,
    );
  }
  return args;
}

function assertLinuxBuilder(variantName) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `${variantName} AOSP/Cuttlefish builds require a Linux x86_64 builder with KVM.`,
    );
  }
  if (!fs.existsSync("/dev/kvm")) {
    throw new Error(`${variantName} Cuttlefish launch requires /dev/kvm.`);
  }
}

function assertAospRoot(aospRoot) {
  const envsetup = path.join(aospRoot, "build", "envsetup.sh");
  if (!fs.existsSync(envsetup)) {
    throw new Error(`${aospRoot} is missing build/envsetup.sh`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.status}`,
    );
  }
}

// A previous --launch run leaves crosvm + cuttlefish workers holding several
// GB of RAM. If we then re-enter `m`, soong_build stacks on top and OOMs the
// host. Tear them down before compiling. cvd 1.x exposes `cvd reset -y`;
// older host packages used `stop_cvd`. Best-effort: never fail the build if
// no device is running.
function stopRunningCvd() {
  spawnSync(
    "bash",
    ["-lc", "cvd reset -y >/dev/null 2>&1 || stop_cvd >/dev/null 2>&1 || true"],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
}

function runAospBuild(aospRoot, lunchTarget, jobs) {
  run(
    "bash",
    ["-lc", `source build/envsetup.sh && lunch ${lunchTarget} && m -j${jobs}`],
    { cwd: aospRoot },
  );
}

function launchCuttlefish(aospRoot, lunchTarget) {
  // Cuttlefish 1.x ships `cvd start`; 0.x exposed `launch_cvd`. Prefer the
  // newer command and fall back so older host packages keep working.
  // `cvd start` reads host artifacts from $ANDROID_HOST_OUT, which lunch
  // populates from build/envsetup.sh.
  run(
    "bash",
    [
      "-lc",
      `source build/envsetup.sh && lunch ${lunchTarget} && (cvd start --daemon 2>/dev/null || launch_cvd --daemon)`,
    ],
    { cwd: aospRoot },
  );
}

/**
 * Re-build the privileged Capacitor APK with AOSP-only env flags so the
 * staged `<appName>.apk` picks up `BuildConfig.AOSP_BUILD=true` and
 * the agent bundle is produced with `ELIZA_AOSP_BUILD=1` (which keeps
 * `node-llama-cpp` real instead of stubbing it; see
 * `eliza/packages/agent/scripts/build-mobile-bundle.mjs`).
 *
 * The flags are propagated explicitly via env so subprocesses spawned by
 * gradle and bun see them. The gradle property `-PelizaAospBuild=true`
 * controls the BuildConfig field via run-mobile-build.mjs. Forks that
 * mirror these to a brand-prefixed env var (`<envPrefix>_AOSP_BUILD`)
 * should set the mirror in their own wrapper before invoking this
 * script.
 */
function rebuildPrivilegedApk() {
  const env = {
    ...process.env,
    ELIZA_AOSP_BUILD: "1",
    ELIZA_GRADLE_AOSP_BUILD: "true",
  };
  const result = spawnSync("bun", ["run", "build:android:system"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(
      `bun run build:android:system failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `bun run build:android:system exited with code ${result.status}`,
    );
  }
}

/**
 * After the standard `:app:assembleRelease` path produced an APK +
 * staged it as `<appName>.apk`, run a follow-up `:app:bundleRelease`
 * that produces an AAB with the bundled GGUF models split out into a
 * `:models` dynamic feature module. The DFM is staged into the
 * regenerated `apps/app/android/` tree by stage-models-dfm.mjs first,
 * then gradle builds the bundle.
 *
 * The AOSP/cuttlefish path keeps the APK because cvd does not handle
 * AABs. The AAB is the Play Store deliverable; nothing in this script
 * uploads it — staging it under the conventional gradle output path is
 * the contract.
 */
async function rebuildPrivilegedAab(variant) {
  // Restructure the regenerated tree to add the `:models` dynamic
  // feature module. The script is gated on `<PREFIX>_BUILD_FORMAT=aab`
  // so it's safe to call here unconditionally — passing --force just
  // bypasses the env check.
  await stageModelsDfmMain(["--force"]);

  // Build the bundle. We don't go through `bun run build:android:system`
  // a second time because that would re-overlay the regenerated tree
  // (overlayAndroid() / patchAndroidGradle()) and undo the DFM
  // restructure. Direct gradle invocation keeps the staged DFM
  // structure intact.
  const androidDir = path.join(repoRoot, "apps", "app", "android");
  const gradleArgs = ["-PelizaAospBuild=true", ":app:bundleRelease"];
  run("./gradlew", gradleArgs, { cwd: androidDir });

  // Stage the AAB next to the staged APK so the AOSP product layer
  // path stays untouched but the AAB is discoverable. The conventional
  // gradle output path is app/build/outputs/bundle/release/app-release.aab.
  const aabSource = path.join(
    androidDir,
    "app",
    "build",
    "outputs",
    "bundle",
    "release",
    "app-release.aab",
  );
  if (!fs.existsSync(aabSource)) {
    throw new Error(
      `Expected AAB output at ${aabSource} after :app:bundleRelease, but the file is missing.`,
    );
  }
  const stagedDir = path.join(
    repoRoot,
    "os",
    "android",
    "vendor",
    variant.vendorDir,
    "apps",
    variant.appName,
  );
  fs.mkdirSync(stagedDir, { recursive: true });
  const aabTarget = path.join(stagedDir, `${variant.appName}.aab`);
  fs.copyFileSync(aabSource, aabTarget);
  console.log(`[aosp:build-aosp] Staged AAB at ${aabTarget}.`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  // Resolve variant config once. All downstream sub-scripts also read
  // the same `app.config.ts`, so we get one canonical definition.
  const cfgPath = resolveAppConfigPath({
    repoRoot,
    flagValue: args.appConfigPath,
  });
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`[aosp:build-aosp] app.config.ts not found at ${cfgPath}.`);
  }
  const variant = loadAospVariantConfig({ appConfigPath: cfgPath });
  if (!variant) {
    throw new Error(
      `[aosp:build-aosp] No \`aosp:\` block in ${cfgPath}; cannot orchestrate AOSP build.`,
    );
  }

  assertLinuxBuilder(variant.variantName);
  assertAospRoot(args.aospRoot);

  // Run the sepolicy regression check up-front. The full validateMain()
  // also covers it, but it gates on validateApk() which only succeeds
  // after build:android:system has staged the APK. The sepolicy half
  // is independent of the APK and pinning the .te + file_contexts
  // shape early means a rule-drift on a builder upgrade surfaces
  // before the multi-hour m build, not after.
  const vendorForValidate = args.sourceVendor
    ? args.sourceVendor
    : path.join(repoRoot, "os", "android", "vendor", variant.vendorDir);
  validateSepolicy(vendorForValidate, variant);

  // Cross-compile libllama.so per ABI BEFORE we rebuild the privileged APK
  // (so it's already in assets/agent/{abi}/ when gradle packs the APK) and
  // BEFORE we sync vendor/<vendorDir> into AOSP (so the synced APK contains
  // it). The compile step is idempotent — `--skip-if-present` keeps re-runs
  // cheap.
  if (!args.skipLibllama) {
    await compileLibllamaMain(["--skip-if-present"]);
  }

  // Stage the default chat + embedding GGUF models into APK assets so
  // first-boot chat works offline. Idempotent: if the files are already
  // staged with the expected size they're left alone. ~400 MB APK growth
  // when both models are bundled; --skip-bundled-models opts out.
  if (!args.skipBundledModels) {
    await stageDefaultModelsMain([]);
  } else {
    console.log(
      "[aosp:build-aosp] --skip-bundled-models; first-boot chat will require runtime download.",
    );
  }

  if (args.rebuildPrivilegedApk) {
    rebuildPrivilegedApk();
    if (args.buildFormat === "aab") {
      // AOSP path keeps the APK that's already staged; this is an
      // additional Play-Store-bound AAB that lives next to it. We
      // intentionally do NOT replace `<appName>.apk` with
      // `<appName>.aab` — cvd cannot consume an AAB.
      await rebuildPrivilegedAab(variant);
    }
  } else if (args.buildFormat === "aab") {
    console.warn(
      "[aosp:build-aosp] --build-format=aab requires --rebuild-privileged-apk; skipping AAB build (the privileged APK was not rebuilt this run).",
    );
  }

  const syncArgs = args.sourceVendor
    ? ["--source-vendor", args.sourceVendor, args.aospRoot]
    : [args.aospRoot];
  if (args.appConfigPath) {
    syncArgs.unshift("--app-config", args.appConfigPath);
  }
  await syncToAospMain(syncArgs);

  const validateArgs = args.sourceVendor
    ? ["--vendor-dir", args.sourceVendor, "--aosp-root", args.aospRoot]
    : ["--aosp-root", args.aospRoot];
  if (args.appConfigPath) {
    validateArgs.push("--app-config", args.appConfigPath);
  }
  await validateMain(validateArgs);

  if (!args.skipStopCvd) {
    stopRunningCvd();
  }

  if (!args.skipBuild) {
    runAospBuild(args.aospRoot, variant.productLunch, args.jobs);
  }

  if (args.launch) {
    launchCuttlefish(args.aospRoot, variant.productLunch);
  }

  if (args.bootValidate) {
    const bootValidateArgs = [path.join(here, "boot-validate.mjs")];
    if (args.appConfigPath) {
      bootValidateArgs.push("--app-config", args.appConfigPath);
    }
    run("node", bootValidateArgs, { cwd: repoRoot });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
