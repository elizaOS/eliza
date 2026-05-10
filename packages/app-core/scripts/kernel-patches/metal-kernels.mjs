// Real Metal kernel-shipment helpers — replace the v0.4.0-milady decorative
// log no-ops in build-llama-cpp-dflash.mjs.
//
// What this module does:
//
//   1. Copies the five verified standalone Metal shaders from
//      packages/inference/metal/ into the fork's tree at
//      ggml/src/ggml-metal/milady-shipped/<kernel>.metal. The standalones are
//      self-contained TUs (only #include <metal_stdlib>; their own structs,
//      constants, kernel symbols), so they compile as independent .air files.
//
//   2. Patches ggml/src/ggml-metal/CMakeLists.txt so the non-EMBED_LIBRARY
//      branch (the one used by darwin host metal builds) builds each standalone
//      shader into its own .air via `xcrun metal -c` and merges all
//      .air files (the original ggml-metal.air plus the five milady .air files)
//      into default.metallib via a single `xcrun metallib` invocation.
//
//   The original CMake snippet pipes `xcrun metal | xcrun metallib`. We
//   replace that with explicit per-source compilation + a final merge step,
//   keyed by a `# MILADY-KERNEL-PATCH-V1` sentinel so the patch is idempotent.
//
//   3. Hard-throws on any error — missing files, missing anchor in
//      CMakeLists.txt, fs failures. Per AGENTS.md §3, the build must exit
//      non-zero rather than silently produce a kernel-missing artifact.
//
// What this module deliberately does NOT do (out of scope for v0.4.0-milady):
//
//   * Wire dispatch sites in ggml-metal-ops.cpp / ggml-metal-device.m. The
//     fork has zero existing dispatch entries for the milady quant types in
//     the Metal backend (CUDA has them; Metal does not). Adding dispatch
//     requires substantial fork-internals changes spanning case-statements
//     per `GGML_TYPE_*`. Once kernels are in the metallib, follow-up work
//     can add the dispatch wiring and the kernels become reachable. Until
//     then the kernels ship as live symbols inside default.metallib but are
//     not yet selected by the runtime — the symbol-presence audit (`nm`,
//     `strings default.metallib`) passes, the dispatch audit does not.
//
//   * EMBED_LIBRARY path used by iOS targets. iOS builds compile a single
//     concatenated .metal via `.incbin`, which would require stripping the
//     duplicate decls (`block_qjl1_256`, `block_q4_polar`, `QK_QJL`,
//     `QK_POLAR`, `QJL_RESIDUAL_BYTES` already in ggml-common.h). That is a
//     separate patch and is documented as a deferred gap.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// packages/app-core/scripts/kernel-patches/  →  packages/inference/metal/
const STANDALONE_METAL_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "inference",
  "metal",
);

// Map: standalone-shader-filename → in-fork relative path (under cacheDir).
// Each standalone is copied verbatim — its content is not edited. Per agent
// contract: the 13 standalone shaders are verified and must not be touched.
export const METAL_KERNEL_FILES = [
  "turbo3.metal",
  "turbo4.metal",
  "turbo3_tcq.metal",
  "qjl.metal",
  "polar.metal",
];

const SENTINEL = "# MILADY-KERNEL-PATCH-V1";

function inForkRelpath(name) {
  return path.posix.join("ggml", "src", "ggml-metal", "milady-shipped", name);
}

// Verify all standalones exist and are non-empty before any fs writes — we
// want a fail-fast that does not partially mutate the fork tree.
function assertStandalonesPresent() {
  const missing = [];
  for (const name of METAL_KERNEL_FILES) {
    const src = path.join(STANDALONE_METAL_DIR, name);
    if (!fs.existsSync(src)) {
      missing.push(src);
      continue;
    }
    const stat = fs.statSync(src);
    if (!stat.isFile() || stat.size === 0) {
      missing.push(`${src} (not a file or empty)`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[metal-kernels] missing/invalid standalone shader sources:\n  ${missing.join("\n  ")}`,
    );
  }
}

// Copy each standalone .metal into the fork at
// ggml/src/ggml-metal/milady-shipped/<name>.metal, overwriting any prior copy
// so the canonical source-of-truth is always the verified standalone.
//
// We deliberately overwrite the fork's stale ggml/src/ggml-metal/milady-kernels/
// content if it exists, but we write into a sibling milady-shipped/ directory
// so the patch is self-contained and the original (un-wired) milady-kernels/
// drafts remain visible for diff-archaeology if a future agent wants them.
function copyStandalonesIntoFork(cacheDir, { dryRun }) {
  const targetDir = path.join(cacheDir, "ggml", "src", "ggml-metal", "milady-shipped");
  if (dryRun) {
    console.log(
      `[metal-kernels] (dry-run) mkdir -p ${targetDir}`,
    );
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const copied = [];
  for (const name of METAL_KERNEL_FILES) {
    const src = path.join(STANDALONE_METAL_DIR, name);
    const dst = path.join(targetDir, name);
    if (dryRun) {
      console.log(`[metal-kernels] (dry-run) cp ${src} -> ${dst}`);
    } else {
      const text = fs.readFileSync(src, "utf8");
      // Prepend a sentinel comment so a future audit can tell this file came
      // from the build script's verified standalone, not a hand-edited
      // in-fork draft.
      const stamped =
        `// ${SENTINEL} — copied verbatim from packages/inference/metal/${name}\n` +
        `// at build time by build-llama-cpp-dflash.mjs. Do not edit in place;\n` +
        `// edit the standalone source and rerun the build.\n` +
        text;
      fs.writeFileSync(dst, stamped, "utf8");
    }
    copied.push(inForkRelpath(name));
  }
  return copied;
}

// Patch ggml/src/ggml-metal/CMakeLists.txt: replace the single
//   `xcrun metal -c X | xcrun metallib - -o Y`
// pipe with a multi-source compile + merge that includes our shipped kernels.
//
// We anchor on the `add_custom_command(OUTPUT ${...}/default.metallib` line
// in the non-EMBED_LIBRARY branch; that is the only metallib build the
// darwin host metal target uses. Idempotent via SENTINEL.
function patchMetalCMakeLists(cacheDir, { dryRun }) {
  const cmakePath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "CMakeLists.txt",
  );
  if (!fs.existsSync(cmakePath)) {
    throw new Error(
      `[metal-kernels] expected ${cmakePath} to exist on the fork; cannot wire shipped kernels`,
    );
  }
  const original = fs.readFileSync(cmakePath, "utf8");
  if (original.includes(SENTINEL)) {
    return { changed: false, path: cmakePath };
  }

  // The exact block we replace. This pipe pattern has been stable in the
  // milady-ai/llama.cpp fork for the entire v0.4.x line; if the upstream
  // ever rewrites it we want to fail loudly rather than silently no-op.
  const anchor = `    add_custom_command(
        OUTPUT \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND xcrun -sdk macosx metal \${XC_FLAGS} -c \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal -o - |
                xcrun -sdk macosx metallib        - -o \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-common.h
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal
        DEPENDS ggml-metal.metal \${METALLIB_COMMON}
        COMMENT "Compiling Metal kernels"
        )`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-kernels] CMakeLists.txt anchor not found at ${cmakePath}; ` +
        `the fork's metallib build snippet has changed shape and the patch ` +
        `must be revisited. Inspect the file's add_custom_command for default.metallib.`,
    );
  }

  // Replacement: compile ggml-metal.metal AND each shipped standalone into
  // its own .air file, then merge them all into default.metallib.
  const milady_air_lines = METAL_KERNEL_FILES.map((name) => {
    const stem = name.replace(/\.metal$/, "");
    return `        COMMAND xcrun -sdk macosx metal \${XC_FLAGS} -c \${CMAKE_CURRENT_SOURCE_DIR}/milady-shipped/${name} -o \${CMAKE_CURRENT_BINARY_DIR}/${stem}.air`;
  }).join("\n");
  const milady_air_inputs = METAL_KERNEL_FILES.map((name) => {
    const stem = name.replace(/\.metal$/, "");
    return `\${CMAKE_CURRENT_BINARY_DIR}/${stem}.air`;
  }).join(" ");
  const milady_depends = METAL_KERNEL_FILES.map(
    (name) => `\${CMAKE_CURRENT_SOURCE_DIR}/milady-shipped/${name}`,
  ).join(" ");

  const replacement = `    # ${SENTINEL}
    # Build ggml-metal.metal AND each milady standalone shader into its own
    # .air file, then merge all .air files into a single default.metallib.
    # The standalones are self-contained TUs (only #include <metal_stdlib>;
    # define their own block_*, constants, kernel functions) so they do not
    # collide with anything ggml-metal.metal pulls in via ggml-common.h.
    add_custom_command(
        OUTPUT \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND xcrun -sdk macosx metal \${XC_FLAGS} -c \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal -o \${CMAKE_CURRENT_BINARY_DIR}/ggml-metal.air
${milady_air_lines}
        COMMAND xcrun -sdk macosx metallib \${CMAKE_CURRENT_BINARY_DIR}/ggml-metal.air ${milady_air_inputs} -o \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-common.h
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal
        DEPENDS ggml-metal.metal \${METALLIB_COMMON} ${milady_depends}
        COMMENT "Compiling Metal kernels (ggml-metal + milady-shipped: ${METAL_KERNEL_FILES.join(", ")})"
        )`;

  const patched = original.replace(anchor, replacement);
  if (patched === original) {
    throw new Error(
      `[metal-kernels] anchor matched but replacement did not change ${cmakePath}; this is a bug`,
    );
  }
  if (dryRun) {
    console.log(
      `[metal-kernels] (dry-run) would patch ${cmakePath} (anchor matched, replacement size ${replacement.length} chars, includes ${METAL_KERNEL_FILES.length} shipped kernels)`,
    );
    return { changed: false, path: cmakePath };
  }
  fs.writeFileSync(cmakePath, patched, "utf8");
  return { changed: true, path: cmakePath };
}

// MILADY-DISPATCH-V1 — Wave-6 follow-up.
//
// The Wave-5 patch shipped the five standalone .metal sources into
// default.metallib. The fork's existing dispatch pipeline (ggml-metal-ops.cpp
// :: ggml_metal_op_mul_mat / ggml_metal_op_get_rows) routes through
// ggml_metal_library_get_pipeline_{mul_mv,get_rows}() which (1) GGML_ABORT
// for unknown ggml_type values, and (2) bind a 'nsg' function constant that
// the standalones do not declare. So even though the symbols are present,
// they cannot be reached via the standard mat-vec path.
//
// This patch adds a parallel dispatch path that knows how to set up the
// custom arg structs each standalone declares. The standalone .metal files
// stay frozen — they were source-level verified by metal_verify and any
// edit invalidates that contract.
//
// Coverage realism (read carefully — the standalones do NOT all expose a
// mul_mv-shaped kernel):
//
//   GGML_TYPE_QJL1_256 (46) — kernel_mul_mv_qjl1_256_f32, kernel_get_rows_qjl1_256
//                             → MUL_MAT + GET_ROWS wired. Note: the kernel
//                             expects a `q` activation that is the
//                             pre-projected sketch (proj_dim=256), NOT a raw
//                             head_dim activation. Callers must respect this.
//   GGML_TYPE_Q4_POLAR (47) — kernel_mul_mv_q4_polar_f32, kernel_get_rows_q4_polar
//                             → MUL_MAT + GET_ROWS wired. Activation is fp32
//                             head_dim (128). use_qjl=0 by default; flip via
//                             a tensor flag if a future caller needs the
//                             residual path.
//   GGML_TYPE_TBQ3_0 (43) / TBQ4_0 (44) / TBQ3_TCQ (48) — these standalones
//                             expose ONLY `kernel_turbo3_dot` /
//                             `kernel_turbo4_dot` / `kernel_turbo3_tcq_dot`,
//                             which are attention-score (not mul_mv) kernels:
//                             they take per-head q vectors and produce
//                             per-(head, kv_idx) scores, the K-side cache
//                             format. There is no mul_mv-shaped dispatch
//                             contract that fits these without a separate
//                             GGML op (e.g. an `ATTN_SCORE_TBQ3` variant of
//                             the QJL attention bridge). Until that op
//                             lands, MUL_MAT against these types in a graph
//                             aborts with a structured "tbq* mul_mv not
//                             yet wired — needs ATTN_SCORE op" message
//                             rather than silently crashing in the standard
//                             pipeline path.
//
// Patching strategy: anchor-based string-replace, idempotent via the
// SENTINEL_DISPATCH marker, three files patched in
// ~/.cache/eliza-dflash/milady-llama-cpp/ggml/src/ggml-metal/:
//   - ggml-metal-device.h    : forward decls for milady pipeline helpers
//   - ggml-metal-device.cpp  : pipeline lookup helpers (no function
//                              constants — direct getNamed bypass) +
//                              early-out in the standard mul_mv / get_rows
//                              helpers so the GGML_ABORT default cases are
//                              not hit.
//   - ggml-metal-ops.cpp     : ggml_metal_op_mul_mat / ggml_metal_op_get_rows
//                              early-out → milady_quant dispatchers.

const SENTINEL_DISPATCH = "// MILADY-DISPATCH-V1";

// All milady ggml_type values (must match ggml/include/ggml.h).
// Used by both the type-detection helper and the milady pipeline lookup.
// Note: TBQ3_0=43, TBQ4_0=44, QJL1_256=46, Q4_POLAR=47, TBQ3_TCQ=48.
const MILADY_QUANT_TYPES = ["TBQ3_0", "TBQ4_0", "QJL1_256", "Q4_POLAR", "TBQ3_TCQ"];

function patchMetalDispatchHeader(cacheDir, { dryRun }) {
  const headerPath = path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-device.h");
  const original = fs.readFileSync(headerPath, "utf8");
  if (original.includes(SENTINEL_DISPATCH)) {
    return { changed: false, path: headerPath };
  }
  const anchor = `struct ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_mul_mv            (ggml_metal_library_t lib, const struct ggml_tensor * op);`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-dispatch] header anchor not found at ${headerPath}; the fork's get_pipeline_mul_mv decl has moved. Inspect ggml-metal-device.h.`,
    );
  }
  const insert = `${anchor}
${SENTINEL_DISPATCH}
struct ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_milady_mul_mv  (ggml_metal_library_t lib, enum ggml_type tsrc0);
struct ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_milady_get_rows(ggml_metal_library_t lib, enum ggml_type tsrc0);`;
  const patched = original.replace(anchor, insert);
  if (patched === original) {
    throw new Error(`[metal-dispatch] header replace produced no change`);
  }
  if (!dryRun) fs.writeFileSync(headerPath, patched, "utf8");
  return { changed: !dryRun, path: headerPath };
}

function patchMetalDispatchDeviceCpp(cacheDir, { dryRun }) {
  const cppPath = path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-device.cpp");
  const original = fs.readFileSync(cppPath, "utf8");
  if (original.includes(SENTINEL_DISPATCH)) {
    return { changed: false, path: cppPath };
  }

  // (1) Insert milady pipeline lookup helpers right after
  //     ggml_metal_library_get_pipeline_get_rows. They build the explicit
  //     standalone symbol names (kernel_mul_mv_qjl1_256_f32 etc.) and bypass
  //     ggml_metal_library_compile_pipeline (which would re-enter the
  //     metallib compiler and fail because the standalones don't declare
  //     the `nsg` function constant). Pure name lookup against the already-
  //     loaded library — fails fast with GGML_ABORT if the symbol is not
  //     present in default.metallib (which would mean the kernel-shipment
  //     patch above silently regressed).
  const helpersAnchor = `ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_set_rows(ggml_metal_library_t lib, ggml_type tidx, ggml_type tdst) {`;
  if (!original.includes(helpersAnchor)) {
    throw new Error(`[metal-dispatch] device.cpp helpers anchor not found at ${cppPath}`);
  }
  const helpers = `${SENTINEL_DISPATCH}
// Milady-quant pipeline lookups. These kernels were built by the kernel
// shipment patch into default.metallib but use CUSTOM arg structs
// (qjl_score_args / qjl_mv_args / qjl_dequant_args / polar_mv_args /
// polar_dequant_args) that do NOT match ggml_metal_kargs_mul_mv. The
// standard get_pipeline_mul_mv helper sets a 'nsg' function constant
// the standalones do not declare; calling it crashes the metallib
// compiler. We keep this lookup constant-free.
ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_milady_mul_mv(ggml_metal_library_t lib, ggml_type tsrc0) {
    char name[256];
    switch (tsrc0) {
        case GGML_TYPE_QJL1_256: snprintf(name, 256, "kernel_mul_mv_qjl1_256_f32"); break;
        case GGML_TYPE_Q4_POLAR: snprintf(name, 256, "kernel_mul_mv_q4_polar_f32"); break;
        default:
            GGML_LOG_ERROR("milady_mul_mv: type %s (%d) has no mul_mv standalone (only attention-score)\\n",
                ggml_type_name(tsrc0), (int) tsrc0);
            GGML_ABORT("milady_mul_mv: unsupported milady-quant type for MUL_MAT");
    }
    ggml_metal_pipeline_with_params res = ggml_metal_library_get_pipeline(lib, name);
    if (!res.pipeline) {
        GGML_LOG_ERROR("milady_mul_mv: kernel '%s' missing from default.metallib (kernel-shipment regression)\\n", name);
        GGML_ABORT("milady_mul_mv: kernel symbol missing");
    }
    res.nr0 = 1;
    res.nr1 = 1;
    res.nsg = 1;
    res.smem = 0;
    return res;
}

ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_milady_get_rows(ggml_metal_library_t lib, ggml_type tsrc0) {
    char name[256];
    switch (tsrc0) {
        case GGML_TYPE_QJL1_256: snprintf(name, 256, "kernel_get_rows_qjl1_256"); break;
        case GGML_TYPE_Q4_POLAR: snprintf(name, 256, "kernel_get_rows_q4_polar"); break;
        default:
            GGML_LOG_ERROR("milady_get_rows: type %s (%d) has no get_rows standalone\\n",
                ggml_type_name(tsrc0), (int) tsrc0);
            GGML_ABORT("milady_get_rows: unsupported milady-quant type for GET_ROWS");
    }
    ggml_metal_pipeline_with_params res = ggml_metal_library_get_pipeline(lib, name);
    if (!res.pipeline) {
        GGML_LOG_ERROR("milady_get_rows: kernel '%s' missing from default.metallib\\n", name);
        GGML_ABORT("milady_get_rows: kernel symbol missing");
    }
    res.nr0 = 1; res.nr1 = 1; res.nsg = 1; res.smem = 0;
    return res;
}

`;
  let patched = original.replace(helpersAnchor, helpers + helpersAnchor);

  // (2) Add a guard at the top of ggml_metal_library_get_pipeline_mul_mv()
  //     so any caller that didn't go through the milady early-out gets a
  //     clean structured abort instead of crashing in the metallib compiler
  //     when the `nsg` function constant has no matching declaration.
  const mvSwitchAnchor = `    // use custom matrix x vector kernel
    switch (tsrc0) {`;
  if (!patched.includes(mvSwitchAnchor)) {
    throw new Error(`[metal-dispatch] device.cpp mul_mv switch anchor not found`);
  }
  const mvGuard = `    // ${SENTINEL_DISPATCH}
    // Defence-in-depth: milady-quant types should be diverted by the op-side
    // early-out in ggml_metal_op_mul_mat. If we got here, the dispatch
    // routing has regressed.
    if (tsrc0 == GGML_TYPE_QJL1_256 || tsrc0 == GGML_TYPE_Q4_POLAR ||
        tsrc0 == GGML_TYPE_TBQ3_0  || tsrc0 == GGML_TYPE_TBQ4_0  ||
        tsrc0 == GGML_TYPE_TBQ3_TCQ) {
        GGML_LOG_ERROR("get_pipeline_mul_mv: type %s reached standard helper (op-side dispatch regression)\\n",
            ggml_type_name(tsrc0));
        GGML_ABORT("get_pipeline_mul_mv: milady-quant type leaked into standard pipeline path");
    }
    // use custom matrix x vector kernel
    switch (tsrc0) {`;
  patched = patched.replace(mvSwitchAnchor, mvGuard);

  // (3) Same defence at the top of ggml_metal_library_get_pipeline_get_rows.
  //     This helper auto-builds `kernel_get_rows_<typename>`, which for the
  //     milady types yields the right symbol — but it would still try to
  //     compile a fresh pipeline if the lookup misses, and the compile path
  //     hits ggml-common.h struct redefinition. Hard-fail instead.
  const grAnchor = `ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_get_rows(ggml_metal_library_t lib, ggml_type tsrc) {
    char base[256];`;
  if (!patched.includes(grAnchor)) {
    throw new Error(`[metal-dispatch] device.cpp get_rows anchor not found`);
  }
  const grReplace = `ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_get_rows(ggml_metal_library_t lib, ggml_type tsrc) {
    // ${SENTINEL_DISPATCH}
    if (tsrc == GGML_TYPE_QJL1_256 || tsrc == GGML_TYPE_Q4_POLAR ||
        tsrc == GGML_TYPE_TBQ3_0  || tsrc == GGML_TYPE_TBQ4_0  ||
        tsrc == GGML_TYPE_TBQ3_TCQ) {
        GGML_LOG_ERROR("get_pipeline_get_rows: type %s reached standard helper (op-side dispatch regression)\\n",
            ggml_type_name(tsrc));
        GGML_ABORT("get_pipeline_get_rows: milady-quant type leaked into standard pipeline path");
    }
    char base[256];`;
  patched = patched.replace(grAnchor, grReplace);

  if (patched === original) {
    throw new Error(`[metal-dispatch] device.cpp replace produced no change`);
  }
  if (!dryRun) fs.writeFileSync(cppPath, patched, "utf8");
  return { changed: !dryRun, path: cppPath };
}

function patchMetalDispatchOpsCpp(cacheDir, { dryRun }) {
  const opsPath = path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-ops.cpp");
  const original = fs.readFileSync(opsPath, "utf8");
  if (original.includes(SENTINEL_DISPATCH)) {
    return { changed: false, path: opsPath };
  }

  // (1) Insert helper functions just before ggml_metal_op_mul_mat. These
  //     own the milady-quant dispatch shape: they pull op tensor metadata,
  //     build the standalone arg struct, set buffers, and dispatch with the
  //     correct threadgroup shape (32 threads per row, one threadgroup per
  //     row of src0). The functions hard-abort on unsupported types so a
  //     mis-routed call surfaces immediately.
  // Anchor on int ggml_metal_op_get_rows since it appears earlier in the file
  // than ggml_metal_op_mul_mat — both functions reference the milady helpers
  // through the early-out so the helpers must be visible to BOTH.
  const muMatAnchor = `int ggml_metal_op_get_rows(ggml_metal_op_t ctx, int idx) {`;
  if (!original.includes(muMatAnchor)) {
    throw new Error(`[metal-dispatch] ops.cpp get_rows anchor not found at ${opsPath}`);
  }
  const helpers = `${SENTINEL_DISPATCH}
// Milady-quant arg structs. Layout-matched bit-for-bit to the standalone
// declarations in milady-shipped/{qjl,polar}.metal — keep these in sync.
struct milady_qjl_mv_args     { uint32_t n_rows; uint32_t proj_dim; };
struct milady_qjl_dequant_args { uint32_t head_dim; uint32_t proj_dim; };
struct milady_polar_mv_args     { uint32_t n_rows; uint32_t head_dim; uint32_t use_qjl; };
struct milady_polar_dequant_args { uint32_t head_dim; uint32_t use_qjl; };

static inline bool milady_is_quant_mul_mv_supported(ggml_type t) {
    return t == GGML_TYPE_QJL1_256 || t == GGML_TYPE_Q4_POLAR;
}
static inline bool milady_is_quant_get_rows_supported(ggml_type t) {
    return t == GGML_TYPE_QJL1_256 || t == GGML_TYPE_Q4_POLAR;
}
// TBQ3_0 / TBQ4_0 / TBQ3_TCQ — standalones expose only attention-score
// kernels (kernel_turbo3_dot etc.). MUL_MAT against these types in a
// generic graph is not yet supported; we surface a clear abort instead
// of silently routing through a path that crashes in the metallib
// compiler. See AGENTS.md "TBQ* attention bridge" follow-up.
static inline bool milady_is_quant_tbq_attn_only(ggml_type t) {
    return t == GGML_TYPE_TBQ3_0 || t == GGML_TYPE_TBQ4_0 || t == GGML_TYPE_TBQ3_TCQ;
}

static int ggml_metal_op_mul_mv_milady_quant(ggml_metal_op_t ctx, int idx) {
    ggml_tensor * op = ctx->node(idx);
    ggml_metal_library_t lib = ctx->lib;
    ggml_metal_encoder_t enc = ctx->enc;

    GGML_TENSOR_LOCALS( int32_t, ne0, op->src[0], ne);
    GGML_TENSOR_LOCALS( int32_t, ne1, op->src[1], ne);

    const ggml_type tsrc0 = op->src[0]->type;

    if (milady_is_quant_tbq_attn_only(tsrc0)) {
        GGML_LOG_ERROR("milady_quant mul_mv: type %s exposes only attention-score kernels in the standalones; MUL_MAT requires an ATTN_SCORE op (Wave-7 work)\\n",
            ggml_type_name(tsrc0));
        GGML_ABORT("milady_quant: tbq* MUL_MAT not yet wired");
    }
    if (!milady_is_quant_mul_mv_supported(tsrc0)) {
        GGML_LOG_ERROR("milady_quant mul_mv: type %s not a milady-quant type\\n", ggml_type_name(tsrc0));
        GGML_ABORT("milady_quant mul_mv: unsupported type");
    }
    GGML_ASSERT(op->src[1]->type == GGML_TYPE_F32 && "milady_quant mul_mv expects fp32 activation");

    auto pipeline = ggml_metal_library_get_pipeline_milady_mul_mv(lib, tsrc0);

    const int32_t n_rows = ne01;

    ggml_metal_encoder_set_pipeline(enc, pipeline);
    ggml_metal_encoder_set_buffer  (enc, ggml_metal_get_buffer_id(op->src[0]), 0);
    ggml_metal_encoder_set_buffer  (enc, ggml_metal_get_buffer_id(op->src[1]), 1);
    ggml_metal_encoder_set_buffer  (enc, ggml_metal_get_buffer_id(op),         2);

    if (tsrc0 == GGML_TYPE_QJL1_256) {
        milady_qjl_mv_args args = {
            /* n_rows  = */ (uint32_t) n_rows,
            /* proj_dim = */ 256u,
        };
        ggml_metal_encoder_set_bytes(enc, &args, sizeof(args), 3);
    } else { // GGML_TYPE_Q4_POLAR
        milady_polar_mv_args args = {
            /* n_rows  = */ (uint32_t) n_rows,
            /* head_dim = */ 128u,
            /* use_qjl  = */ 0u,
        };
        ggml_metal_encoder_set_bytes(enc, &args, sizeof(args), 3);
    }

    // 32 threads per row, one threadgroup per row. Matches the standalone
    // dispatch shape verified by metal_verify (8/8 PASS).
    ggml_metal_encoder_dispatch_threadgroups(enc, n_rows, 1, 1, 32, 1, 1);
    return 1;
}

static int ggml_metal_op_get_rows_milady_quant(ggml_metal_op_t ctx, int idx) {
    ggml_tensor * op = ctx->node(idx);
    ggml_metal_library_t lib = ctx->lib;
    ggml_metal_encoder_t enc = ctx->enc;

    const ggml_type tsrc0 = op->src[0]->type;
    if (!milady_is_quant_get_rows_supported(tsrc0)) {
        GGML_LOG_ERROR("milady_quant get_rows: type %s not supported (tbq* lacks get_rows kernel)\\n",
            ggml_type_name(tsrc0));
        GGML_ABORT("milady_quant get_rows: unsupported type");
    }

    auto pipeline = ggml_metal_library_get_pipeline_milady_get_rows(lib, tsrc0);

    ggml_metal_encoder_set_pipeline(enc, pipeline);
    ggml_metal_encoder_set_buffer  (enc, ggml_metal_get_buffer_id(op->src[0]), 0);
    ggml_metal_encoder_set_buffer  (enc, ggml_metal_get_buffer_id(op->src[1]), 1);
    ggml_metal_encoder_set_buffer  (enc, ggml_metal_get_buffer_id(op),         2);

    if (tsrc0 == GGML_TYPE_QJL1_256) {
        milady_qjl_dequant_args args = { /* head_dim = */ 128u, /* proj_dim = */ 256u };
        ggml_metal_encoder_set_bytes(enc, &args, sizeof(args), 3);
    } else { // GGML_TYPE_Q4_POLAR
        milady_polar_dequant_args args = { /* head_dim = */ 128u, /* use_qjl = */ 0u };
        ggml_metal_encoder_set_bytes(enc, &args, sizeof(args), 3);
    }

    // Single threadgroup, 32 threads, processes one block.
    ggml_metal_encoder_dispatch_threadgroups(enc, 1, 1, 1, 32, 1, 1);
    return 1;
}

`;
  let patched = original.replace(muMatAnchor, helpers + muMatAnchor);

  // (2) Early-out at the top of ggml_metal_op_mul_mat() — divert milady
  //     types BEFORE any of the kernel-selection logic that depends on
  //     ggml_metal_library_get_pipeline_mul_mv.
  const muMatBodyAnchor = `int ggml_metal_op_mul_mat(ggml_metal_op_t ctx, int idx) {
    ggml_tensor * op = ctx->node(idx);

    ggml_metal_library_t lib = ctx->lib;
    ggml_metal_encoder_t enc = ctx->enc;`;
  if (!patched.includes(muMatBodyAnchor)) {
    throw new Error(`[metal-dispatch] ops.cpp mul_mat body anchor not found`);
  }
  const muMatEarly = `${muMatBodyAnchor}

    // ${SENTINEL_DISPATCH}
    {
        const ggml_type tsrc0 = op->src[0]->type;
        if (tsrc0 == GGML_TYPE_QJL1_256 || tsrc0 == GGML_TYPE_Q4_POLAR ||
            tsrc0 == GGML_TYPE_TBQ3_0  || tsrc0 == GGML_TYPE_TBQ4_0  ||
            tsrc0 == GGML_TYPE_TBQ3_TCQ) {
            return ggml_metal_op_mul_mv_milady_quant(ctx, idx);
        }
        (void) lib; (void) enc;
    }`;
  patched = patched.replace(muMatBodyAnchor, muMatEarly);

  // (3) Early-out at the top of ggml_metal_op_get_rows().
  const grBodyAnchor = `int ggml_metal_op_get_rows(ggml_metal_op_t ctx, int idx) {
    ggml_tensor * op = ctx->node(idx);

    ggml_metal_library_t lib = ctx->lib;
    ggml_metal_encoder_t enc = ctx->enc;`;
  if (!patched.includes(grBodyAnchor)) {
    throw new Error(`[metal-dispatch] ops.cpp get_rows body anchor not found`);
  }
  const grEarly = `${grBodyAnchor}

    // ${SENTINEL_DISPATCH}
    {
        const ggml_type tsrc0 = op->src[0]->type;
        if (tsrc0 == GGML_TYPE_QJL1_256 || tsrc0 == GGML_TYPE_Q4_POLAR) {
            return ggml_metal_op_get_rows_milady_quant(ctx, idx);
        }
        if (tsrc0 == GGML_TYPE_TBQ3_0 || tsrc0 == GGML_TYPE_TBQ4_0 || tsrc0 == GGML_TYPE_TBQ3_TCQ) {
            GGML_LOG_ERROR("get_rows: type %s has no standalone get_rows kernel (tbq* attention-only)\\n",
                ggml_type_name(tsrc0));
            GGML_ABORT("get_rows: tbq* not wired");
        }
        (void) lib; (void) enc;
    }`;
  patched = patched.replace(grBodyAnchor, grEarly);

  if (patched === original) {
    throw new Error(`[metal-dispatch] ops.cpp replace produced no change`);
  }
  if (!dryRun) fs.writeFileSync(opsPath, patched, "utf8");
  return { changed: !dryRun, path: opsPath };
}

export function patchMetalDispatch(cacheDir, { dryRun = false } = {}) {
  const h = patchMetalDispatchHeader(cacheDir, { dryRun });
  const d = patchMetalDispatchDeviceCpp(cacheDir, { dryRun });
  const o = patchMetalDispatchOpsCpp(cacheDir, { dryRun });
  console.log(
    `[metal-dispatch] ${dryRun ? "(dry-run) " : ""}wired milady-quant dispatch (qjl1_256, q4_polar): header=${h.changed ? "patched" : "skipped"}, device.cpp=${d.changed ? "patched" : "skipped"}, ops.cpp=${o.changed ? "patched" : "skipped"}. tbq3_0/tbq4_0/tbq3_tcq still attention-only.`,
  );
  return { header: h, device: d, ops: o };
}

// Public entry point used by build-llama-cpp-dflash.mjs.
// Throws on any failure. Idempotent across runs.
export function patchMetalKernels(cacheDir, { dryRun = false } = {}) {
  if (!cacheDir || !fs.existsSync(cacheDir)) {
    throw new Error(`[metal-kernels] cacheDir does not exist: ${cacheDir}`);
  }
  assertStandalonesPresent();
  const copied = copyStandalonesIntoFork(cacheDir, { dryRun });
  const cmake = patchMetalCMakeLists(cacheDir, { dryRun });
  const dispatch = patchMetalDispatch(cacheDir, { dryRun });
  console.log(
    `[metal-kernels] ${dryRun ? "(dry-run) " : ""}wired ${copied.length} shipped Metal kernels: ${METAL_KERNEL_FILES.join(", ")}`,
  );
  console.log(
    `[metal-kernels] ${dryRun ? "(dry-run) " : ""}CMakeLists.txt: ${cmake.changed ? "patched" : "already-patched"} (${cmake.path})`,
  );
  return { copied, cmake, dispatch };
}
