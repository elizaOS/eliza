#!/usr/bin/env node
/**
 * build-aosp.mjs — Brand-aware orchestrator for the AOSP/Cuttlefish build.
 *
 * Pipeline (each step optional via flags):
 *   1. Rebuild the privileged APK with brand AOSP env (rebuildPrivilegedApk)
 *   2. Sync the brand vendor tree into the AOSP checkout (syncToAosp)
 *   3. Validate the synced product layer (validate)
 *   4. m -j<jobs> with the brand lunch target (skipBuild)
 *   5. cvd start --daemon (launch)
 *   6. boot-validate.mjs (bootValidate)
 *
 * Brand resolution: --brand-config <PATH> | $DISTRO_ANDROID_BRAND_CONFIG | brand.eliza.json
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  aospLockPath,
  assertExtractedVendorTree,
  assertGeneratedVendorTree,
  assertPinnedAospCheckout,
  loadAospLock,
  verifyProprietaryArchive,
} from "./bootstrap-aosp.mjs";
import { loadBrandFromArgv } from "./brand-config.mjs";
import { isMainModule } from "./is-main.mjs";
import { provisionCuttlefishE1 } from "./provision-cuttlefish-e1.mjs";
import { withSisoCompatibility } from "./siso-env.mjs";
import { main as syncToAospMain } from "./sync-to-aosp.mjs";
import { main as validateMain } from "./validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const elizaRoot = path.resolve(
  process.env.ELIZAOS_ELIZA_ROOT ?? path.join(repoRoot, ".eliza-source"),
);

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

export function aospBuildEnvironment(aospRoot, env = process.env) {
  const resolvedAospRoot = path.resolve(aospRoot);
  const hasConfiguredOut = Object.hasOwn(env, "OUT_DIR");
  const hasCommonBase = Object.hasOwn(env, "OUT_DIR_COMMON_BASE");
  const configuredOut = hasConfiguredOut ? env.OUT_DIR : undefined;
  const commonBase = hasCommonBase ? env.OUT_DIR_COMMON_BASE : undefined;
  if (
    hasConfiguredOut &&
    (typeof configuredOut !== "string" || configuredOut.trim() === "")
  ) {
    throw new Error("OUT_DIR must be a non-empty path when set.");
  }
  if (
    hasCommonBase &&
    (typeof commonBase !== "string" || commonBase.trim() === "")
  ) {
    throw new Error("OUT_DIR_COMMON_BASE must be a non-empty path when set.");
  }
  const outputRoot = hasConfiguredOut
    ? path.resolve(resolvedAospRoot, configuredOut)
    : hasCommonBase
      ? path.resolve(
          resolvedAospRoot,
          commonBase,
          path.basename(resolvedAospRoot),
        )
      : path.join(resolvedAospRoot, "out");
  const tempDir = path.join(outputRoot, ".elizaos-tmp");
  const buildEnv = {
    ...env,
    OUT_DIR: outputRoot,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  };
  if (hasCommonBase) {
    buildEnv.OUT_DIR_COMMON_BASE = commonBase;
  } else {
    delete buildEnv.OUT_DIR_COMMON_BASE;
  }
  return withSisoCompatibility(buildEnv);
}

function assertTrustedDirectory(state, label, rootOwnerUid) {
  const builderUid = process.geteuid?.();
  if (!state.isDirectory()) {
    throw new Error(`${label} must be a directory.`);
  }
  if (
    builderUid !== undefined &&
    state.uid !== builderUid &&
    state.uid !== rootOwnerUid
  ) {
    throw new Error(`${label} must be owned by the build user or root.`);
  }
  const rootOwnedSticky =
    state.uid === rootOwnerUid && (state.mode & 0o1000) !== 0;
  if ((state.mode & 0o022) !== 0 && !rootOwnedSticky) {
    throw new Error(`${label} must not be group- or other-writable.`);
  }
}

function canonicalDirectoryPaths(canonicalDirectory) {
  const root = path.parse(canonicalDirectory).root;
  const relative = path.relative(root, canonicalDirectory);
  const paths = [root];
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    paths.push(current);
  }
  return paths;
}

// These checks deliberately trust the isolated builder account and the
// filesystem/mount administrator. POSIX ACL or mount-namespace policy can grant
// powers that inode ownership and mode bits cannot represent portably in Node.
function openTrustedDirectoryChain(canonicalDirectory) {
  const directoryPaths = canonicalDirectoryPaths(canonicalDirectory);
  const handles = [];
  let rootOwnerUid;
  try {
    for (const directoryPath of directoryPaths) {
      const fd = fs.openSync(
        directoryPath,
        fs.constants.O_RDONLY |
          fs.constants.O_DIRECTORY |
          fs.constants.O_NOFOLLOW,
      );
      const handle = { path: directoryPath, fd, state: null };
      handles.push(handle);
      const state = fs.fstatSync(fd);
      handle.state = state;
      rootOwnerUid ??= state.uid;
      assertTrustedDirectory(
        state,
        `AOSP output path ancestor ${directoryPath}`,
        rootOwnerUid,
      );
    }
    return { handles, rootOwnerUid };
  } catch (error) {
    closeDirectoryHandles(handles);
    throw error;
  }
}

function closeDirectoryHandles(handles) {
  let firstError;
  for (const handle of [...handles].reverse()) {
    try {
      fs.closeSync(handle.fd);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function prepareAospBuildEnvironment(aospRoot, env = process.env) {
  const buildEnv = aospBuildEnvironment(aospRoot, env);
  const configuredOutputRoot = path.dirname(buildEnv.TMPDIR);
  fs.mkdirSync(configuredOutputRoot, { recursive: true, mode: 0o755 });
  const configuredOutputIdentity = fs.lstatSync(configuredOutputRoot);
  const canonicalOutputRoot = fs.realpathSync(configuredOutputRoot);
  const { handles: outputPathHandles, rootOwnerUid } =
    openTrustedDirectoryChain(canonicalOutputRoot);
  const outputHandle = outputPathHandles.at(-1);
  const outputState = outputHandle.state;

  const canonicalTemp = path.join(canonicalOutputRoot, ".elizaos-tmp");
  let tempFd;
  try {
    fs.mkdirSync(canonicalTemp, { recursive: true, mode: 0o700 });
    const pathState = fs.lstatSync(canonicalTemp);
    if (!pathState.isDirectory() || pathState.isSymbolicLink()) {
      throw new Error("AOSP build temporary path must be a real directory.");
    }
    tempFd = fs.openSync(
      canonicalTemp,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    const initialTempState = fs.fstatSync(tempFd);
    if (
      process.geteuid?.() !== undefined &&
      initialTempState.uid !== process.geteuid()
    ) {
      throw new Error(
        "AOSP build temporary directory must be owned by the build user.",
      );
    }
    fs.fchmodSync(tempFd, 0o700);
    const tempState = fs.fstatSync(tempFd);
    assertTrustedDirectory(
      tempState,
      "AOSP build temporary directory",
      rootOwnerUid,
    );
    if ((tempState.mode & 0o777) !== 0o700) {
      throw new Error("AOSP build temporary directory must have mode 0700.");
    }
    if (outputState.dev !== tempState.dev) {
      throw new Error(
        "AOSP build temporary directory must be on the output filesystem.",
      );
    }
  } catch (error) {
    try {
      if (tempFd !== undefined) fs.closeSync(tempFd);
    } catch {
      // Preserve the preparation failure while still closing ancestor handles.
    }
    try {
      closeDirectoryHandles(outputPathHandles);
    } catch {
      // Preserve the preparation failure after making every cleanup attempt.
    }
    throw error;
  }

  buildEnv.OUT_DIR = canonicalOutputRoot;
  buildEnv.TMPDIR = canonicalTemp;
  buildEnv.TMP = canonicalTemp;
  buildEnv.TEMP = canonicalTemp;
  return {
    env: buildEnv,
    configuredOutputRoot,
    configuredOutputIdentity,
    canonicalOutputRoot,
    canonicalTemp,
    outputFd: outputHandle.fd,
    outputPathHandles,
    rootOwnerUid,
    tempFd,
  };
}

export function revalidateAospBuildEnvironment(prepared) {
  const currentConfiguredOutput = fs.lstatSync(prepared.configuredOutputRoot);
  if (!sameFile(currentConfiguredOutput, prepared.configuredOutputIdentity)) {
    throw new Error("AOSP output path identity changed before build spawn.");
  }
  if (
    fs.realpathSync(prepared.configuredOutputRoot) !==
    prepared.canonicalOutputRoot
  ) {
    throw new Error("AOSP output path target changed before build spawn.");
  }

  for (const handle of prepared.outputPathHandles) {
    const state = fs.fstatSync(handle.fd);
    assertTrustedDirectory(
      state,
      `AOSP output path ancestor ${handle.path}`,
      prepared.rootOwnerUid,
    );
    if (!sameFile(state, fs.lstatSync(handle.path))) {
      throw new Error(
        `AOSP output path ancestor identity changed before build spawn: ${handle.path}`,
      );
    }
  }
  const outputState = fs.fstatSync(prepared.outputFd);

  const tempState = fs.fstatSync(prepared.tempFd);
  assertTrustedDirectory(
    tempState,
    "AOSP build temporary directory",
    prepared.rootOwnerUid,
  );
  if ((tempState.mode & 0o777) !== 0o700) {
    throw new Error("AOSP build temporary directory must have mode 0700.");
  }
  const tempPathState = fs.lstatSync(prepared.canonicalTemp);
  if (tempPathState.isSymbolicLink() || !sameFile(tempState, tempPathState)) {
    throw new Error(
      "AOSP build temporary path identity changed before build spawn.",
    );
  }
  if (outputState.dev !== tempState.dev) {
    throw new Error(
      "AOSP build temporary directory must remain on the output filesystem.",
    );
  }
}

export function closeAospBuildEnvironment(prepared) {
  let firstError;
  try {
    fs.closeSync(prepared.tempFd);
  } catch (error) {
    firstError = error;
  }
  try {
    closeDirectoryHandles(prepared.outputPathHandles);
  } catch (error) {
    firstError ??= error;
  }
  if (firstError) throw firstError;
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
      const value = readFlagValue(arg, i);
      if (!/^\d+$/.test(value)) {
        throw new Error("--jobs must be an integer from 1 through 256");
      }
      args.jobs = Number(value);
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
    } else if (arg === "--rebuild-privileged-apk") {
      args.rebuildPrivilegedApk = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/build-aosp.mjs [--brand-config <PATH>] --aosp-root <AOSP_ROOT> [--source-vendor <VENDOR_DIR>] [--jobs <N>] [--skip-build] [--skip-stop-cvd] [--rebuild-privileged-apk] [--launch] [--boot-validate]",
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
  if (!Number.isSafeInteger(args.jobs) || args.jobs < 1 || args.jobs > 256) {
    throw new Error("--jobs must be an integer from 1 through 256");
  }
  return args;
}

export function assertBuildHost({
  brand,
  launch = false,
  kvmPath = "/dev/kvm",
}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `${brand.distroName} AOSP builds require a Linux x86_64 builder.`,
    );
  }
  const usesRiscvTcg = brand.productName.includes("riscv64");
  if (launch && !usesRiscvTcg && !fs.existsSync(kvmPath)) {
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
  const prepared = prepareAospBuildEnvironment(aospRoot);
  try {
    revalidateAospBuildEnvironment(prepared);
    run(
      "bash",
      [
        "-lc",
        `source build/envsetup.sh && lunch ${brand.lunchTarget} && m -j${jobs}`,
      ],
      { cwd: aospRoot, env: prepared.env },
    );
  } finally {
    closeAospBuildEnvironment(prepared);
  }
}

const CUTTLEFISH_GPU_MODES = new Set([
  "gfxstream",
  "gfxstream_guest_angle",
  "gfxstream_guest_angle_host_swiftshader",
  "guest_swiftshader",
  "drm_virgl",
  "none",
]);

export function resolveCuttlefishGpuMode(brand, env = process.env) {
  const configured = env.ELIZA_CUTTLEFISH_GPU_MODE?.trim();
  if (configured) {
    if (!CUTTLEFISH_GPU_MODES.has(configured)) {
      throw new Error(
        `ELIZA_CUTTLEFISH_GPU_MODE must be one of ${[...CUTTLEFISH_GPU_MODES].join(", ")}`,
      );
    }
    return configured;
  }
  return brand.productName.includes("riscv64")
    ? "guest_swiftshader"
    : "gfxstream";
}

export function cuttlefishLaunchCommand(brand, env = process.env) {
  const gpuMode = resolveCuttlefishGpuMode(brand, env);
  const rendererFeatures = env.ELIZA_CUTTLEFISH_GPU_RENDERER_FEATURES?.trim();
  if (
    rendererFeatures &&
    !/^[A-Za-z][A-Za-z0-9]*:(?:enabled|disabled)(?:;[A-Za-z][A-Za-z0-9]*:(?:enabled|disabled))*$/.test(
      rendererFeatures,
    )
  ) {
    throw new Error(
      "ELIZA_CUTTLEFISH_GPU_RENDERER_FEATURES must contain semicolon-separated Feature:enabled or Feature:disabled entries",
    );
  }
  const launchArgs = `--daemon --gpu_mode=${gpuMode}${rendererFeatures ? ` --gpu_renderer_features='${rendererFeatures}'` : ""}`;
  return [
    "source build/envsetup.sh",
    `lunch ${brand.lunchTarget}`,
    `if command -v cvd >/dev/null 2>&1; then cvd start ${launchArgs}; else launch_cvd ${launchArgs}; fi`,
  ].join(" && ");
}

function launchCuttlefish(aospRoot, brand) {
  // Cuttlefish 1.x ships `cvd start`; 0.x exposed `launch_cvd`. Prefer the
  // newer command and fall back so older host packages keep working.
  // `cvd start` reads host artifacts from $ANDROID_HOST_OUT, which lunch
  // populates from build/envsetup.sh. Select the command by availability so a
  // real launch failure is never hidden by an incompatible fallback. Android's
  // documented gfxstream mode forwards guest OpenGL/Vulkan to the host and is
  // explicit here because auto mode can silently choose guest SwiftShader.
  run("bash", ["-lc", cuttlefishLaunchCommand(brand)], { cwd: aospRoot });
}

/**
 * Re-build the privileged APK with brand AOSP env flags so the staged
 * APK picks up BuildConfig.AOSP_BUILD=true and the agent bundle is
 * produced with <BRAND>_AOSP_BUILD=1.
 */
function rebuildPrivilegedApk(brand) {
  if (!fs.existsSync(path.join(elizaRoot, "packages/app-core/package.json"))) {
    throw new Error(
      "Set ELIZAOS_ELIZA_ROOT to an elizaOS/eliza checkout before rebuilding the privileged APK.",
    );
  }
  const env = {
    ...process.env,
    ELIZAOS_OS_REPO_ROOT: repoRoot,
    [`${brand.envPrefix}_APP_ID`]: brand.packageName,
    [`${brand.envPrefix}_AOSP_BUILD`]: "1",
    [`${brand.envPrefix}_GRADLE_AOSP_BUILD`]: "true",
  };
  const [cmd, ...rest] = brand.buildAndroidSystemCmd;
  const result = spawnSync(cmd, rest, {
    cwd: elizaRoot,
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
  assertBuildHost({ brand, launch: args.launch });
  assertAospRoot(args.aospRoot);
  const selectedLockPath = brand.aospLockPath
    ? path.resolve(repoRoot, brand.aospLockPath)
    : aospLockPath;
  const lock = loadAospLock(selectedLockPath);
  assertPinnedAospCheckout(args.aospRoot, lock);
  if (brand.aospDeviceOverlay) {
    provisionCuttlefishE1({
      aospRoot: args.aospRoot,
      lockPath: path.resolve(repoRoot, brand.aospDeviceOverlay),
    });
  }
  if (lock.proprietaryArchive) {
    const archivePath = process.env.ELIZA_PIXEL_VENDOR_ARCHIVE;
    if (!archivePath) {
      throw new Error(
        "ELIZA_PIXEL_VENDOR_ARCHIVE must point to the licensed vendor archive for this hardware target.",
      );
    }
    await verifyProprietaryArchive(lock, archivePath);
    assertExtractedVendorTree(args.aospRoot, lock);
  }
  if (lock.generatedVendor) {
    assertGeneratedVendorTree(args.aospRoot, lock);
    // Fail closed when the generated tree was prepared under different
    // ELIZAOS_GRIZZLY_* settings than this build is running with — otherwise
    // renderer/probe "A/B images" silently build from the wrong tree.
    const { assertPreparedTreeMatchesEnv } = await import(
      "./prepare-grizzly.mjs"
    );
    assertPreparedTreeMatchesEnv(args.aospRoot);
  }

  const brandConfigArgs = ["--brand-config", brand.brandConfigPath];

  // AOSP inference is served bionic-side, not via a per-ABI musl libllama.so.
  // When the fused libelizainference.so + libggml-vulkan.so are staged in the
  // privileged APK, ElizaAgentService delegates inference over the abstract UDS
  // to ElizaBionicInferenceServer, so the OS-image bun process never dlopens
  // its own libllama.so.

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

const isMain = isMainModule(import.meta);

if (isMain) {
  await main();
}
