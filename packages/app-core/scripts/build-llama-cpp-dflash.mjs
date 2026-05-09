#!/usr/bin/env node
/**
 * Build the DFlash-capable llama-server fork used by local inference.
 *
 * Upstream ggml-org/llama.cpp does not yet ship DFlash. This script builds
 * spiritbuun/buun-llama-cpp into:
 *   $ELIZA_STATE_DIR/local-inference/bin/dflash/<platform>-<arch>-<backend>/
 *
 * Backend selection:
 *   macOS           -> Metal
 *   Linux + nvcc    -> CUDA
 *   Linux + rocminfo/hipcc -> ROCm/HIP
 *   otherwise       -> CPU
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

function cmakeFlagsForBackend(backend) {
  const flags = ["-DGGML_NATIVE=ON", "-DLLAMA_BUILD_TESTS=OFF"];
  if (backend === "metal") {
    flags.push("-DGGML_METAL=ON");
  } else if (backend === "cuda") {
    flags.push(
      "-DGGML_CUDA=ON",
      "-DGGML_CUDA_FA=ON",
      "-DGGML_CUDA_FA_ALL_QUANTS=ON",
    );
  } else if (backend === "rocm" || backend === "hip") {
    flags.push("-DGGML_HIP=ON");
  }
  const extra = process.env.ELIZA_DFLASH_CMAKE_FLAGS?.trim();
  if (extra) flags.push(...extra.split(/\s+/).filter(Boolean));
  return flags;
}

function parseArgs(argv) {
  const backend = detectBackend();
  const platformKey = `${process.platform}-${process.arch}-${backend}`;
  const root = path.join(stateDir(), "local-inference");
  const args = {
    cacheDir: path.join(
      os.homedir(),
      ".cache",
      "eliza-dflash",
      "buun-llama-cpp",
    ),
    outDir: path.join(root, "bin", "dflash", platformKey),
    backend,
    ref: REF,
    jobs: Math.max(1, Math.min(os.cpus().length, 16)),
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
    else if (arg === "--out-dir") args.outDir = path.resolve(next());
    else if (arg === "--backend") args.backend = next();
    else if (arg === "--ref") args.ref = next();
    else if (arg === "--jobs" || arg === "-j")
      args.jobs = Number.parseInt(next(), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node packages/app-core/scripts/build-llama-cpp-dflash.mjs [--backend cuda|metal|rocm|cpu] [--ref <git-ref>] [--out-dir <path>] [--jobs N]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

// DRAFT: copies repo-local Vulkan compute shaders into the fork's source tree
// so a custom build can experiment with the turbo3 / turbo4 / turbo3_tcq
// kernel ports under local-inference/kernels/vulkan/. Default OFF — the user
// must set ELIZA_DFLASH_PATCH_VULKAN_KERNELS=1 to opt in for hardware testing.
// See local-inference/kernels/README.md.
function patchVulkanKernels(cacheDir) {
  if (process.env.ELIZA_DFLASH_PATCH_VULKAN_KERNELS !== "1") return;
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
  const srcDir = path.join(repoRoot, "local-inference", "kernels", "vulkan");
  if (!fs.existsSync(srcDir)) {
    console.warn(`[dflash-build] patchVulkanKernels: ${srcDir} missing, skipping`);
    return;
  }
  const dstDir = path.join(cacheDir, "ggml", "src", "ggml-vulkan", "vulkan-shaders");
  if (!fs.existsSync(dstDir)) {
    console.warn(`[dflash-build] patchVulkanKernels: ${dstDir} missing in fork, skipping`);
    return;
  }
  for (const name of ["turbo3.comp", "turbo4.comp", "turbo3_tcq.comp"]) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dstDir, name));
  }
  console.log(
    "[dflash-build] DRAFT patchVulkanKernels applied — kernels NOT validated on hardware",
  );
}

// DRAFT: copies the repo-local Metal turbo3 / turbo3_tcq shader sources into
// the fork. Default OFF — set ELIZA_DFLASH_PATCH_METAL_TURBO3=1 to opt in.
// patchMetalTurbo4 above is unrelated and always runs in metal builds.
function patchMetalTurbo3Tcq(cacheDir) {
  if (process.env.ELIZA_DFLASH_PATCH_METAL_TURBO3 !== "1") return;
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
  const srcDir = path.join(repoRoot, "local-inference", "kernels", "metal");
  if (!fs.existsSync(srcDir)) {
    console.warn(`[dflash-build] patchMetalTurbo3Tcq: ${srcDir} missing, skipping`);
    return;
  }
  const dstDir = path.join(cacheDir, "ggml", "src", "ggml-metal");
  if (!fs.existsSync(dstDir)) {
    console.warn(`[dflash-build] patchMetalTurbo3Tcq: ${dstDir} missing in fork, skipping`);
    return;
  }
  for (const name of ["turbo3.metal", "turbo3_tcq.metal"]) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dstDir, name));
  }
  console.log(
    "[dflash-build] DRAFT patchMetalTurbo3Tcq applied — kernels NOT validated on hardware",
  );
}

function applyForkPatches(cacheDir, backend) {
  if (backend === "metal") {
    patchMetalTurbo4(cacheDir);
    patchMetalTurbo3Tcq(cacheDir);
  }
  if (backend === "vulkan") {
    patchVulkanKernels(cacheDir);
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

function build(args) {
  if (!has("git")) throw new Error("git is required");
  if (!has("cmake")) throw new Error("cmake is required");

  ensureCheckout(args.cacheDir, args.ref);
  applyForkPatches(args.cacheDir, args.backend);
  const buildDir = path.join(args.cacheDir, "build", args.backend);
  fs.mkdirSync(buildDir, { recursive: true });
  run("cmake", ["-B", buildDir, ...cmakeFlagsForBackend(args.backend)], {
    cwd: args.cacheDir,
  });
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
  fs.mkdirSync(args.outDir, { recursive: true });
  const executableNames = [
    "llama-server",
    "llama-cli",
    "llama-speculative-simple",
  ];
  const runtimeNames = fs
    .readdirSync(binDir)
    .filter((name) => executableNames.includes(name) || isRuntimeLibrary(name));

  for (const name of runtimeNames) {
    const src = path.join(binDir, name);
    const dst = path.join(args.outDir, name);
    if (!fs.existsSync(src)) throw new Error(`missing built binary: ${src}`);
    fs.copyFileSync(src, dst);
    if (executableNames.includes(name)) fs.chmodSync(dst, 0o755);
  }
  const ggufPySrc = path.join(args.cacheDir, "gguf-py");
  const ggufPyDst = path.join(args.outDir, "gguf-py");
  if (fs.existsSync(ggufPySrc)) {
    fs.rmSync(ggufPyDst, { recursive: true, force: true });
    fs.cpSync(ggufPySrc, ggufPyDst, { recursive: true });
  }
  makeDarwinInstallSelfContained(args.outDir, runtimeNames, binDir);
  console.log(
    `[dflash-build] installed ${args.backend} binaries to ${args.outDir}`,
  );
  console.log(
    `[dflash-build] set ELIZA_DFLASH_ENABLED=1 to force this backend, or leave it unset for auto-detect from the managed path.`,
  );
}

try {
  build(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(
    `[dflash-build] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
