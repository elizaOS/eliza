#!/usr/bin/env node
/**
 * Build the DFlash-capable llama-server fork used by local inference.
 *
 * Upstream ggml-org/llama.cpp does not yet ship DFlash. This script builds
 * spiritbuun/buun-llama-cpp into:
 *   $ELIZA_STATE_DIR/local-inference/bin/dflash/<platform>-<arch>-<backend>/
 *
 * Multi-target build matrix (see SUPPORTED_TARGETS below):
 *   linux-x64-cpu, linux-x64-cuda, linux-x64-rocm, linux-x64-vulkan
 *   android-arm64-cpu, android-arm64-vulkan
 *   darwin-arm64-metal, darwin-x64-metal
 *   windows-x64-cpu, windows-x64-cuda
 *
 * Backend selection (legacy single-target mode, when --target is omitted):
 *   macOS           -> Metal
 *   Linux + nvcc    -> CUDA
 *   Linux + rocminfo/hipcc -> ROCm/HIP
 *   otherwise       -> CPU
 *
 * Usage:
 *   node build-llama-cpp-dflash.mjs [--target <triple>] [--all] [--dry-run]
 *                                   [--backend ...] [--ref ...] [--out-dir ...]
 *                                   [--jobs N] [--cache-dir ...]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const REMOTE =
  process.env.ELIZA_DFLASH_LLAMA_CPP_REMOTE ||
  "https://github.com/spiritbuun/buun-llama-cpp.git";
const REF = process.env.ELIZA_DFLASH_LLAMA_CPP_REF || "master";
const MIN_COMMIT = "b9d01582b";

const SUPPORTED_TARGETS = [
  "linux-x64-cpu",
  "linux-x64-cuda",
  "linux-x64-rocm",
  "linux-x64-vulkan",
  "android-arm64-cpu",
  "android-arm64-vulkan",
  "darwin-arm64-metal",
  "darwin-x64-metal",
  "windows-x64-cpu",
  "windows-x64-cuda",
];

function stateDir() {
  return (
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza")
  );
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = opts.capture
      ? `\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
      : "";
    throw new Error(
      `${cmd} ${args.join(" ")} failed with ${result.status}${detail}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function tryRun(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "ignore",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
}

function has(cmd) {
  const result = spawnSync(cmd, ["--version"], {
    stdio: "ignore",
    env: process.env,
  });
  return result.status === 0;
}

function detectBackend() {
  const forced = process.env.ELIZA_DFLASH_BACKEND?.trim().toLowerCase();
  if (forced) return forced;
  if (process.platform === "darwin") return "metal";
  if (process.platform === "linux" && (has("hipcc") || has("rocminfo"))) {
    return "rocm";
  }
  if (process.platform === "linux" && (has("nvcc") || has("nvidia-smi"))) {
    return "cuda";
  }
  return "cpu";
}

// Resolve the Android NDK root.
//
// Order: $ANDROID_NDK_HOME, $ANDROID_NDK_ROOT, $ANDROID_NDK,
//        $HOME/Android/Sdk/ndk/<sole-or-newest-subdir>.
function resolveAndroidNdk() {
  const envCandidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_NDK,
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  for (const candidate of envCandidates) {
    if (
      fs.existsSync(
        path.join(candidate, "build", "cmake", "android.toolchain.cmake"),
      )
    ) {
      return candidate;
    }
  }
  const ndkDir = path.join(os.homedir(), "Android", "Sdk", "ndk");
  if (fs.existsSync(ndkDir)) {
    const versions = fs
      .readdirSync(ndkDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (versions.length > 0) {
      const chosen = path.join(ndkDir, versions[versions.length - 1]);
      if (
        fs.existsSync(
          path.join(chosen, "build", "cmake", "android.toolchain.cmake"),
        )
      ) {
        return chosen;
      }
    }
  }
  return null;
}

// Find Vulkan headers usable for an Android build. Returns the include dir
// (i.e. the parent of `vulkan/`) or null.
//
// NDK r21+ bundles Vulkan headers under
//   <ndk>/toolchains/llvm/prebuilt/<host>/sysroot/usr/include/vulkan/
// which is on the Android sysroot include path automatically. We still report
// the path so CAPABILITIES.json / logs can show where it came from.
function findAndroidVulkanInclude(ndk) {
  if (!ndk) return null;
  const hostDirs = ["linux-x86_64", "darwin-x86_64", "windows-x86_64"];
  for (const host of hostDirs) {
    const candidate = path.join(
      ndk,
      "toolchains",
      "llvm",
      "prebuilt",
      host,
      "sysroot",
      "usr",
      "include",
    );
    if (fs.existsSync(path.join(candidate, "vulkan", "vulkan_core.h"))) {
      return candidate;
    }
  }
  return null;
}

// Locate a glslc usable for the host. The Android NDK ships its own glslc
// under shader-tools/<host>/glslc.
function findGlslc(ndk) {
  if (has("glslc")) return "glslc";
  if (ndk) {
    const hostDirs = ["linux-x86_64", "darwin-x86_64", "windows-x86_64"];
    for (const host of hostDirs) {
      const candidate = path.join(ndk, "shader-tools", host, "glslc");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Map a target triple to cmake configure flags.
//
// Notes / quirks:
//   * Several targets explicitly disable other GPU backends so that probe
//     code in ggml/src/CMakeLists.txt doesn't pull in an unrelated SDK.
//   * Android cross-compile uses the NDK's bundled cmake toolchain.
//   * GGML_NATIVE is on for host targets and OFF for cross-compiles
//     (you can't sniff -march for a different ABI).
function cmakeFlagsForTarget(target, ctx) {
  const [platform, arch, backend] = target.split("-");
  const flags = ["-DLLAMA_BUILD_TESTS=OFF", "-DLLAMA_BUILD_EXAMPLES=ON"];
  const isCross = platform === "android" || platform === "windows";
  flags.push(`-DGGML_NATIVE=${isCross ? "OFF" : "ON"}`);

  // Disable backends we don't want by default; flip the chosen one back on.
  const offByDefault = ["GGML_METAL", "GGML_CUDA", "GGML_HIP", "GGML_VULKAN"];
  for (const name of offByDefault) flags.push(`-D${name}=OFF`);

  if (backend === "metal") {
    flags[flags.indexOf("-DGGML_METAL=OFF")] = "-DGGML_METAL=ON";
  } else if (backend === "cuda") {
    flags[flags.indexOf("-DGGML_CUDA=OFF")] = "-DGGML_CUDA=ON";
    flags.push("-DGGML_CUDA_FA=ON", "-DGGML_CUDA_FA_ALL_QUANTS=ON");
  } else if (backend === "rocm") {
    flags[flags.indexOf("-DGGML_HIP=OFF")] = "-DGGML_HIP=ON";
  } else if (backend === "vulkan") {
    flags[flags.indexOf("-DGGML_VULKAN=OFF")] = "-DGGML_VULKAN=ON";
    if (ctx.glslc) flags.push(`-DVulkan_GLSLC_EXECUTABLE=${ctx.glslc}`);
  }

  if (platform === "android") {
    if (!ctx.androidNdk) {
      throw new Error(
        "Android target requested but ANDROID_NDK_HOME is not set and no NDK was found under ~/Android/Sdk/ndk",
      );
    }
    flags.push(
      `-DCMAKE_TOOLCHAIN_FILE=${path.join(ctx.androidNdk, "build", "cmake", "android.toolchain.cmake")}`,
      `-DANDROID_NDK=${ctx.androidNdk}`,
      "-DANDROID_ABI=arm64-v8a",
      "-DANDROID_PLATFORM=android-28",
      // CURL is optional for llama-server and not part of the NDK sysroot.
      "-DLLAMA_CURL=OFF",
    );
    if (backend === "vulkan" && ctx.androidVulkanInclude) {
      // Mostly informational - the NDK sysroot already exposes vulkan/ on the
      // include path. Pass it explicitly so CMake's FindVulkan succeeds even
      // if upstream changes its detection.
      flags.push(`-DVulkan_INCLUDE_DIR=${ctx.androidVulkanInclude}`);
    }
  } else if (platform === "windows") {
    // We don't currently host a mingw-w64 toolchain on this box, but allow the
    // user to point at one via env vars. Without that, this branch is meant
    // for the matching native host (Windows).
    if (process.env.MINGW_TOOLCHAIN_FILE) {
      flags.push(`-DCMAKE_TOOLCHAIN_FILE=${process.env.MINGW_TOOLCHAIN_FILE}`);
    }
  }

  const extra = process.env.ELIZA_DFLASH_CMAKE_FLAGS?.trim();
  if (extra) flags.push(...extra.split(/\s+/).filter(Boolean));
  return flags;
}

// Inspect compatibility from the host point of view. Returns either
// { ok: true } or { ok: false, reason: string } so --all can skip cleanly.
function targetCompatibility(target, ctx) {
  const [platform, , backend] = target.split("-");
  if (platform === "darwin" && process.platform !== "darwin") {
    return { ok: false, reason: "darwin target requires macOS host" };
  }
  if (platform === "linux" && process.platform !== "linux") {
    return { ok: false, reason: "linux target requires linux host" };
  }
  if (platform === "windows") {
    if (process.platform === "win32") return { ok: true };
    if (process.env.MINGW_TOOLCHAIN_FILE) return { ok: true };
    return {
      ok: false,
      reason: "windows target requires Windows host or MINGW_TOOLCHAIN_FILE",
    };
  }
  if (platform === "android") {
    if (!ctx.androidNdk) {
      return { ok: false, reason: "Android NDK not found" };
    }
    if (backend === "vulkan" && !ctx.androidVulkanInclude) {
      return {
        ok: false,
        reason: "Android Vulkan headers not found in NDK sysroot",
      };
    }
    return { ok: true };
  }
  if (backend === "cuda" && !has("nvcc")) {
    return { ok: false, reason: "no nvcc (CUDA toolkit)" };
  }
  if (backend === "rocm" && !(has("hipcc") || has("rocminfo"))) {
    return { ok: false, reason: "no hipcc / rocminfo" };
  }
  if (backend === "vulkan" && !ctx.glslc) {
    return { ok: false, reason: "no glslc (Vulkan shader compiler)" };
  }
  if (backend === "metal" && process.platform !== "darwin") {
    return { ok: false, reason: "metal requires macOS" };
  }
  return { ok: true };
}

function defaultTarget() {
  const backend = detectBackend();
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const platform =
    process.platform === "win32" ? "windows" : process.platform;
  return `${platform}-${arch}-${backend}`;
}

function parseArgs(argv) {
  const args = {
    cacheDir: path.join(
      os.homedir(),
      ".cache",
      "eliza-dflash",
      "buun-llama-cpp",
    ),
    outDirOverride: null,
    targets: null, // null => single legacy target, otherwise an array
    backend: null, // legacy --backend
    ref: REF,
    jobs: Math.max(1, Math.min(os.cpus().length, 16)),
    dryRun: false,
    all: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--cache-dir") args.cacheDir = path.resolve(next());
    else if (arg === "--out-dir") args.outDirOverride = path.resolve(next());
    else if (arg === "--backend") args.backend = next();
    else if (arg === "--target") {
      const value = next();
      if (!SUPPORTED_TARGETS.includes(value)) {
        throw new Error(
          `Unsupported --target ${value}. Supported: ${SUPPORTED_TARGETS.join(", ")}`,
        );
      }
      args.targets = args.targets || [];
      args.targets.push(value);
    } else if (arg === "--all") args.all = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--ref") args.ref = next();
    else if (arg === "--jobs" || arg === "-j")
      args.jobs = Number.parseInt(next(), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node build-llama-cpp-dflash.mjs [options]",
          "",
          "Targets (use --target one or more times, or --all):",
          ...SUPPORTED_TARGETS.map((t) => `  ${t}`),
          "",
          "Options:",
          "  --target <triple>      Build a specific target (repeatable).",
          "  --all                  Build every host-compatible target.",
          "  --dry-run              Print cmake invocations without running.",
          "  --backend <name>       Legacy single-target backend selector.",
          "  --ref <git-ref>        Branch/tag/SHA of the fork to build.",
          "  --out-dir <path>       Override the output directory (single target).",
          "  --cache-dir <path>     Override the source checkout cache.",
          "  --jobs N | -j N        Parallel build jobs.",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.all && args.targets) {
    throw new Error("--all and --target are mutually exclusive");
  }
  return args;
}

function ensureCheckout(cacheDir, ref) {
  if (fs.existsSync(path.join(cacheDir, ".git"))) {
    run("git", ["fetch", "--depth=1", "origin", ref], { cwd: cacheDir });
    run("git", ["checkout", "FETCH_HEAD"], { cwd: cacheDir });
  } else {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    run("git", ["clone", "--depth=1", "--branch", ref, REMOTE, cacheDir]);
  }
  const head = run("git", ["rev-parse", "HEAD"], {
    cwd: cacheDir,
    capture: true,
  });
  console.log(`[dflash-build] checkout ${head}`);
  const ancestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", MIN_COMMIT, "HEAD"],
    {
      cwd: cacheDir,
      stdio: "ignore",
    },
  );
  if (ancestor.status !== 0) {
    const shallow = run("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: cacheDir,
      capture: true,
    });
    if (shallow === "true") {
      console.log(
        `[dflash-build] shallow checkout; skipping ancestry check for minimum known-good DFlash/SWA commit ${MIN_COMMIT}`,
      );
    } else {
      console.warn(
        `[dflash-build] warning: HEAD does not contain minimum known-good DFlash/SWA commit ${MIN_COMMIT}`,
      );
    }
  }
  return head;
}

function patchMetalTurbo4(cacheDir) {
  const metalPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal.metal",
  );
  if (!fs.existsSync(metalPath)) return;

  let source = fs.readFileSync(metalPath, "utf8");
  const original = source;

  const constantsAnchor =
    "constant float turbo_mid_3bit[7] = { -0.154259f, -0.091775f, -0.043589f, 0.0f, 0.043589f, 0.091775f, 0.154259f };\n";
  if (!source.includes("turbo_centroids_4bit")) {
    source = source.replace(
      constantsAnchor,
      `${constantsAnchor}constant float turbo_centroids_4bit[16] = {
    -0.241556f, -0.182907f, -0.143047f, -0.111065f,
    -0.083317f, -0.058069f, -0.034311f, -0.011353f,
     0.011353f,  0.034311f,  0.058069f,  0.083317f,
     0.111065f,  0.143047f,  0.182907f,  0.241556f,
};
constant float turbo_mid_4bit[15] = {
    -0.212232f, -0.162977f, -0.127056f, -0.097191f, -0.070693f,
    -0.046190f, -0.022832f,  0.000000f,  0.022832f,  0.046190f,
     0.070693f,  0.097191f,  0.127056f,  0.162977f,  0.212232f,
};
`,
    );
  }

  source = source.replace(
    / {4}\/\/ Step 3: 3-bit quantization[\s\S]*? {4}\/\/ Step 5: QJL WHT signs[\s\S]*? {4}for \(int i = 0; i < 128; i\+\+\) \{\n {8}if \(x\[i\] >= 0\.0f\) \{\n {12}dst\.signs\[i \/ 8\] \|= \(1 << \(i % 8\)\);\n {8}\}\n {4}\}\n/,
    `    // Step 3: 4-bit quantization

    float recon[128];
    float recon_sq = 0.0f;
    for (int j = 0; j < QK_TURBO4 / 2; j++) dst.qs[j] = 0;
    for (int j = 0; j < 128; j++) {
        float val = x[j];
        uint8_t idx = 15;
        for (int m = 0; m < 15; m++) {
            if (val < turbo_mid_4bit[m]) {
                idx = (uint8_t)m;
                break;
            }
        }
        recon[j] = turbo_centroids_4bit[idx];
        recon_sq += recon[j] * recon[j];

        if ((j & 1) == 0) {
            dst.qs[j / 2] = idx & 0x0F;
        } else {
            dst.qs[j / 2] |= (idx & 0x0F) << 4;
        }
    }

    const float recon_norm = sqrt(recon_sq);
    dst.norm = half(recon_norm > 1e-10f ? norm / recon_norm : norm);
`,
  );

  source = source.replace(
    /static void turbo4_dequantize_full_block\(device const block_turbo4_0 \* xb, thread float \* cache\) \{[\s\S]*?\n\}\n\ntemplate <typename type4x4>\nvoid dequantize_turbo4_0/,
    `static void turbo4_dequantize_full_block(device const block_turbo4_0 * xb, thread float * cache) {
    const float norm = float(xb->norm);

    // Unpack 4-bit indices. The graph pre-rotates queries for TurboQuant,
    // so this path mirrors the CPU implementation's packed block layout.
    for (int j = 0; j < 128; j++) {
        const uint8_t packed = xb->qs[j / 2];
        const uint8_t idx = (j & 1) ? (packed >> 4) : (packed & 0x0F);
        cache[j] = turbo_centroids_4bit[idx] * norm;
    }
}

template <typename type4x4>
void dequantize_turbo4_0`,
  );

  const turbo4SetRowsKernel = `template<typename TI>
kernel void kernel_set_rows_turbo4(
        constant ggml_metal_kargs_set_rows & args,
        device const  void * src0,
        device const  void * src1,
        device       float * dst,
        uint3                tgpig[[threadgroup_position_in_grid]],
        uint                 tiitg[[thread_index_in_threadgroup]],
        uint3                tptg [[threads_per_threadgroup]]) {
    const int32_t i03 = tgpig.z;
    const int32_t i02 = tgpig.y;
    const int32_t i12 = i03%args.ne12;
    const int32_t i11 = i02%args.ne11;
    const int32_t i01 = tgpig.x*tptg.y + tiitg/tptg.x;
    if (i01 >= args.ne01) return;

    const int32_t i10 = i01;
    const TI      i1  = ((const device TI *) ((const device char *) src1 + i10*args.nb10 + i11*args.nb11 + i12*args.nb12))[0];

          device block_turbo4_0 * dst_row = (      device block_turbo4_0 *) ((      device char *) dst  +  i1*args.nb1  + i02*args.nb2  + i03*args.nb3);
    const device float          * src_row = (const device float          *) ((const device char *) src0 + i01*args.nb01 + i02*args.nb02 + i03*args.nb03);

    for (int ind = tiitg%tptg.x; ind < args.nk0; ind += tptg.x) {
        quantize_turbo4_0(src_row + QK_TURBO4*ind, dst_row[ind]);
    }
}

`;
  if (!source.includes("kernel void kernel_set_rows_turbo4(")) {
    source = source.replace(
      "\n// TurboQuant set_rows instantiations (block size 128)",
      `\n${turbo4SetRowsKernel}// TurboQuant set_rows instantiations (block size 128)`,
    );
  }

  const turbo4Instantiations = `typedef decltype(kernel_set_rows_turbo4<int64_t>) set_rows_turbo4_t;

template [[host_name("kernel_set_rows_turbo4_i64")]] kernel set_rows_turbo4_t kernel_set_rows_turbo4<int64_t>;
template [[host_name("kernel_set_rows_turbo4_i32")]] kernel set_rows_turbo4_t kernel_set_rows_turbo4<int32_t>;`;

  source = source.replace(
    /typedef decltype\(kernel_set_rows_turbo<int64_t, block_turbo4_0, QK_TURBO4, quantize_turbo4_0>\) set_rows_turbo4_t;\n\ntemplate \[\[host_name\("kernel_set_rows_turbo4_i64"\)\]\] kernel set_rows_turbo4_t kernel_set_rows_turbo<int64_t, block_turbo4_0, QK_TURBO4, quantize_turbo4_0>;\ntemplate \[\[host_name\("kernel_set_rows_turbo4_i32"\)\]\] kernel set_rows_turbo4_t kernel_set_rows_turbo<int32_t, block_turbo4_0, QK_TURBO4, quantize_turbo4_0>;/,
    turbo4Instantiations,
  );

  if (!source.includes('host_name("kernel_set_rows_turbo4_i64")')) {
    const disabledTurbo4Comment = `// Disabled for Metal until the fork's Turbo4 set_rows path is updated for the
// current block_turbo4_0 layout (norm + packed 4-bit indices, no residual signs).
// The stale specialization prevents the whole Metal library from compiling.`;
    if (source.includes(disabledTurbo4Comment)) {
      source = source.replace(disabledTurbo4Comment, turbo4Instantiations);
    } else {
      source = source.replace(
        /template \[\[host_name\("kernel_set_rows_turbo3_i32"\)\]\] kernel set_rows_turbo_t kernel_set_rows_turbo<int32_t, block_turbo3_0, QK_TURBO3, quantize_turbo3_0>;/,
        (match) => `${match}\n${turbo4Instantiations}`,
      );
    }
  }

  if (source !== original) {
    fs.writeFileSync(metalPath, source);
    console.log("[dflash-build] patched Metal Turbo4 shader support");
  }
}

function applyForkPatches(cacheDir, backend) {
  if (backend === "metal") {
    patchMetalTurbo4(cacheDir);
  }
}

function isRuntimeLibrary(name) {
  return (
    /^lib.*\.(dylib|so|dll)$/.test(name) ||
    /^lib.*\.so\.\d/.test(name) ||
    /^lib.*\.\d+(\.\d+)*\.dylib$/.test(name)
  );
}

function makeDarwinInstallSelfContained(outDir, names, buildBinDir) {
  if (process.platform !== "darwin") return;
  for (const name of names) {
    const file = path.join(outDir, name);
    tryRun("install_name_tool", ["-delete_rpath", buildBinDir, file]);
    tryRun("install_name_tool", ["-delete_rpath", path.dirname(file), file]);
    tryRun("install_name_tool", ["-delete_rpath", outDir, file]);
    tryRun("install_name_tool", ["-delete_rpath", path.resolve(outDir), file]);
    const rpath = isRuntimeLibrary(name) ? "@loader_path" : "@executable_path";
    tryRun("install_name_tool", ["-delete_rpath", rpath, file]);
    tryRun("install_name_tool", ["-add_rpath", rpath, file]);
  }
}

// Probe a freshly-built llama-server for kernel availability.
//
// For host targets, run `llama-server --help` and grep for kernel-specific
// flags / cache-type names. For cross-compiled targets (e.g. Android) the
// binary cannot run on the host; introspect the build directory for compiled
// object files instead (e.g. ggml-cuda/turbo3.cu.o,
// ggml-metal/turbo3.metal.air, etc.).
function probeKernels(target, buildDir, outDir) {
  const [platform, , backend] = target.split("-");
  const canRunOnHost = canRunTargetOnHost(target);
  const kernels = {
    dflash: false,
    turbo3: false,
    turbo4: false,
    turbo3_tcq: false,
    qjl_full: false,
    lookahead: true, // upstream
    ngramDraft: true, // upstream
  };

  if (canRunOnHost) {
    const serverBin = path.join(outDir, "llama-server");
    if (fs.existsSync(serverBin)) {
      const result = spawnSync(serverBin, ["--help"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        timeout: 30_000,
      });
      const help = `${result.stdout || ""}\n${result.stderr || ""}`;
      const lc = help.toLowerCase();
      kernels.dflash = /dflash/.test(lc);
      kernels.turbo3 = /turbo3/.test(lc);
      kernels.turbo4 = /turbo4/.test(lc);
      kernels.turbo3_tcq = /turbo3[_-]?tcq|tcq/.test(lc);
      kernels.qjl_full = /qjl[_-]?full|qjl/.test(lc);
    }
  } else {
    // Fall back to scanning compiled object files in the build directory.
    // Different backends emit different file extensions:
    //   CUDA:   ggml/src/ggml-cuda/<name>.cu.o
    //   Metal:  ggml/src/ggml-metal/<name>.metal.air (or .o for setup)
    //   Vulkan: ggml/src/ggml-vulkan/<name>.cpp.o + compiled SPIR-V
    //   CPU:    ggml/src/ggml-cpu/<name>.cpp.o
    const objects = collectFilesUnder(buildDir, /\.(o|air|spv)$/);
    const names = objects.join("\n").toLowerCase();
    // Per-backend kernels (CUDA/Metal/Vulkan emit per-kernel object files).
    kernels.dflash = /dflash|flash[-_]?attn[-_]?ext/.test(names);
    kernels.turbo3 = /turbo3/.test(names);
    kernels.turbo4 = /turbo4/.test(names);
    kernels.turbo3_tcq = /turbo3[-_]?tcq|tcq/.test(names);
    kernels.qjl_full = /qjl/.test(names);
    // CPU build inlines the turbo quantization paths inside ggml-cpu and
    // links a single ggml-turbo-quant.c.o into ggml-base. Treat its presence
    // as evidence both turbo3 and turbo4 paths are compiled in. Likewise,
    // the fork wires DFlash through ggml-cpu's flash-attn entry, so dflash
    // is also implicit when ggml-turbo-quant is present on CPU targets.
    if (backend === "cpu" && /ggml-turbo-quant\.c\.o/.test(names)) {
      kernels.turbo3 = true;
      kernels.turbo4 = true;
      kernels.dflash = true;
    }
    // For non-CPU backends, presence of the backend's flash-attn unit is a
    // strong proxy for dflash (the fork hangs DFlash off the existing FA
    // kernel registration).
    if (
      !kernels.dflash &&
      (backend === "cuda" || backend === "vulkan" || backend === "metal") &&
      /(flash[-_]?attn|fattn)/.test(names)
    ) {
      kernels.dflash = true;
    }
  }
  return kernels;
}

function canRunTargetOnHost(target) {
  const [platform, arch] = target.split("-");
  if (platform === "android") return false;
  if (platform === "windows" && process.platform !== "win32") return false;
  if (platform === "darwin" && process.platform !== "darwin") return false;
  if (platform === "linux" && process.platform !== "linux") return false;
  if (arch === "arm64" && process.arch !== "arm64") return false;
  if (arch === "x64" && process.arch !== "x64") return false;
  return true;
}

function collectFilesUnder(root, pattern) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && pattern.test(entry.name)) out.push(full);
    }
  }
  return out;
}

function writeCapabilities({
  outDir,
  target,
  buildDir,
  forkCommit,
  binaries,
}) {
  const [platform, arch, backend] = target.split("-");
  const kernels = probeKernels(target, buildDir, outDir);
  const capabilities = {
    target,
    platform,
    arch,
    backend,
    builtAt: new Date().toISOString(),
    fork: "spiritbuun/buun-llama-cpp",
    forkCommit,
    kernels,
    binaries,
  };
  fs.writeFileSync(
    path.join(outDir, "CAPABILITIES.json"),
    `${JSON.stringify(capabilities, null, 2)}\n`,
  );
  return capabilities;
}

function targetOutDir(target, override) {
  if (override) return override;
  return path.join(stateDir(), "local-inference", "bin", "dflash", target);
}

// Build a single target. Returns the resulting CAPABILITIES.json object.
function buildTarget({ target, args, ctx }) {
  const [, , backend] = target.split("-");
  const outDir = targetOutDir(target, args.outDirOverride);
  const buildDir = path.join(args.cacheDir, "build", target);
  const flags = cmakeFlagsForTarget(target, ctx);

  if (args.dryRun) {
    console.log(`[dflash-build] (dry-run) target=${target}`);
    console.log(
      `  cmake -B ${buildDir} ${flags.join(" ")}`.replace(/ +/g, " "),
    );
    console.log(
      `  cmake --build ${buildDir} --target llama-server llama-cli llama-speculative-simple -j ${args.jobs}`,
    );
    console.log(`  install -> ${outDir}`);
    return null;
  }

  console.log(`[dflash-build] building target=${target}`);
  applyForkPatches(args.cacheDir, backend);

  fs.mkdirSync(buildDir, { recursive: true });
  run("cmake", ["-B", buildDir, ...flags], { cwd: args.cacheDir });
  run(
    "cmake",
    [
      "--build",
      buildDir,
      "--target",
      "llama-server",
      "llama-cli",
      "llama-speculative-simple",
      "-j",
      String(args.jobs),
    ],
    { cwd: args.cacheDir },
  );

  const binDir = path.join(buildDir, "bin");
  fs.mkdirSync(outDir, { recursive: true });
  const executableNames = [
    "llama-server",
    "llama-cli",
    "llama-speculative-simple",
  ];
  // Cross-compiled binaries can have a host-specific suffix (.exe). Match by
  // base name so windows builds still install the right files.
  const installedNames = [];
  if (fs.existsSync(binDir)) {
    for (const name of fs.readdirSync(binDir)) {
      const base = name.replace(/\.(exe)$/i, "");
      if (executableNames.includes(base) || isRuntimeLibrary(name)) {
        installedNames.push(name);
      }
    }
  }
  for (const name of installedNames) {
    const src = path.join(binDir, name);
    const dst = path.join(outDir, name);
    fs.copyFileSync(src, dst);
    if (executableNames.includes(name.replace(/\.(exe)$/i, ""))) {
      fs.chmodSync(dst, 0o755);
    }
  }

  const ggufPySrc = path.join(args.cacheDir, "gguf-py");
  const ggufPyDst = path.join(outDir, "gguf-py");
  if (fs.existsSync(ggufPySrc)) {
    fs.rmSync(ggufPyDst, { recursive: true, force: true });
    fs.cpSync(ggufPySrc, ggufPyDst, { recursive: true });
  }
  makeDarwinInstallSelfContained(outDir, installedNames, binDir);

  const installedBaseNames = installedNames
    .map((name) => name.replace(/\.(exe)$/i, ""))
    .filter((name) => executableNames.includes(name));

  const capabilities = writeCapabilities({
    outDir,
    target,
    buildDir,
    forkCommit: ctx.forkCommit,
    binaries: installedBaseNames,
  });
  console.log(
    `[dflash-build] installed ${target} binaries to ${outDir} (kernels: ${Object.entries(
      capabilities.kernels,
    )
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "none"})`,
  );
  return capabilities;
}

function build(args) {
  if (!has("git")) throw new Error("git is required");
  if (!has("cmake")) throw new Error("cmake is required");

  // Build host context once for compatibility checks and toolchain wiring.
  const androidNdk = resolveAndroidNdk();
  const ctx = {
    androidNdk,
    androidVulkanInclude: findAndroidVulkanInclude(androidNdk),
    glslc: findGlslc(androidNdk),
    forkCommit: "",
  };

  // Decide the target list.
  let targets;
  if (args.all) {
    targets = SUPPORTED_TARGETS.slice();
  } else if (args.targets && args.targets.length > 0) {
    targets = args.targets.slice();
  } else {
    // Legacy single-target mode.
    const backend = args.backend || detectBackend();
    const arch = process.arch === "x64" ? "x64" : process.arch;
    const platform =
      process.platform === "win32" ? "windows" : process.platform;
    const legacyTarget = `${platform}-${arch}-${backend}`;
    targets = [legacyTarget];
    if (!SUPPORTED_TARGETS.includes(legacyTarget)) {
      console.warn(
        `[dflash-build] warning: legacy backend produced unsupported target ${legacyTarget}; proceeding anyway`,
      );
    }
  }

  if (!args.dryRun) {
    ctx.forkCommit = ensureCheckout(args.cacheDir, args.ref);
  } else if (fs.existsSync(path.join(args.cacheDir, ".git"))) {
    ctx.forkCommit = run("git", ["rev-parse", "HEAD"], {
      cwd: args.cacheDir,
      capture: true,
    });
  }

  const built = [];
  const skipped = [];
  for (const target of targets) {
    const compat = targetCompatibility(target, ctx);
    if (!compat.ok) {
      console.log(
        `[dflash-build] skip target=${target}: ${compat.reason}`,
      );
      skipped.push({ target, reason: compat.reason });
      if (args.targets && args.targets.length > 0 && !args.all) {
        // Explicit single --target should fail loudly rather than silently skip.
        throw new Error(
          `target ${target} is not buildable on this host: ${compat.reason}`,
        );
      }
      continue;
    }
    try {
      const capabilities = buildTarget({ target, args, ctx });
      built.push({ target, capabilities });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (args.all) {
        console.error(`[dflash-build] target=${target} failed: ${message}`);
        skipped.push({ target, reason: `build failed: ${message}` });
      } else {
        throw err;
      }
    }
  }

  if (args.dryRun) {
    console.log(
      `[dflash-build] dry-run: ${targets.length - skipped.length} targets queued, ${skipped.length} skipped`,
    );
  } else {
    console.log(
      `[dflash-build] done. built=${built.length} skipped=${skipped.length}`,
    );
    console.log(
      `[dflash-build] set ELIZA_DFLASH_ENABLED=1 to force this backend, or leave it unset for auto-detect from the managed path.`,
    );
  }
}

try {
  build(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(
    `[dflash-build] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
