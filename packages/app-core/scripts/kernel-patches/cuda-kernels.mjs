// AUTHORED — hardware-verify pending (no NVIDIA HW on the authoring machine).
//
// Stages the standalone CUDA fused-attention kernel from
// packages/inference/cuda/ into the elizaOS/llama.cpp fork at
// ggml/src/ggml-cuda/<name>.cu. The fork's ggml-cuda/CMakeLists.txt uses
// `file(GLOB GGML_SOURCES_CUDA "*.cu")`, so a new .cu in that directory is
// picked up unconditionally; the file body is gated by GGML_CUDA_FUSED_ATTN_QJL
// so a no-flag build still emits an empty object.
//
// The matching cmake flag (-DGGML_CUDA_FUSED_ATTN_QJL=ON, exported as
// CUDA_KERNEL_CMAKE_FLAGS) and the add_compile_definitions(GGML_CUDA_FUSED_ATTN_QJL)
// CMakeLists patch (patchGgmlCudaForFusedAttn) both live in
// build-llama-cpp-dflash.mjs; its applyForkPatches() calls patchCudaKernels +
// patchGgmlCudaForFusedAttn for CUDA targets and its cuda branch pushes
// CUDA_KERNEL_CMAKE_FLAGS. A build without the flag (or anyone running this
// staging step alone) gets a staged-but-inert TU — the symbol compiles to an
// empty object, which is the correct state: fused_attn is an optimization on
// top of the five required kernels (AGENTS.md §3), not a required kernel.
//
// Hard-throws on any error (missing source, missing fork dir, fs failure) — per
// AGENTS.md §3 the build must exit non-zero rather than silently produce a
// kernel-missing artifact.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// packages/app-core/scripts/kernel-patches/  ->  packages/inference/cuda/
const STANDALONE_CUDA_DIR = path.resolve(
  __dirname, "..", "..", "..", "inference", "cuda",
);

// standalone-filename -> in-fork relative path under cacheDir.
export const CUDA_KERNEL_FILES = ["fused-attn-qjl-tbq.cu"];

// The cmake flag the build script must pass for these TUs to compile a body
// (consumed by build-llama-cpp-dflash.mjs's `backend === "cuda"` branch).
export const CUDA_KERNEL_CMAKE_FLAGS = ["-DGGML_CUDA_FUSED_ATTN_QJL=ON"];

const SENTINEL = "// MILADY-CUDA-KERNEL-PATCH-V1";

function assertStandalonesPresent() {
  const missing = [];
  for (const name of CUDA_KERNEL_FILES) {
    const src = path.join(STANDALONE_CUDA_DIR, name);
    if (!fs.existsSync(src)) { missing.push(src); continue; }
    const st = fs.statSync(src);
    if (!st.isFile() || st.size === 0) missing.push(`${src} (not a file or empty)`);
  }
  if (missing.length > 0) {
    throw new Error(
      `[cuda-kernels] missing/invalid standalone CUDA sources:\n  ${missing.join("\n  ")}`,
    );
  }
}

export function patchCudaKernels(cacheDir, { dryRun = false } = {}) {
  assertStandalonesPresent();
  const targetDir = path.join(cacheDir, "ggml", "src", "ggml-cuda");
  if (dryRun) {
    console.log(`[cuda-kernels] (dry-run) ensure dir ${targetDir}`);
  } else if (!fs.existsSync(targetDir)) {
    throw new Error(`[cuda-kernels] expected ggml-cuda/ to exist in fork: ${targetDir}`);
  }
  const copied = [];
  for (const name of CUDA_KERNEL_FILES) {
    const src = path.join(STANDALONE_CUDA_DIR, name);
    const dst = path.join(targetDir, name);
    if (dryRun) {
      console.log(`[cuda-kernels] (dry-run) cp ${src} -> ${dst}`);
    } else {
      const text = fs.readFileSync(src, "utf8");
      const stamped =
        `${SENTINEL} — staged from packages/inference/cuda/${name} by\n` +
        `// build-llama-cpp-dflash.mjs. Frozen — do not edit in fork. Body gated by\n` +
        `// GGML_CUDA_FUSED_ATTN_QJL (build flag set in build-llama-cpp-dflash.mjs).\n` +
        text;
      fs.writeFileSync(dst, stamped, "utf8");
    }
    copied.push(name);
  }
  console.log(
    `[cuda-kernels] ${dryRun ? "(dry-run) " : ""}staged ${copied.length} CUDA kernel(s): ${copied.join(", ")}` +
    ` (needs ${CUDA_KERNEL_CMAKE_FLAGS.join(" ")} from build-llama-cpp-dflash.mjs)`,
  );
  return { copied, cmakeFlags: CUDA_KERNEL_CMAKE_FLAGS };
}
