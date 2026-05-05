#!/usr/bin/env node
/**
 * build-aosp.mjs — Brand-aware orchestrator for the AOSP/Cuttlefish build.
 *
 * Pipeline (each step optional via flags):
 *   1. Cross-compile libllama.so per ABI (skipLibllama)
 *   2. Rebuild the privileged APK with brand AOSP env (rebuildPrivilegedApk)
 *   3. Sync the brand vendor tree into the AOSP checkout (syncToAosp)
 *   4. Validate the synced product layer (validate)
 *   5. m -j<jobs> with the brand lunch target (skipBuild)
 *   6. cvd start --daemon (launch)
 *   7. boot-validate.mjs (bootValidate)
 *
 * Brand resolution: --brand-config <PATH> | $DISTRO_ANDROID_BRAND_CONFIG | brand.eliza.json
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.mjs";
import { main as compileLibllamaMain } from "./compile-libllama.mjs";
import { main as syncToAospMain } from "./sync-to-aosp.mjs";
import { main as validateMain } from "./validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

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

export function parseSubArgs(argv) {
  const args = {
    aospRoot: null,
    jobs: recommendedJobs(os.totalmem(), os.cpus().length),
    sourceVendor: null,
    skipBuild: false,
    launch: false,
    bootValidate: false,
    skipStopCvd: false,
    // AOSP builds need a musl-linked libllama.so per ABI for the on-device
    // bun process to dlopen via bun:ffi. Default on; --skip-libllama lets
    // developers iterate on non-inference paths without paying the
    // llama.cpp cross-compile cost.
    skipLibllama: false,
    // When set, also re-run `<brand.buildAndroidSystemCmd>` with AOSP env
    // flags so the privileged APK staged into vendor/<brand> is rebuilt
    // with libllama.so + BuildConfig.AOSP_BUILD=true.
    rebuildPrivilegedApk: false,
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
    } else if (arg === "--rebuild-privileged-apk") {
      args.rebuildPrivilegedApk = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/build-aosp.mjs [--brand-config <PATH>] --aosp-root <AOSP_ROOT> [--source-vendor <VENDOR_DIR>] [--jobs <N>] [--skip-build] [--skip-stop-cvd] [--skip-libllama] [--rebuild-privileged-apk] [--launch] [--boot-validate]",
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
  return args;
}

function assertLinuxBuilder(brand) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `${brand.distroName} AOSP/Cuttlefish builds require a Linux x86_64 builder with KVM.`,
    );
  }
  if (!fs.existsSync("/dev/kvm")) {
    throw new Error(`${brand.distroName} Cuttlefish launch requires /dev/kvm.`);
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
    env: options.env ?? process.env,
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

function runAospBuild(aospRoot, jobs, brand) {
  run(
    "bash",
    [
      "-lc",
      `source build/envsetup.sh && lunch ${brand.lunchTarget} && m -j${jobs}`,
    ],
    { cwd: aospRoot },
  );
}

function launchCuttlefish(aospRoot, brand) {
  // Cuttlefish 1.x ships `cvd start`; 0.x exposed `launch_cvd`. Prefer the
  // newer command and fall back so older host packages keep working.
  // `cvd start` reads host artifacts from $ANDROID_HOST_OUT, which lunch
  // populates from build/envsetup.sh.
  run(
    "bash",
    [
      "-lc",
      `source build/envsetup.sh && lunch ${brand.lunchTarget} && (cvd start --daemon 2>/dev/null || launch_cvd --daemon)`,
    ],
    { cwd: aospRoot },
  );
}

/**
 * Re-build the privileged APK with brand AOSP env flags so the staged
 * APK picks up BuildConfig.AOSP_BUILD=true and the agent bundle is
 * produced with <BRAND>_AOSP_BUILD=1.
 */
function rebuildPrivilegedApk(brand) {
  const env = {
    ...process.env,
    [`${brand.envPrefix}_AOSP_BUILD`]: "1",
    [`${brand.envPrefix}_GRADLE_AOSP_BUILD`]: "true",
  };
  const [cmd, ...rest] = brand.buildAndroidSystemCmd;
  const result = spawnSync(cmd, rest, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(
      `${brand.buildAndroidSystemCmd.join(" ")} failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${brand.buildAndroidSystemCmd.join(" ")} exited with code ${result.status}`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const args = parseSubArgs(remaining);
  assertLinuxBuilder(brand);
  assertAospRoot(args.aospRoot);

  const brandConfigArgs = ["--brand-config", brand.brandConfigPath];

  // Cross-compile libllama.so per ABI BEFORE we rebuild the privileged
  // APK (so it's already in assets/agent/{abi}/ when gradle packs the
  // APK) and BEFORE we sync the vendor tree into AOSP (so the synced
  // APK contains it). The compile step is idempotent — `--skip-if-present`
  // keeps re-runs cheap.
  if (!args.skipLibllama) {
    await compileLibllamaMain([...brandConfigArgs, "--skip-if-present"]);
  }

  if (args.rebuildPrivilegedApk) {
    rebuildPrivilegedApk(brand);
  }

  const syncArgs = [...brandConfigArgs];
  if (args.sourceVendor) syncArgs.push("--source-vendor", args.sourceVendor);
  syncArgs.push(args.aospRoot);
  await syncToAospMain(syncArgs);

  const validateArgs = [...brandConfigArgs];
  if (args.sourceVendor) validateArgs.push("--vendor-dir", args.sourceVendor);
  validateArgs.push("--aosp-root", args.aospRoot);
  await validateMain(validateArgs);

  if (!args.skipStopCvd) {
    stopRunningCvd();
  }

  if (!args.skipBuild) {
    runAospBuild(args.aospRoot, args.jobs, brand);
  }

  if (args.launch) {
    launchCuttlefish(args.aospRoot, brand);
  }

  if (args.bootValidate) {
    run("node", [path.join(here, "boot-validate.mjs"), ...brandConfigArgs], {
      cwd: repoRoot,
    });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
