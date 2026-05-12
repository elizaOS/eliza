// CPU SIMD kernel staging for the elizaOS/llama.cpp fork (v1.0.0-eliza) (Wave A1 wiring).
//
// What this module does:
//
//   1. Mirrors the verified standalone CPU SIMD translation units from
//      packages/native-plugins/qjl-cpu/{src,include} over the fork's
//      ggml/src/ggml-cpu/qjl/ directory. The fork's checkout is `git reset
//      --hard`'d on every build, so this is the only place the new
//      avx-vnni / dotprod / int8-sketch TUs (and the runtime-cpuid
//      dispatcher rewrite) can land — direct edits to the fork don't
//      persist. quants-qjl.c is fork-only ggml glue and is preserved.
//
//   2. Regenerates the QJL source list inside ggml/src/ggml-cpu/CMakeLists.txt
//      so the new files compile, and adds the QJL_HAVE_* target
//      compile-definitions the runtime dispatcher keys off (so a binary
//      built with -DGGML_AVX_VNNI=ON dispatches to the AVX-VNNI int8
//      score path, and an AArch64 build with +dotprod dispatches to the
//      SDOT/UDOT one). The per-TU SIMD bodies self-guard on __AVX2__ /
//      __AVXVNNI__ / __ARM_FEATURE_DOTPROD, so they're always listed and
//      the global ARCH_FLAGS (e.g. -march=native) decide which bodies
//      survive preprocessing.
//
// Idempotent: each mutation carries a `# ELIZA-CPU-SIMD-PATCH-V1`
// sentinel; re-running the build is safe.
//
// Out of scope (documented in the agent report):
//
//   * Mirroring polarquant-cpu/ as a fork subdir. The fork's
//     ggml-cpu/quants-polar.c + fused-q4-polar-dot*.c already define
//     ggml_vec_dot_q4_polar_q8_0 (with a different signature) and
//     ggml-base's ggml-quants.c already defines polar_hadamard_inplace /
//     polar_qjl_signs / {de,}quantize_row_q4_polar_ref, so dropping
//     polarquant-cpu's polar_dispatch.c / polar_hadamard.c / polar_qjl.c
//     into the build would collide at link time. Wiring the new polar
//     `_preht` AVX2/NEON path needs the fork's polar op surface rewired
//     to the polarquant-cpu API first — a fork-source change, not a
//     patcher.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// packages/app-core/scripts/kernel-patches -> packages/native-plugins/qjl-cpu
const QJL_CPU_SRC_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "native-plugins",
  "qjl-cpu",
);

const SENTINEL = "# ELIZA-CPU-SIMD-PATCH-V1";

// The QJL kernel-library files mirrored into ggml-cpu/qjl/. quants-qjl.c is
// deliberately NOT in this list — it is fork-only ggml ABI glue, not part of
// the standalone kernel library, and must survive the mirror untouched.
const QJL_SRC_FILES = [
  "qjl_block.h",
  "qjl_cpu_features.h",
  "qjl_dispatch.c",
  "qjl_projection.c",
  "qjl_quantize_ref.c",
  "qjl_quantize_avx2.c",
  "qjl_quantize_neon.c",
  "qjl_score_ref.c",
  "qjl_score_i8_ref.c",
  "qjl_score_avx2.c",
  "qjl_score_avxvnni.c",
  "qjl_score_neon.c",
  "qjl_score_dotprod.c",
];

// The CMakeLists `GGML_CPU_SOURCES` lines that list the QJL kernel TUs. We
// rewrite the whole block so adding/removing files is a single source of
// truth (QJL_SRC_FILES above). quants-qjl.c stays first (it includes
// ggml-common.h and pulls in the rest).
function qjlSourceListBlock() {
  const lines = ["        ggml-cpu/qjl/quants-qjl.c"];
  for (const f of QJL_SRC_FILES) {
    lines.push(`        ggml-cpu/qjl/${f}`);
  }
  return lines.join("\n");
}

function mirrorQjlSources(cacheDir, { dryRun }) {
  const srcRoot = path.join(QJL_CPU_SRC_DIR, "src");
  const incFile = path.join(QJL_CPU_SRC_DIR, "include", "qjl", "qjl.h");
  const forkQjlDir = path.join(cacheDir, "ggml", "src", "ggml-cpu", "qjl");
  const forkQjlIncDir = path.join(forkQjlDir, "include", "qjl");
  if (!fs.existsSync(forkQjlDir)) {
    throw new Error(
      `[cpu-simd-kernels] expected fork ggml-cpu/qjl/ to exist: ${forkQjlDir}`,
    );
  }
  for (const f of QJL_SRC_FILES) {
    const src = path.join(srcRoot, f);
    if (!fs.existsSync(src)) {
      throw new Error(`[cpu-simd-kernels] missing qjl-cpu source: ${src}`);
    }
  }
  if (!fs.existsSync(incFile)) {
    throw new Error(`[cpu-simd-kernels] missing qjl public header: ${incFile}`);
  }
  if (dryRun) {
    console.log(
      `[cpu-simd-kernels] (dry-run) would mirror ${QJL_SRC_FILES.length} qjl TUs + qjl.h into ${forkQjlDir}`,
    );
    return QJL_SRC_FILES.length;
  }
  fs.mkdirSync(forkQjlIncDir, { recursive: true });
  for (const f of QJL_SRC_FILES) {
    fs.copyFileSync(path.join(srcRoot, f), path.join(forkQjlDir, f));
  }
  fs.copyFileSync(incFile, path.join(forkQjlIncDir, "qjl.h"));
  return QJL_SRC_FILES.length;
}

function patchGgmlCpuCMakeLists(cacheDir, { dryRun }) {
  const cmakePath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-cpu",
    "CMakeLists.txt",
  );
  if (!fs.existsSync(cmakePath)) {
    throw new Error(`[cpu-simd-kernels] missing ${cmakePath}`);
  }
  const original = fs.readFileSync(cmakePath, "utf8");
  let patched = original;

  // (a) Rewrite the QJL source list to the canonical set. The fork's stale
  // block lists: quants-qjl.c, qjl_block.h, qjl_dispatch.c, qjl_projection.c,
  // qjl_quantize_{ref,avx2,neon}.c, qjl_score_{ref,avx2,neon}.c. Match it
  // (with or without the SENTINEL already present) and replace with the
  // current set plus a sentinel comment.
  const blockRe =
    /([ \t]*ggml-cpu\/qjl\/quants-qjl\.c\n)(?:[ \t]*ggml-cpu\/qjl\/[^\n]+\n)+/;
  const m = patched.match(blockRe);
  if (!m) {
    throw new Error(
      `[cpu-simd-kernels] QJL source block not found in ${cmakePath}; ` +
        `the fork layout has changed.`,
    );
  }
  const replacementBlock = `        ${SENTINEL} — QJL kernel TUs mirrored from packages/native-plugins/qjl-cpu
${qjlSourceListBlock()}
`;
  if (!patched.includes(`${SENTINEL} — QJL kernel TUs`)) {
    patched = patched.replace(blockRe, replacementBlock);
  } else {
    // Sentinel present: still re-normalise the block in case QJL_SRC_FILES
    // changed since the last run (the cached checkout is reset --hard'd
    // anyway, but be defensive about partial states).
    const sentinelBlockRe = new RegExp(
      `[ \\t]*${SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — QJL kernel TUs[^\\n]*\\n(?:[ \\t]*ggml-cpu\\/qjl\\/[^\\n]+\\n)+`,
    );
    patched = patched.replace(sentinelBlockRe, replacementBlock);
  }

  // (b) Add the QJL_HAVE_* runtime-dispatch defines. Inject right after the
  // target_include_directories(... ggml-cpu/qjl/include ggml-cpu/qjl) line.
  const incAnchor =
    "    target_include_directories(${GGML_CPU_NAME} PRIVATE ggml-cpu/qjl/include ggml-cpu/qjl)";
  if (!patched.includes(incAnchor)) {
    throw new Error(
      `[cpu-simd-kernels] QJL include-dir anchor not found in ${cmakePath}`,
    );
  }
  const defsSentinel = `${SENTINEL} QJL_HAVE_* dispatch defines`;
  if (!patched.includes(defsSentinel)) {
    const defsBlock = `${incAnchor}

    ${defsSentinel}
    # The runtime QJL dispatcher (ggml-cpu/qjl/qjl_dispatch.c) picks the
    # best *available* SIMD path at run time from cpuid/hwcap, but it can
    # only call into a path whose TU was actually compiled. Expose the
    # QJL_HAVE_* feature macros so the dispatcher knows which symbols were
    # linked; the per-TU bodies still self-guard on __AVX2__ / __AVXVNNI__
    # / __ARM_FEATURE_DOTPROD so a host without the ISA gets a dead body,
    # never an undefined symbol.
    if (GGML_SYSTEM_ARCH STREQUAL "x86")
        target_compile_definitions(\${GGML_CPU_NAME} PRIVATE QJL_HAVE_AVX2=1)
        if (GGML_AVX_VNNI)
            # build-llama-cpp-dflash.mjs sets -DGGML_AVX_VNNI=ON only for
            # native x86_64 hosts that report avx_vnni, which is exactly
            # when the global ARCH_FLAGS make __AVXVNNI__ available.
            target_compile_definitions(\${GGML_CPU_NAME} PRIVATE QJL_HAVE_AVXVNNI=1)
        endif()
    elseif (GGML_SYSTEM_ARCH STREQUAL "ARM")
        target_compile_definitions(\${GGML_CPU_NAME} PRIVATE QJL_HAVE_NEON=1)
        if (GGML_INTERNAL_DOTPROD OR GGML_USE_DOTPROD)
            target_compile_definitions(\${GGML_CPU_NAME} PRIVATE QJL_HAVE_NEON_DOTPROD=1)
        endif()
    endif()`;
    patched = patched.replace(incAnchor, defsBlock);
  }

  if (patched !== original && !dryRun) {
    fs.writeFileSync(cmakePath, patched, "utf8");
  }
  return { path: cmakePath, changed: patched !== original };
}

// Public entry point. Mirrors the QJL CPU SIMD TUs into the fork and wires
// them into the ggml-cpu build. Returns a summary for the build log.
export function patchCpuSimdKernels(cacheDir, { dryRun = false } = {}) {
  if (!cacheDir || !fs.existsSync(cacheDir)) {
    throw new Error(`[cpu-simd-kernels] cacheDir does not exist: ${cacheDir}`);
  }
  const mirrored = mirrorQjlSources(cacheDir, { dryRun });
  const cmake = patchGgmlCpuCMakeLists(cacheDir, { dryRun });
  console.log(
    `[cpu-simd-kernels] ${dryRun ? "(dry-run) " : ""}mirrored ${mirrored} QJL kernel TUs + qjl.h into ggml-cpu/qjl/; ` +
      `ggml-cpu/CMakeLists.txt ${cmake.changed ? "patched" : "already-current"} ` +
      `(QJL source list + QJL_HAVE_* dispatch defines).`,
  );
  return { mirrored, cmake };
}

// Files the Windows / Android / Apple ggml-base link must also pull in (the
// PE/COFF + `-undefined error` + lld-default `-z defs` link of a standalone
// ggml-base needs every QJL symbol referenced by ggml.c resolved at link
// time). quants-qjl.c (the ggml ABI glue) plus every kernel-library .c TU.
// patchGgmlBaseForWindowsQjl() in build-llama-cpp-dflash.mjs imports this so
// the two source lists stay in sync.
export const QJL_GGML_BASE_LINK_FILES = [
  "ggml-cpu/qjl/quants-qjl.c",
  ...QJL_SRC_FILES.filter((f) => f.endsWith(".c")).map(
    (f) => `ggml-cpu/qjl/${f}`,
  ),
];
