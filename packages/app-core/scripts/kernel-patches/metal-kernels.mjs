// Real Metal kernel-shipment helpers — replace the v0.4.0-milady decorative
// log no-ops in build-llama-cpp-dflash.mjs.
//
// What this module does:
//
//   1. Copies the required and optimization standalone Metal shaders from
//      packages/inference/metal/ into the fork's tree at
//      ggml/src/ggml-metal/milady-shipped/<kernel>.metal. The standalones are
//      self-contained TUs (only #include <metal_stdlib>; their own structs,
//      constants, kernel symbols), so they compile as independent .air files.
//
//   2. Patches ggml/src/ggml-metal/CMakeLists.txt so both Metal packaging
//      branches build each standalone shader into its own .air via
//      `xcrun metal -c` and merge all .air files (the original ggml-metal.air
//      plus the five milady .air files) into one default.metallib.
//
//   The original CMake snippet pipes `xcrun metal | xcrun metallib`. We
//   replace that with explicit per-source compilation + a final merge step,
//   keyed by a `# MILADY-KERNEL-PATCH-V1` sentinel so the patch is idempotent.
//
//   3. Hard-throws on any error — missing files, missing anchor in
//      CMakeLists.txt, fs failures. Per AGENTS.md §3, the build must exit
//      non-zero rather than silently produce a kernel-missing artifact.
//
// Runtime dispatch status:
//
//   * QJL, Turbo3, Turbo3_TCQ, and PolarQuant are wired through dedicated
//     attention-score graph ops. The dispatch smoke links against the built
//     fork and numerically verifies graph execution selects the shipped Metal
//     kernels.
//
//   * Turbo4 is wired through the same dedicated attention-score graph op.
//     The shipped shader consumes the fork's real GGML_TYPE_TBQ4_0 layout:
//     four 32-wide block_tbq4_0 records per 128-row (72 bytes).

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
// contract, verified shader math lives under packages/inference/metal/ and the
// fork copy is a generated shipping copy.
//
// Apple M4 Max verification on 2026-05-11:
//   * metal-verify: turbo3, turbo4, turbo3_tcq, qjl, polar, polar+QJL,
//     polar_preht, polar_preht+QJL all 8/8 PASS.
//   * metal-verify-multiblock: TurboQuant/QJL multi-block variants PASS.
//   * metal-verify-fused: fused_attn_qjl_tbq and fused_attn_qjl_polar PASS.
//
// Runtime dispatch is flipped only for the graph ops listed in
// METAL_RUNTIME_DISPATCH_GATES. The fused-attention kernels are shipped and
// verified, but remain an explicit runtime promotion step because they replace
// a larger score/softmax/V subgraph rather than one standalone score op.
export const METAL_KERNEL_FILES = [
  "turbo3.metal",
  "turbo4.metal",
  "turbo3_tcq.metal",
  "qjl.metal",
  "polar.metal",
  "polar_preht.metal",
  "fused_attn_qjl_tbq.metal",
  "fused_attn_qjl_polar.metal",
];

export const METAL_RUNTIME_DISPATCH_GATES = {
  turbo3: {
    status: "runtime-ready",
    runtimeReady: true,
    graphOp: "GGML_OP_ATTN_SCORE_TBQ",
    smokeTarget: "dispatch-smoke",
  },
  turbo4: {
    status: "runtime-ready",
    runtimeReady: true,
    graphOp: "GGML_OP_ATTN_SCORE_TBQ",
    smokeTarget: "dispatch-smoke",
  },
  turbo3_tcq: {
    status: "runtime-ready",
    runtimeReady: true,
    graphOp: "GGML_OP_ATTN_SCORE_TBQ",
    smokeTarget: "dispatch-smoke",
  },
  qjl_full: {
    status: "runtime-ready",
    runtimeReady: true,
    graphOp: "GGML_OP_ATTN_SCORE_QJL",
    smokeTarget: "dispatch-smoke",
  },
  polarquant: {
    status: "runtime-ready",
    runtimeReady: true,
    graphOp: "GGML_OP_ATTN_SCORE_POLAR",
    smokeTarget: "dispatch-smoke",
  },
};

const SENTINEL = "# MILADY-KERNEL-PATCH-V1";
const SENTINEL_EMBED = "# MILADY-KERNEL-EMBED-PATCH-V1";
const SENTINEL_EMBED_LOADER = "// MILADY-EMBEDDED-METALLIB-LOADER-V1";
const SENTINEL_QJL_ATTN = "// MILADY-QJL-ATTN-DISPATCH-V1";
const SENTINEL_TBQ_POLAR_ATTN = "// MILADY-TBQ-POLAR-ATTN-DISPATCH-V1";

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
  const targetDir = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "milady-shipped",
  );
  if (dryRun) {
    console.log(`[metal-kernels] (dry-run) mkdir -p ${targetDir}`);
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

// Patch ggml/src/ggml-metal/CMakeLists.txt so desktop and iOS both compile
// ggml-metal.metal + every standalone into separate .air files and merge them
// into one default.metallib. iOS then embeds that binary metallib into the
// static archive instead of embedding concatenated source.
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
  let patched = original;
  let changed = false;

  const miladyAirLinesForSdk = (sdkExpr) =>
    METAL_KERNEL_FILES.map((name) => {
      const stem = name.replace(/\.metal$/, "");
      return `        COMMAND xcrun -sdk ${sdkExpr} metal \${XC_FLAGS} -c \${CMAKE_CURRENT_SOURCE_DIR}/milady-shipped/${name} -o \${CMAKE_CURRENT_BINARY_DIR}/${stem}.air`;
    }).join("\n");
  const miladyAirInputs = METAL_KERNEL_FILES.map((name) => {
    const stem = name.replace(/\.metal$/, "");
    return `\${CMAKE_CURRENT_BINARY_DIR}/${stem}.air`;
  }).join(" ");
  const miladyDepends = METAL_KERNEL_FILES.map(
    (name) => `\${CMAKE_CURRENT_SOURCE_DIR}/milady-shipped/${name}`,
  ).join(" ");

  if (!patched.includes(SENTINEL_EMBED)) {
    const embedStart = patched.indexOf(
      "    # merge ggml-common.h and ggml-metal.metal into a single file",
    );
    const embedEnd =
      embedStart === -1
        ? -1
        : patched.indexOf(
            '\n\n    target_sources(ggml-metal PRIVATE "${METALLIB_EMBED_ASM}")',
            embedStart,
          );
    if (embedStart === -1 || embedEnd === -1) {
      throw new Error(
        `[metal-kernels] embedded Metal CMake anchor not found at ${cmakePath}; ` +
          `the fork's GGML_METAL_EMBED_LIBRARY branch changed shape and the patch must be revisited.`,
      );
    }
    const embedAirLines = miladyAirLinesForSdk("${METAL_SDK}");
    const embedReplacement = `    # ${SENTINEL_EMBED}
    # Build a compiled default.metallib for embedded-library targets (iOS).
    # The upstream path embedded concatenated Metal source and JIT-compiled it
    # at runtime. That cannot include the milady standalones because the source
    # TUs intentionally redeclare block_* structs/constants that already exist
    # in ggml-common.h. Compile each TU separately, merge into one metallib,
    # and embed the binary metallib bytes instead.
    set(METALLIB_EMBED_ASM        "\${CMAKE_CURRENT_BINARY_DIR}/autogenerated/ggml-metal-embed.s")
    set(METALLIB_SOURCE_EMBED     "\${CMAKE_CURRENT_BINARY_DIR}/autogenerated/ggml-metal-embed.metal")
    set(METALLIB_SOURCE_EMBED_TMP "\${CMAKE_CURRENT_BINARY_DIR}/autogenerated/ggml-metal-embed.metal.tmp")
    set(METALLIB_EMBED_BINARY    "\${CMAKE_CURRENT_BINARY_DIR}/autogenerated/default.metallib")
    set(METALLIB_EMBED_AIR       "\${CMAKE_CURRENT_BINARY_DIR}/autogenerated/ggml-metal-embed.air")
    set(METAL_SDK "\${CMAKE_OSX_SYSROOT}")
    if (NOT METAL_SDK)
        set(METAL_SDK macosx)
    endif()
    if (GGML_METAL_SHADER_DEBUG)
        set(XC_FLAGS -fno-fast-math -fno-inline)
    else()
        set(XC_FLAGS -O3)
    endif()
    if (GGML_METAL_STD)
        list(APPEND XC_FLAGS -std=\${GGML_METAL_STD})
    endif()

    add_custom_command(
        OUTPUT "\${METALLIB_EMBED_ASM}"
        COMMAND echo "Embedding Metal library (compiled metallib + milady-shipped kernels)"
        COMMAND sed -e "/__embed_ggml-common.h__/r \${METALLIB_COMMON}"       -e "/__embed_ggml-common.h__/d"         < "\${METALLIB_SOURCE}"           > "\${METALLIB_SOURCE_EMBED_TMP}"
        COMMAND sed -e "/\\#include \\"ggml-metal-impl.h\\"/r \${METALLIB_IMPL}" -e "/\\#include \\"ggml-metal-impl.h\\"/d" < "\${METALLIB_SOURCE_EMBED_TMP}" > "\${METALLIB_SOURCE_EMBED}"
        COMMAND xcrun -sdk \${METAL_SDK} metal \${XC_FLAGS} -DGGML_METAL_EMBED_LIBRARY=1 -c "\${METALLIB_SOURCE_EMBED}" -o "\${METALLIB_EMBED_AIR}"
${embedAirLines}
        COMMAND xcrun -sdk \${METAL_SDK} metallib "\${METALLIB_EMBED_AIR}" ${miladyAirInputs} -o "\${METALLIB_EMBED_BINARY}"
        COMMAND echo ".section __DATA,__ggml_metallib"          >  "\${METALLIB_EMBED_ASM}"
        COMMAND echo ".globl _ggml_metallib_start"              >> "\${METALLIB_EMBED_ASM}"
        COMMAND echo "_ggml_metallib_start:"                    >> "\${METALLIB_EMBED_ASM}"
        COMMAND echo .incbin "\\"\${METALLIB_EMBED_BINARY}\\""    >> "\${METALLIB_EMBED_ASM}"
        COMMAND echo ".globl _ggml_metallib_end"                >> "\${METALLIB_EMBED_ASM}"
        COMMAND echo "_ggml_metallib_end:"                      >> "\${METALLIB_EMBED_ASM}"
        DEPENDS ../ggml-common.h ggml-metal.metal ggml-metal-impl.h ${miladyDepends}
        COMMENT "Generate assembly for embedded compiled Metal library"
        VERBATIM
    )`;
    patched =
      patched.slice(0, embedStart) + embedReplacement + patched.slice(embedEnd);
    changed = true;
  }

  // The exact block we replace. This pipe pattern has been stable in the
  // elizaOS/llama.cpp fork for the entire v0.4.x line; if the upstream
  // ever rewrites it we want to fail loudly rather than silently no-op.
  if (!patched.includes(SENTINEL)) {
    const anchor = `    add_custom_command(
        OUTPUT \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND xcrun -sdk macosx metal \${XC_FLAGS} -c \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal -o - |
                xcrun -sdk macosx metallib        - -o \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-common.h
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal
        DEPENDS ggml-metal.metal \${METALLIB_COMMON}
        COMMENT "Compiling Metal kernels"
        )`;
    if (!patched.includes(anchor)) {
      throw new Error(
        `[metal-kernels] CMakeLists.txt anchor not found at ${cmakePath}; ` +
          `the fork's metallib build snippet has changed shape and the patch ` +
          `must be revisited. Inspect the file's add_custom_command for default.metallib.`,
      );
    }

    const miladyAirLines = miladyAirLinesForSdk("macosx");
    const replacement = `    # ${SENTINEL}
    # Build ggml-metal.metal AND each milady standalone shader into its own
    # .air file, then merge all .air files into a single default.metallib.
    # The standalones are self-contained TUs (only #include <metal_stdlib>;
    # define their own block_*, constants, kernel functions) so they do not
    # collide with anything ggml-metal.metal pulls in via ggml-common.h.
    add_custom_command(
        OUTPUT \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND xcrun -sdk macosx metal \${XC_FLAGS} -c \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal -o \${CMAKE_CURRENT_BINARY_DIR}/ggml-metal.air
${miladyAirLines}
        COMMAND xcrun -sdk macosx metallib \${CMAKE_CURRENT_BINARY_DIR}/ggml-metal.air ${miladyAirInputs} -o \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-common.h
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal
        DEPENDS ggml-metal.metal \${METALLIB_COMMON} ${miladyDepends}
        COMMENT "Compiling Metal kernels (ggml-metal + milady-shipped: ${METAL_KERNEL_FILES.join(", ")})"
        )`;
    patched = patched.replace(anchor, replacement);
    changed = true;
  }

  if (patched === original) {
    return { changed: false, path: cmakePath };
  }
  if (dryRun) {
    console.log(
      `[metal-kernels] (dry-run) would patch ${cmakePath} (changed=${changed}, includes ${METAL_KERNEL_FILES.length} shipped kernels)`,
    );
    return { changed: false, path: cmakePath };
  }
  fs.writeFileSync(cmakePath, patched, "utf8");
  return { changed: true, path: cmakePath };
}

function patchEmbeddedMetallibLoader(cacheDir, { dryRun }) {
  const deviceMPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-device.m",
  );
  if (!fs.existsSync(deviceMPath)) {
    throw new Error(
      `[metal-kernels] expected ${deviceMPath} to exist on the fork; cannot wire embedded metallib loader`,
    );
  }
  const original = fs.readFileSync(deviceMPath, "utf8");
  if (original.includes(SENTINEL_EMBED_LOADER)) {
    return { changed: false, path: deviceMPath };
  }
  const anchor = `#if GGML_METAL_EMBED_LIBRARY
        GGML_LOG_INFO("%s: using embedded metal library\\n", __func__);

        extern const char ggml_metallib_start[];
        extern const char ggml_metallib_end[];

        src = [[NSString alloc] initWithBytes:ggml_metallib_start length:(ggml_metallib_end-ggml_metallib_start) encoding:NSUTF8StringEncoding];
#else`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-kernels] embedded Metal loader anchor not found at ${deviceMPath}; ` +
        `the fork's GGML_METAL_EMBED_LIBRARY loader changed shape and the patch must be revisited.`,
    );
  }
  const replacement = `#if GGML_METAL_EMBED_LIBRARY
        GGML_LOG_INFO("%s: using embedded compiled metal library\\n", __func__);

        extern const char ggml_metallib_start[];
        extern const char ggml_metallib_end[];

        // ${SENTINEL_EMBED_LOADER}
        // The build patch embeds compiled default.metallib bytes here, not
        // Metal source. Loading with newLibraryWithData keeps iOS on the same
        // multi-TU kernel set as desktop and avoids duplicate declarations
        // between ggml-metal.metal and the milady standalone shaders.
        const NSUInteger metallib_len = (NSUInteger)(ggml_metallib_end - ggml_metallib_start);
        dispatch_data_t metallib_data = dispatch_data_create(ggml_metallib_start, metallib_len, nil, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
        library = [device newLibraryWithData:metallib_data error:&error];
        if (error) {
            GGML_LOG_ERROR("%s: error: %s\\n", __func__, [[error description] UTF8String]);
            return nil;
        }
#else`;
  const patched = original.replace(anchor, replacement);
  if (patched === original) {
    throw new Error(
      "[metal-kernels] embedded loader replace produced no change",
    );
  }
  if (!dryRun) fs.writeFileSync(deviceMPath, patched, "utf8");
  return { changed: !dryRun, path: deviceMPath };
}

const SENTINEL_DISPATCH = "// MILADY-DISPATCH-V1";

function patchMetalQjlAttnHeader(cacheDir, { dryRun }) {
  const headerPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-device.h",
  );
  const original = fs.readFileSync(headerPath, "utf8");
  if (original.includes(SENTINEL_QJL_ATTN)) {
    return { changed: false, path: headerPath };
  }
  const anchor = `struct ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_flash_attn_ext(
        ggml_metal_library_t lib,
        const struct ggml_tensor * op,
        bool    has_mask,
        bool    has_sinks,
        bool    has_bias,
        bool    has_scap,
        bool    has_kvpad,
        int32_t nsg);`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-qjl-attn] device.h anchor not found at ${headerPath}; inspect flash-attn pipeline declarations.`,
    );
  }
  const insert = `${anchor}

${SENTINEL_QJL_ATTN}
struct ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_attn_score_qjl(
        ggml_metal_library_t lib);`;
  const patched = original.replace(anchor, insert);
  if (!dryRun) fs.writeFileSync(headerPath, patched, "utf8");
  return { changed: !dryRun, path: headerPath };
}

function patchMetalQjlAttnDeviceCpp(cacheDir, { dryRun }) {
  const cppPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-device.cpp",
  );
  const original = fs.readFileSync(cppPath, "utf8");
  if (original.includes(SENTINEL_QJL_ATTN)) {
    const upgraded = original.replace(
      'const char * name = "kernel_attn_score_qjl1_256";',
      'const char * name = "kernel_attn_score_qjl1_256_multi";',
    );
    if (upgraded !== original && !dryRun)
      fs.writeFileSync(cppPath, upgraded, "utf8");
    return { changed: upgraded !== original && !dryRun, path: cppPath };
  }
  const anchor = `ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_bin(ggml_metal_library_t lib, const ggml_tensor * op, int32_t n_fuse) {`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-qjl-attn] device.cpp anchor not found at ${cppPath}; inspect pipeline helper layout.`,
    );
  }
  const helper = `${SENTINEL_QJL_ATTN}
ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_attn_score_qjl(ggml_metal_library_t lib) {
    const char * name = "kernel_attn_score_qjl1_256_multi";
    ggml_metal_pipeline_with_params res = ggml_metal_library_get_pipeline(lib, name);
    if (!res.pipeline) {
        // Standalone shipped shader: it declares no Metal function constants,
        // so compile by direct symbol name with a null constants table.
        res = ggml_metal_library_compile_pipeline(lib, name, name, nullptr);
    }
    if (!res.pipeline) {
        GGML_LOG_ERROR("attn_score_qjl: kernel '%s' missing from default.metallib\\n", name);
        GGML_ABORT("attn_score_qjl: pipeline compile failed");
    }
    res.nr0 = 1;
    res.nr1 = 1;
    res.nsg = 1;
    res.smem = 0;
    return res;
}

`;
  const patched = original.replace(anchor, helper + anchor);
  if (!dryRun) fs.writeFileSync(cppPath, patched, "utf8");
  return { changed: !dryRun, path: cppPath };
}

function patchMetalQjlAttnOpsHeader(cacheDir, { dryRun }) {
  const headerPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-ops.h",
  );
  const original = fs.readFileSync(headerPath, "utf8");
  if (original.includes(SENTINEL_QJL_ATTN)) {
    return { changed: false, path: headerPath };
  }
  const anchor = `int ggml_metal_op_flash_attn_ext    (ggml_metal_op_t ctx, int idx);`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-qjl-attn] ops.h anchor not found at ${headerPath}; inspect op declarations.`,
    );
  }
  const insert = `${anchor}
${SENTINEL_QJL_ATTN}
int ggml_metal_op_attn_score_qjl  (ggml_metal_op_t ctx, int idx);`;
  const patched = original.replace(anchor, insert);
  if (!dryRun) fs.writeFileSync(headerPath, patched, "utf8");
  return { changed: !dryRun, path: headerPath };
}

function patchMetalQjlAttnOpsCpp(cacheDir, { dryRun }) {
  const opsPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-ops.cpp",
  );
  const original = fs.readFileSync(opsPath, "utf8");
  if (original.includes(SENTINEL_QJL_ATTN)) {
    let upgraded = original;
    if (!upgraded.includes("#include <cstdlib>")) {
      upgraded = upgraded.replace(
        `#include <cmath>
`,
        `#include <cmath>
#include <cstdlib>
`,
      );
    }
    upgraded = upgraded.replace(
      `struct milady_qjl_score_args {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t proj_dim;
};`,
      `struct milady_qjl_score_args {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t proj_dim;
    uint32_t tokens_per_threadgroup;
};`,
    );
    if (!upgraded.includes("static inline uint32_t milady_env_u32")) {
      upgraded = upgraded.replace(
        `static inline ggml_metal_buffer_id milady_metal_buffer_offset(ggml_metal_buffer_id id, size_t extra) {
    id.offs += extra;
    return id;
}
`,
        `static inline ggml_metal_buffer_id milady_metal_buffer_offset(ggml_metal_buffer_id id, size_t extra) {
    id.offs += extra;
    return id;
}

static inline uint32_t milady_env_u32(const char * name, uint32_t fallback, uint32_t min_value, uint32_t max_value) {
    const char * raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\\0') {
        return fallback;
    }
    char * end = nullptr;
    const unsigned long parsed = std::strtoul(raw, &end, 10);
    if (end == raw || *end != '\\0' || parsed < min_value || parsed > max_value) {
        GGML_LOG_WARN("%s: ignoring invalid %s=%s (expected %u..%u)\\n",
                      __func__, name, raw, min_value, max_value);
        return fallback;
    }
    return (uint32_t) parsed;
}
`,
      );
    }
    upgraded = upgraded.replace(
      `        /* n_tokens   = */ n_tokens,
        /* proj_dim   = */ 256u,
    };`,
      `        /* n_tokens   = */ n_tokens,
        /* proj_dim   = */ 256u,
        // M4 Max 2026-05-11 sweeps show N=4/8/16/32 trade median vs p99.
        // Keep N=32 as the tail-latency-biased default until per-device
        // autotuning can persist a device-specific table.
        /* tokens_per_threadgroup = */ milady_env_u32("ELIZA_METAL_QJL_TOKENS_PER_TG", 32u, 1u, 64u),
    };`,
    );
    upgraded = upgraded.replace(
      `            ggml_metal_encoder_dispatch_threadgroups(enc, (int) n_heads, (int) n_tokens, 1, 32, 1, 1);`,
      `            const int token_groups = (int) ((n_tokens + args.tokens_per_threadgroup - 1u) / args.tokens_per_threadgroup);
            ggml_metal_encoder_dispatch_threadgroups(enc, (int) n_heads, token_groups, 1, 32, 1, 1);`,
    );
    upgraded = upgraded.replace(
      `    GGML_ASSERT(q->ne[0]  == 256);
    GGML_ASSERT(pk->ne[0] == 128);`,
      `    GGML_ASSERT(q->ne[0]  == 256);
    GGML_ASSERT(pk->ne[0] == 128);
    GGML_ASSERT(ggml_is_contiguous_rows(q));
    GGML_ASSERT(ggml_is_contiguous_rows(pk));
    GGML_ASSERT(ggml_is_contiguous_rows(op));`,
    );
    if (upgraded !== original && !dryRun)
      fs.writeFileSync(opsPath, upgraded, "utf8");
    return { changed: upgraded !== original && !dryRun, path: opsPath };
  }

  const funcAnchor = `static int ggml_metal_op_encode_impl(ggml_metal_op_t ctx, int idx) {`;
  if (!original.includes(funcAnchor)) {
    throw new Error(
      `[metal-qjl-attn] ops.cpp function anchor not found at ${opsPath}; inspect encode layout.`,
    );
  }
  const opFunc = `${SENTINEL_QJL_ATTN}
struct milady_qjl_score_args {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t proj_dim;
    uint32_t tokens_per_threadgroup;
};

static inline ggml_metal_buffer_id milady_metal_buffer_offset(ggml_metal_buffer_id id, size_t extra) {
    id.offs += extra;
    return id;
}

static inline uint32_t milady_env_u32(const char * name, uint32_t fallback, uint32_t min_value, uint32_t max_value) {
    const char * raw = std::getenv(name);
    if (raw == nullptr || raw[0] == '\\0') {
        return fallback;
    }
    char * end = nullptr;
    const unsigned long parsed = std::strtoul(raw, &end, 10);
    if (end == raw || *end != '\\0' || parsed < min_value || parsed > max_value) {
        GGML_LOG_WARN("%s: ignoring invalid %s=%s (expected %u..%u)\\n",
                      __func__, name, raw, min_value, max_value);
        return fallback;
    }
    return (uint32_t) parsed;
}

int ggml_metal_op_attn_score_qjl(ggml_metal_op_t ctx, int idx) {
    ggml_tensor * op = ctx->node(idx);

    ggml_metal_library_t lib = ctx->lib;
    ggml_metal_encoder_t enc = ctx->enc;

    const ggml_tensor * q  = op->src[0];
    const ggml_tensor * pk = op->src[1];

    GGML_ASSERT(q  != nullptr);
    GGML_ASSERT(pk != nullptr);
    GGML_ASSERT(q->type  == GGML_TYPE_F32);
    GGML_ASSERT(pk->type == GGML_TYPE_QJL1_256);
    GGML_ASSERT(op->type == GGML_TYPE_F32);
    GGML_ASSERT(q->ne[0]  == 256);
    GGML_ASSERT(pk->ne[0] == 128);
    GGML_ASSERT(ggml_is_contiguous_rows(q));
    GGML_ASSERT(ggml_is_contiguous_rows(pk));
    GGML_ASSERT(ggml_is_contiguous_rows(op));

    const uint32_t n_heads     = (uint32_t) q->ne[1];
    const uint32_t n_kv_heads  = (uint32_t) ((const int32_t *) op->op_params)[0];
    const uint32_t n_tokens    = (uint32_t) pk->ne[1];
    const int64_t  n_batch     = q->ne[2];
    const int64_t  ne3         = q->ne[3];

    GGML_ASSERT(n_kv_heads > 0);
    GGML_ASSERT((n_heads % n_kv_heads) == 0);
    GGML_ASSERT(pk->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(pk->ne[3] == ne3);
    GGML_ASSERT(op->ne[0] == (int64_t) n_tokens);
    GGML_ASSERT(op->ne[1] == (int64_t) n_heads);
    GGML_ASSERT(op->ne[2] == n_batch);
    GGML_ASSERT(op->ne[3] == ne3);
    GGML_ASSERT(pk->nb[1] == ggml_row_size(GGML_TYPE_QJL1_256, 128));
    GGML_ASSERT(pk->nb[2] == (size_t) n_tokens * pk->nb[1]);

    milady_qjl_score_args args = {
        /* n_heads    = */ n_heads,
        /* n_kv_heads = */ n_kv_heads,
        /* n_tokens   = */ n_tokens,
        /* proj_dim   = */ 256u,
        // M4 Max 2026-05-11 sweeps show N=4/8/16/32 trade median vs p99.
        // Keep N=32 as the tail-latency-biased default until per-device
        // autotuning can persist a device-specific table.
        /* tokens_per_threadgroup = */ milady_env_u32("ELIZA_METAL_QJL_TOKENS_PER_TG", 32u, 1u, 64u),
    };

    auto pipeline = ggml_metal_library_get_pipeline_attn_score_qjl(lib);

    const ggml_metal_buffer_id q_base  = ggml_metal_get_buffer_id(q);
    const ggml_metal_buffer_id pk_base = ggml_metal_get_buffer_id(pk);
    const ggml_metal_buffer_id dst_base = ggml_metal_get_buffer_id(op);

    ggml_metal_encoder_set_pipeline(enc, pipeline);
    ggml_metal_encoder_set_bytes(enc, &args, sizeof(args), 3);

    for (int64_t i3 = 0; i3 < ne3; ++i3) {
        const size_t q_i3  = (size_t) i3 * q->nb[3];
        const size_t pk_i3 = (size_t) i3 * pk->nb[3];
        const size_t dst_i3 = (size_t) i3 * op->nb[3];
        for (int64_t ib = 0; ib < n_batch; ++ib) {
            ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(q_base,  q_i3  + (size_t) ib * q->nb[2]),  0);
            ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(pk_base, pk_i3),                          1);
            ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(dst_base, dst_i3 + (size_t) ib * op->nb[2]), 2);
            const int token_groups = (int) ((n_tokens + args.tokens_per_threadgroup - 1u) / args.tokens_per_threadgroup);
            ggml_metal_encoder_dispatch_threadgroups(enc, (int) n_heads, token_groups, 1, 32, 1, 1);
        }
    }

    return 1;
}

`;
  let patched = original.replace(funcAnchor, opFunc + funcAnchor);
  if (!patched.includes("#include <cstdlib>")) {
    patched = patched.replace(
      `#include <cmath>
`,
      `#include <cmath>
#include <cstdlib>
`,
    );
  }

  const switchAnchor = `        case GGML_OP_FLASH_ATTN_EXT:
            {
                n_fuse = ggml_metal_op_flash_attn_ext(ctx, idx);
            } break;`;
  if (!patched.includes(switchAnchor)) {
    throw new Error(
      `[metal-qjl-attn] ops.cpp switch anchor not found at ${opsPath}; inspect encode switch.`,
    );
  }
  const switchInsert = `${switchAnchor}
        case GGML_OP_ATTN_SCORE_QJL:
            {
                n_fuse = ggml_metal_op_attn_score_qjl(ctx, idx);
            } break;`;
  patched = patched.replace(switchAnchor, switchInsert);
  if (!dryRun) fs.writeFileSync(opsPath, patched, "utf8");
  return { changed: !dryRun, path: opsPath };
}

function patchMetalQjlAttnSupportsOp(cacheDir, { dryRun }) {
  const deviceMPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-device.m",
  );
  const original = fs.readFileSync(deviceMPath, "utf8");
  if (original.includes(SENTINEL_QJL_ATTN)) {
    const upgraded = original.replace(
      `                op->src[0]->ne[0] == 256 &&
                op->src[1]->ne[0] == 128;`,
      `                op->src[0]->ne[0] == 256 &&
                op->src[1]->ne[0] == 128 &&
                ggml_is_contiguous_rows(op) &&
                ggml_is_contiguous_rows(op->src[0]) &&
                ggml_is_contiguous_rows(op->src[1]);`,
    );
    if (upgraded !== original && !dryRun)
      fs.writeFileSync(deviceMPath, upgraded, "utf8");
    return { changed: upgraded !== original && !dryRun, path: deviceMPath };
  }
  const anchor = `        case GGML_OP_FLASH_ATTN_EXT:
            // for new head sizes, add checks here`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-qjl-attn] supports_op anchor not found at ${deviceMPath}; inspect GGML_OP_FLASH_ATTN_EXT branch.`,
    );
  }
  const insert = `        case GGML_OP_ATTN_SCORE_QJL:
            // ${SENTINEL_QJL_ATTN}
            return has_simdgroup_reduction &&
                op->type == GGML_TYPE_F32 &&
                op->src[0] != NULL &&
                op->src[1] != NULL &&
                op->src[0]->type == GGML_TYPE_F32 &&
                op->src[1]->type == GGML_TYPE_QJL1_256 &&
                op->src[0]->ne[0] == 256 &&
                op->src[1]->ne[0] == 128 &&
                ggml_is_contiguous_rows(op) &&
                ggml_is_contiguous_rows(op->src[0]) &&
                ggml_is_contiguous_rows(op->src[1]);
${anchor}`;
  const patched = original.replace(anchor, insert);
  if (!dryRun) fs.writeFileSync(deviceMPath, patched, "utf8");
  return { changed: !dryRun, path: deviceMPath };
}

function patchMetalQjlAttnDispatch(cacheDir, { dryRun }) {
  const header = patchMetalQjlAttnHeader(cacheDir, { dryRun });
  const deviceCpp = patchMetalQjlAttnDeviceCpp(cacheDir, { dryRun });
  const opsHeader = patchMetalQjlAttnOpsHeader(cacheDir, { dryRun });
  const opsCpp = patchMetalQjlAttnOpsCpp(cacheDir, { dryRun });
  const supportsOp = patchMetalQjlAttnSupportsOp(cacheDir, { dryRun });
  return { header, deviceCpp, opsHeader, opsCpp, supportsOp };
}

function readTcqCodebookLiteral() {
  const referencePath = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "inference",
    "reference",
    "turbo_kernels.c",
  );
  const source = fs.readFileSync(referencePath, "utf8");
  const match = source.match(
    /const float ELIZA_TURBO3_TCQ_CODEBOOK\[512\]\s*=\s*\{([\s\S]*?)\};/,
  );
  if (!match) {
    throw new Error(
      `[metal-tbq-polar-attn] could not extract TCQ codebook from ${referencePath}`,
    );
  }
  return match[1].trim();
}

export function patchGgmlTbqPolarAttnOps(cacheDir, { dryRun }) {
  const headerPath = path.join(cacheDir, "ggml", "include", "ggml.h");
  const cPath = path.join(cacheDir, "ggml", "src", "ggml.c");
  let changed = false;

  const headerOriginal = fs.readFileSync(headerPath, "utf8");
  let header = headerOriginal;
  if (!header.includes(SENTINEL_TBQ_POLAR_ATTN)) {
    const enumAnchor = `        GGML_OP_ATTN_SCORE_QJL, // QJL 1-bit packed-K attention score (CPU-only)
        GGML_OP_FUSED_ATTN_QJL_TBQ, // fused QJL-K + TBQ-V attention (CPU-only)`;
    if (!header.includes(enumAnchor)) {
      throw new Error(
        `[metal-tbq-polar-attn] ggml.h op enum anchor not found at ${headerPath}`,
      );
    }
    header = header.replace(
      enumAnchor,
      `        GGML_OP_ATTN_SCORE_QJL, // QJL 1-bit packed-K attention score
        GGML_OP_ATTN_SCORE_TBQ, // ${SENTINEL_TBQ_POLAR_ATTN} TurboQuant packed-K attention score
        GGML_OP_ATTN_SCORE_POLAR, // PolarQuant packed-K attention score
        GGML_OP_FUSED_ATTN_QJL_TBQ, // fused QJL-K + TBQ-V attention (CPU-only)`,
    );
    const declAnchor = `    GGML_API struct ggml_tensor * ggml_attn_score_qjl(
            struct ggml_context * ctx,
            struct ggml_tensor  * q,
            struct ggml_tensor  * packed_k,
            int                   n_kv_heads);`;
    if (!header.includes(declAnchor)) {
      throw new Error(
        `[metal-tbq-polar-attn] ggml.h QJL declaration anchor not found at ${headerPath}`,
      );
    }
    header = header.replace(
      declAnchor,
      `${declAnchor}

    // ${SENTINEL_TBQ_POLAR_ATTN}
    // TurboQuant packed-K attention score.
    // q: F32 [128, n_heads, n_batch, ne3]
    // packed_k: TBQ3_0/TBQ4_0/TBQ3_TCQ [128, n_kv_tokens, n_kv_heads, ne3]
    // output: F32 [n_kv_tokens, n_heads, n_batch, ne3]
    GGML_API struct ggml_tensor * ggml_attn_score_tbq(
            struct ggml_context * ctx,
            struct ggml_tensor  * q,
            struct ggml_tensor  * packed_k,
            int                   n_kv_heads);

    // PolarQuant packed-K attention score.
    // q: F32 [128, n_heads, n_batch, ne3]
    // packed_k: Q4_POLAR [128, n_kv_tokens, n_kv_heads, ne3]
    // use_qjl mirrors the PolarQuant GGUF residual flag.
    // output: F32 [n_kv_tokens, n_heads, n_batch, ne3]
    GGML_API struct ggml_tensor * ggml_attn_score_polar(
            struct ggml_context * ctx,
            struct ggml_tensor  * q,
            struct ggml_tensor  * packed_k,
            int                   n_kv_heads,
            bool                  use_qjl);

    // PolarQuant packed-K attention score with pre-Hadamarded query.
    // q_preht MUST contain H*q for each query head, where H is the same
    // unnormalised 128-point Walsh-Hadamard transform used by the PolarQuant
    // decoder. This is faster than ggml_attn_score_polar() because the backend
    // can use dot(H*x, q) == dot(x, H*q) and avoid one Hadamard per K row.
    GGML_API struct ggml_tensor * ggml_attn_score_polar_preht(
            struct ggml_context * ctx,
            struct ggml_tensor  * q_preht,
            struct ggml_tensor  * packed_k,
            int                   n_kv_heads,
            bool                  use_qjl);`,
    );
    changed = true;
  }

  if (header !== headerOriginal && !dryRun)
    fs.writeFileSync(headerPath, header, "utf8");

  const cOriginal = fs.readFileSync(cPath, "utf8");
  let c = cOriginal;
  if (!c.includes(SENTINEL_TBQ_POLAR_ATTN)) {
    c = c.replace(
      `    "ATTN_SCORE_QJL",
    "FUSED_ATTN_QJL_TBQ",`,
      `    "ATTN_SCORE_QJL",
    "ATTN_SCORE_TBQ",
    "ATTN_SCORE_POLAR",
    "FUSED_ATTN_QJL_TBQ",`,
    );
    c = c.replace(
      `    "attn_score_qjl(q, packed_k)",
    "fused_attn_qjl_tbq(q, packed_k, packed_v)",`,
      `    "attn_score_qjl(q, packed_k)",
    "attn_score_tbq(q, packed_k)",
    "attn_score_polar(q, packed_k)",
    "fused_attn_qjl_tbq(q, packed_k, packed_v)",`,
    );
    c = c.replace(
      `    [GGML_TYPE_QJL1_256] = {`,
      `    [GGML_TYPE_TBQ3_TCQ] = {
        .type_name                = "tbq3_tcq",
        .blck_size                = QK_TBQ3_TCQ,
        .type_size                = sizeof(block_tbq3_tcq),
        .is_quantized             = true,
    },
    [GGML_TYPE_QJL1_256] = {`,
    );
    c = c.replaceAll(
      `static_assert(GGML_OP_COUNT == 97, "GGML_OP_COUNT != 97");`,
      `static_assert(GGML_OP_COUNT == 99, "GGML_OP_COUNT != 99");`,
    );
    const implAnchor = `// ggml_fused_attn_qjl_tbq
//`;
    if (!c.includes(implAnchor)) {
      throw new Error(
        `[metal-tbq-polar-attn] ggml.c implementation anchor not found at ${cPath}`,
      );
    }
    const impl = `// ${SENTINEL_TBQ_POLAR_ATTN}
// ggml_attn_score_tbq
//
struct ggml_tensor * ggml_attn_score_tbq(
        struct ggml_context * ctx,
        struct ggml_tensor  * q,
        struct ggml_tensor  * packed_k,
        int                   n_kv_heads) {
    GGML_ASSERT(q != NULL);
    GGML_ASSERT(packed_k != NULL);
    GGML_ASSERT(q->type == GGML_TYPE_F32);
    GGML_ASSERT(packed_k->type == GGML_TYPE_TBQ3_0 ||
                packed_k->type == GGML_TYPE_TBQ4_0 ||
                packed_k->type == GGML_TYPE_TBQ3_TCQ);
    GGML_ASSERT(q->ne[0] == 128);
    GGML_ASSERT(packed_k->ne[0] == 128);

    const int64_t n_heads     = q->ne[1];
    const int64_t n_kv_tokens = packed_k->ne[1];

    GGML_ASSERT(n_kv_heads > 0);
    GGML_ASSERT((n_heads % n_kv_heads) == 0);
    GGML_ASSERT(packed_k->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(packed_k->ne[3] == q->ne[3]);

    const int64_t ne[4] = { n_kv_tokens, n_heads, q->ne[2], q->ne[3] };
    struct ggml_tensor * result = ggml_new_tensor(ctx, GGML_TYPE_F32, 4, ne);

    int32_t params[1] = { n_kv_heads };
    ggml_set_op_params(result, params, sizeof(params));

    result->op     = GGML_OP_ATTN_SCORE_TBQ;
    result->src[0] = q;
    result->src[1] = packed_k;

    return result;
}

// ggml_attn_score_polar_impl
//
static struct ggml_tensor * ggml_attn_score_polar_impl(
        struct ggml_context * ctx,
        struct ggml_tensor  * q,
        struct ggml_tensor  * packed_k,
        int                   n_kv_heads,
        bool                  use_qjl,
        bool                  q_preht) {
    GGML_ASSERT(q != NULL);
    GGML_ASSERT(packed_k != NULL);
    GGML_ASSERT(q->type == GGML_TYPE_F32);
    GGML_ASSERT(packed_k->type == GGML_TYPE_Q4_POLAR);
    GGML_ASSERT(q->ne[0] == 128);
    GGML_ASSERT(packed_k->ne[0] == 128);

    const int64_t n_heads     = q->ne[1];
    const int64_t n_kv_tokens = packed_k->ne[1];

    GGML_ASSERT(n_kv_heads > 0);
    GGML_ASSERT((n_heads % n_kv_heads) == 0);
    GGML_ASSERT(packed_k->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(packed_k->ne[3] == q->ne[3]);

    const int64_t ne[4] = { n_kv_tokens, n_heads, q->ne[2], q->ne[3] };
    struct ggml_tensor * result = ggml_new_tensor(ctx, GGML_TYPE_F32, 4, ne);

    int32_t params[3] = { n_kv_heads, use_qjl ? 1 : 0, q_preht ? 1 : 0 };
    ggml_set_op_params(result, params, sizeof(params));

    result->op     = GGML_OP_ATTN_SCORE_POLAR;
    result->src[0] = q;
    result->src[1] = packed_k;

    return result;
}

// ggml_attn_score_polar
//
struct ggml_tensor * ggml_attn_score_polar(
        struct ggml_context * ctx,
        struct ggml_tensor  * q,
        struct ggml_tensor  * packed_k,
        int                   n_kv_heads,
        bool                  use_qjl) {
    return ggml_attn_score_polar_impl(ctx, q, packed_k, n_kv_heads, use_qjl, false);
}

// ggml_attn_score_polar_preht
//
struct ggml_tensor * ggml_attn_score_polar_preht(
        struct ggml_context * ctx,
        struct ggml_tensor  * q_preht,
        struct ggml_tensor  * packed_k,
        int                   n_kv_heads,
        bool                  use_qjl) {
    return ggml_attn_score_polar_impl(ctx, q_preht, packed_k, n_kv_heads, use_qjl, true);
}

`;
    c = c.replace(implAnchor, impl + implAnchor);
    if (!c.includes("ATTN_SCORE_TBQ") || !c.includes("attn_score_polar")) {
      throw new Error(
        `[metal-tbq-polar-attn] ggml.c patch did not add expected op names at ${cPath}`,
      );
    }
    changed = true;
  }

  if (c !== cOriginal && !dryRun) fs.writeFileSync(cPath, c, "utf8");
  return { changed: changed && !dryRun, headerPath, cPath };
}

function patchMetalTbqPolarDeviceHeader(cacheDir, { dryRun }) {
  const headerPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-device.h",
  );
  const original = fs.readFileSync(headerPath, "utf8");
  if (original.includes(SENTINEL_TBQ_POLAR_ATTN)) {
    return { changed: false, path: headerPath };
  }
  const anchor = `${SENTINEL_QJL_ATTN}
struct ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_attn_score_qjl(
        ggml_metal_library_t lib);`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-tbq-polar-attn] device.h QJL pipeline anchor not found at ${headerPath}`,
    );
  }
  const patched = original.replace(
    anchor,
    `${anchor}

${SENTINEL_TBQ_POLAR_ATTN}
struct ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_attn_score_tbq(
        ggml_metal_library_t lib,
        enum ggml_type        type);

struct ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_attn_score_polar(
        ggml_metal_library_t lib);

struct ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_attn_score_polar_preht(
        ggml_metal_library_t lib);`,
  );
  if (!dryRun) fs.writeFileSync(headerPath, patched, "utf8");
  return { changed: !dryRun, path: headerPath };
}

function patchMetalTbqPolarDeviceCpp(cacheDir, { dryRun }) {
  const cppPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-device.cpp",
  );
  const original = fs.readFileSync(cppPath, "utf8");
  if (original.includes(SENTINEL_TBQ_POLAR_ATTN)) {
    return { changed: false, path: cppPath };
  }
  const anchor = `ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_bin(ggml_metal_library_t lib, const ggml_tensor * op, int32_t n_fuse) {`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-tbq-polar-attn] device.cpp pipeline anchor not found at ${cppPath}`,
    );
  }
  const helper = `${SENTINEL_TBQ_POLAR_ATTN}
static const char * milady_metal_tbq_kernel_name(ggml_type type) {
    switch (type) {
        case GGML_TYPE_TBQ3_0:   return "kernel_turbo3_dot_multi";
        case GGML_TYPE_TBQ4_0:   return "kernel_turbo4_dot_multi";
        case GGML_TYPE_TBQ3_TCQ: return "kernel_turbo3_tcq_dot_multi";
        default: GGML_ABORT("unsupported TurboQuant attention score type");
    }
}

ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_attn_score_tbq(ggml_metal_library_t lib, ggml_type type) {
    const char * name = milady_metal_tbq_kernel_name(type);
    ggml_metal_pipeline_with_params res = ggml_metal_library_get_pipeline(lib, name);
    if (!res.pipeline) {
        res = ggml_metal_library_compile_pipeline(lib, name, name, nullptr);
    }
    if (!res.pipeline) {
        GGML_LOG_ERROR("attn_score_tbq: kernel '%s' missing from default.metallib\\n", name);
        GGML_ABORT("attn_score_tbq: pipeline compile failed");
    }
    res.nr0 = 1;
    res.nr1 = 1;
    res.nsg = 1;
    res.smem = 0;
    return res;
}

ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_attn_score_polar(ggml_metal_library_t lib) {
    const char * name = "kernel_mul_mv_q4_polar_f32";
    ggml_metal_pipeline_with_params res = ggml_metal_library_get_pipeline(lib, name);
    if (!res.pipeline) {
        res = ggml_metal_library_compile_pipeline(lib, name, name, nullptr);
    }
    if (!res.pipeline) {
        GGML_LOG_ERROR("attn_score_polar: kernel '%s' missing from default.metallib\\n", name);
        GGML_ABORT("attn_score_polar: pipeline compile failed");
    }
    res.nr0 = 1;
    res.nr1 = 1;
    res.nsg = 1;
    res.smem = 0;
    return res;
}

ggml_metal_pipeline_with_params ggml_metal_library_get_pipeline_attn_score_polar_preht(ggml_metal_library_t lib) {
    const char * name = "kernel_attn_score_q4_polar_preht_f32";
    ggml_metal_pipeline_with_params res = ggml_metal_library_get_pipeline(lib, name);
    if (!res.pipeline) {
        res = ggml_metal_library_compile_pipeline(lib, name, name, nullptr);
    }
    if (!res.pipeline) {
        GGML_LOG_ERROR("attn_score_polar_preht: kernel '%s' missing from default.metallib\\n", name);
        GGML_ABORT("attn_score_polar_preht: pipeline compile failed");
    }
    res.nr0 = 1;
    res.nr1 = 1;
    res.nsg = 1;
    res.smem = 0;
    return res;
}

`;
  const patched = original.replace(anchor, helper + anchor);
  if (!dryRun) fs.writeFileSync(cppPath, patched, "utf8");
  return { changed: !dryRun, path: cppPath };
}

function patchMetalTbqPolarOpsHeader(cacheDir, { dryRun }) {
  const headerPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-ops.h",
  );
  const original = fs.readFileSync(headerPath, "utf8");
  if (original.includes(SENTINEL_TBQ_POLAR_ATTN)) {
    return { changed: false, path: headerPath };
  }
  const anchor = `${SENTINEL_QJL_ATTN}
int ggml_metal_op_attn_score_qjl  (ggml_metal_op_t ctx, int idx);`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-tbq-polar-attn] ops.h QJL declaration anchor not found at ${headerPath}`,
    );
  }
  const patched = original.replace(
    anchor,
    `${anchor}
${SENTINEL_TBQ_POLAR_ATTN}
int ggml_metal_op_attn_score_tbq  (ggml_metal_op_t ctx, int idx);
int ggml_metal_op_attn_score_polar(ggml_metal_op_t ctx, int idx);`,
  );
  if (!dryRun) fs.writeFileSync(headerPath, patched, "utf8");
  return { changed: !dryRun, path: headerPath };
}

function patchMetalTbqPolarOpsCpp(cacheDir, { dryRun }) {
  const opsPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-ops.cpp",
  );
  const original = fs.readFileSync(opsPath, "utf8");
  if (original.includes(SENTINEL_TBQ_POLAR_ATTN)) {
    let patched = original.replace(
      "case GGML_TYPE_TBQ4_0:   return 1u;",
      "case GGML_TYPE_TBQ4_0:   return 4u;",
    );
    if (!patched.includes("milady_tbq_blocks_per_threadgroup")) {
      patched = patched.replace(
        `static inline uint32_t milady_tbq_blocks_per_row(ggml_type type) {
    switch (type) {
        case GGML_TYPE_TBQ3_0:   return 4u;
        case GGML_TYPE_TBQ4_0:   return 4u;
        case GGML_TYPE_TBQ3_TCQ: return 1u;
        default: GGML_ABORT("unsupported TurboQuant attention score type");
    }
}
`,
        `static inline uint32_t milady_tbq_blocks_per_row(ggml_type type) {
    switch (type) {
        case GGML_TYPE_TBQ3_0:   return 4u;
        case GGML_TYPE_TBQ4_0:   return 4u;
        case GGML_TYPE_TBQ3_TCQ: return 1u;
        default: GGML_ABORT("unsupported TurboQuant attention score type");
    }
}

static inline uint32_t milady_tbq_blocks_per_threadgroup(ggml_type type) {
    switch (type) {
        case GGML_TYPE_TBQ3_0:   return milady_env_u32("ELIZA_METAL_TBQ3_BLOCKS_PER_TG", 8u, 1u, 64u);
        case GGML_TYPE_TBQ4_0:   return milady_env_u32("ELIZA_METAL_TBQ4_BLOCKS_PER_TG", 32u, 1u, 64u);
        case GGML_TYPE_TBQ3_TCQ: return milady_env_u32("ELIZA_METAL_TBQ3_TCQ_BLOCKS_PER_TG", 4u, 1u, 64u);
        default: GGML_ABORT("unsupported TurboQuant attention score type");
    }
}
`,
      );
    }
    patched = patched.replace(
      "/* blocks_per_threadgroup = */ 8u,",
      "/* blocks_per_threadgroup = */ milady_tbq_blocks_per_threadgroup(ktype),",
    );
    if (patched !== original && !dryRun)
      fs.writeFileSync(opsPath, patched, "utf8");
    return { changed: patched !== original && !dryRun, path: opsPath };
  }
  const tcqCodebook = readTcqCodebookLiteral();
  const funcAnchor = `static int ggml_metal_op_encode_impl(ggml_metal_op_t ctx, int idx) {`;
  if (!original.includes(funcAnchor)) {
    throw new Error(
      `[metal-tbq-polar-attn] ops.cpp encode anchor not found at ${opsPath}`,
    );
  }
  const opFuncs = `${SENTINEL_TBQ_POLAR_ATTN}
struct milady_tbq_score_args {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
    uint32_t blocks_per_threadgroup;
};

struct milady_polar_score_args {
    uint32_t n_rows;
    uint32_t head_dim;
    uint32_t use_qjl;
};

struct milady_polar_preht_score_args {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
    uint32_t use_qjl;
};

static const float k_milady_tbq3_tcq_codebook[512] = {
${tcqCodebook}
};

static inline uint32_t milady_tbq_blocks_per_row(ggml_type type) {
    switch (type) {
        case GGML_TYPE_TBQ3_0:   return 4u;
        case GGML_TYPE_TBQ4_0:   return 4u;
        case GGML_TYPE_TBQ3_TCQ: return 1u;
        default: GGML_ABORT("unsupported TurboQuant attention score type");
    }
}

static inline uint32_t milady_tbq_blocks_per_threadgroup(ggml_type type) {
    // M4 Max multiblock bench best medians (2026-05-10):
    //   TBQ3=8, TBQ4=32, TBQ3_TCQ=4. Voice-mode policy can still force N=1
    //   at a higher scheduler layer when barge-in latency dominates.
    switch (type) {
        case GGML_TYPE_TBQ3_0:   return milady_env_u32("ELIZA_METAL_TBQ3_BLOCKS_PER_TG", 8u, 1u, 64u);
        case GGML_TYPE_TBQ4_0:   return milady_env_u32("ELIZA_METAL_TBQ4_BLOCKS_PER_TG", 32u, 1u, 64u);
        case GGML_TYPE_TBQ3_TCQ: return milady_env_u32("ELIZA_METAL_TBQ3_TCQ_BLOCKS_PER_TG", 4u, 1u, 64u);
        default: GGML_ABORT("unsupported TurboQuant attention score type");
    }
}

int ggml_metal_op_attn_score_tbq(ggml_metal_op_t ctx, int idx) {
    ggml_tensor * op = ctx->node(idx);

    ggml_metal_library_t lib = ctx->lib;
    ggml_metal_encoder_t enc = ctx->enc;

    const ggml_tensor * q  = op->src[0];
    const ggml_tensor * pk = op->src[1];
    const ggml_type ktype = pk->type;

    GGML_ASSERT(q  != nullptr);
    GGML_ASSERT(pk != nullptr);
    GGML_ASSERT(q->type == GGML_TYPE_F32);
    GGML_ASSERT(ktype == GGML_TYPE_TBQ3_0 || ktype == GGML_TYPE_TBQ4_0 || ktype == GGML_TYPE_TBQ3_TCQ);
    GGML_ASSERT(op->type == GGML_TYPE_F32);
    GGML_ASSERT(q->ne[0]  == 128);
    GGML_ASSERT(pk->ne[0] == 128);
    GGML_ASSERT(ggml_is_contiguous_rows(q));
    GGML_ASSERT(ggml_is_contiguous_rows(pk));
    GGML_ASSERT(ggml_is_contiguous_rows(op));

    const uint32_t n_heads     = (uint32_t) q->ne[1];
    const uint32_t n_kv_heads  = (uint32_t) ((const int32_t *) op->op_params)[0];
    const uint32_t n_tokens    = (uint32_t) pk->ne[1];
    const int64_t  n_batch     = q->ne[2];
    const int64_t  ne3         = q->ne[3];

    GGML_ASSERT(n_kv_heads > 0);
    GGML_ASSERT((n_heads % n_kv_heads) == 0);
    GGML_ASSERT(pk->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(pk->ne[3] == ne3);
    GGML_ASSERT(op->ne[0] == (int64_t) n_tokens);
    GGML_ASSERT(op->ne[1] == (int64_t) n_heads);
    GGML_ASSERT(op->ne[2] == n_batch);
    GGML_ASSERT(op->ne[3] == ne3);
    GGML_ASSERT(pk->nb[1] == ggml_row_size(ktype, 128));
    GGML_ASSERT(pk->nb[2] == (size_t) n_tokens * pk->nb[1]);

    milady_tbq_score_args args = {
        /* head_dim = */ 128u,
        /* n_kv = */ n_tokens,
        /* kv_stride_blocks = */ milady_tbq_blocks_per_row(ktype),
        /* q_head = */ 0u,
        /* head_offset_bytes = */ 0u,
        /* blocks_per_threadgroup = */ milady_tbq_blocks_per_threadgroup(ktype),
    };

    auto pipeline = ggml_metal_library_get_pipeline_attn_score_tbq(lib, ktype);

    const ggml_metal_buffer_id q_base   = ggml_metal_get_buffer_id(q);
    const ggml_metal_buffer_id pk_base  = ggml_metal_get_buffer_id(pk);
    const ggml_metal_buffer_id dst_base = ggml_metal_get_buffer_id(op);
    const uint32_t gqa = n_heads / n_kv_heads;

    ggml_metal_encoder_set_pipeline(enc, pipeline);
    if (ktype == GGML_TYPE_TBQ3_TCQ) {
        ggml_metal_encoder_set_bytes(enc, (void *) k_milady_tbq3_tcq_codebook, sizeof(k_milady_tbq3_tcq_codebook), 3);
        ggml_metal_encoder_set_bytes(enc, &args, sizeof(args), 4);
    } else {
        ggml_metal_encoder_set_bytes(enc, &args, sizeof(args), 3);
    }

    const int token_groups = (int) ((n_tokens + args.blocks_per_threadgroup - 1u) / args.blocks_per_threadgroup);
    for (int64_t i3 = 0; i3 < ne3; ++i3) {
        const size_t q_i3   = (size_t) i3 * q->nb[3];
        const size_t pk_i3  = (size_t) i3 * pk->nb[3];
        const size_t dst_i3 = (size_t) i3 * op->nb[3];
        for (int64_t ib = 0; ib < n_batch; ++ib) {
            for (uint32_t h = 0; h < n_heads; ++h) {
                const uint32_t h_k = h / gqa;
                ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(q_base,   q_i3  + (size_t) ib * q->nb[2]  + (size_t) h   * q->nb[1]),  0);
                ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(pk_base,  pk_i3 + (size_t) h_k * pk->nb[2]), 1);
                ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(dst_base, dst_i3 + (size_t) ib * op->nb[2] + (size_t) h   * op->nb[1]), 2);
                ggml_metal_encoder_dispatch_threadgroups(enc, token_groups, 1, 1, 32, 1, 1);
            }
        }
    }

    return 1;
}

int ggml_metal_op_attn_score_polar(ggml_metal_op_t ctx, int idx) {
    ggml_tensor * op = ctx->node(idx);

    ggml_metal_library_t lib = ctx->lib;
    ggml_metal_encoder_t enc = ctx->enc;

    const ggml_tensor * q  = op->src[0];
    const ggml_tensor * pk = op->src[1];

    GGML_ASSERT(q  != nullptr);
    GGML_ASSERT(pk != nullptr);
    GGML_ASSERT(q->type == GGML_TYPE_F32);
    GGML_ASSERT(pk->type == GGML_TYPE_Q4_POLAR);
    GGML_ASSERT(op->type == GGML_TYPE_F32);
    GGML_ASSERT(q->ne[0]  == 128);
    GGML_ASSERT(pk->ne[0] == 128);
    GGML_ASSERT(ggml_is_contiguous_rows(q));
    GGML_ASSERT(ggml_is_contiguous_rows(pk));
    GGML_ASSERT(ggml_is_contiguous_rows(op));

    const int32_t * params = (const int32_t *) op->op_params;
    const uint32_t n_heads     = (uint32_t) q->ne[1];
    const uint32_t n_kv_heads  = (uint32_t) params[0];
    const uint32_t n_tokens    = (uint32_t) pk->ne[1];
    const uint32_t use_qjl     = (uint32_t) (params[1] != 0);
    const uint32_t q_preht     = (uint32_t) (params[2] != 0);
    const int64_t  n_batch     = q->ne[2];
    const int64_t  ne3         = q->ne[3];

    GGML_ASSERT(n_kv_heads > 0);
    GGML_ASSERT((n_heads % n_kv_heads) == 0);
    GGML_ASSERT(pk->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(pk->ne[3] == ne3);
    GGML_ASSERT(op->ne[0] == (int64_t) n_tokens);
    GGML_ASSERT(op->ne[1] == (int64_t) n_heads);
    GGML_ASSERT(op->ne[2] == n_batch);
    GGML_ASSERT(op->ne[3] == ne3);
    GGML_ASSERT(pk->nb[1] == ggml_row_size(GGML_TYPE_Q4_POLAR, 128));
    GGML_ASSERT(pk->nb[2] == (size_t) n_tokens * pk->nb[1]);

    const ggml_metal_buffer_id q_base   = ggml_metal_get_buffer_id(q);
    const ggml_metal_buffer_id pk_base  = ggml_metal_get_buffer_id(pk);
    const ggml_metal_buffer_id dst_base = ggml_metal_get_buffer_id(op);
    const uint32_t gqa = n_heads / n_kv_heads;

    if (q_preht != 0u) {
        auto pipeline = ggml_metal_library_get_pipeline_attn_score_polar_preht(lib);
        ggml_metal_encoder_set_pipeline(enc, pipeline);

        for (int64_t i3 = 0; i3 < ne3; ++i3) {
            const size_t q_i3   = (size_t) i3 * q->nb[3];
            const size_t pk_i3  = (size_t) i3 * pk->nb[3];
            const size_t dst_i3 = (size_t) i3 * op->nb[3];
            for (int64_t ib = 0; ib < n_batch; ++ib) {
                ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(q_base,   q_i3  + (size_t) ib * q->nb[2]), 0);
                ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(pk_base,  pk_i3),                         1);
                ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(dst_base, dst_i3 + (size_t) ib * op->nb[2]), 2);
                for (uint32_t h = 0; h < n_heads; ++h) {
                    const uint32_t h_k = h / gqa;
                    milady_polar_preht_score_args args = {
                        /* head_dim = */ 128u,
                        /* n_kv = */ n_tokens,
                        /* kv_stride_blocks = */ 1u,
                        /* q_head = */ h,
                        /* head_offset_bytes = */ (uint32_t) ((size_t) h_k * pk->nb[2]),
                        /* use_qjl = */ use_qjl,
                    };
                    ggml_metal_encoder_set_bytes(enc, &args, sizeof(args), 3);
                    ggml_metal_encoder_dispatch_threadgroups(enc, (int) n_tokens, 1, 1, 32, 1, 1);
                }
            }
        }
    } else {
        milady_polar_score_args args = {
            /* n_rows = */ n_tokens,
            /* head_dim = */ 128u,
            /* use_qjl = */ use_qjl,
        };

        auto pipeline = ggml_metal_library_get_pipeline_attn_score_polar(lib);

        ggml_metal_encoder_set_pipeline(enc, pipeline);
        ggml_metal_encoder_set_bytes(enc, &args, sizeof(args), 3);

        for (int64_t i3 = 0; i3 < ne3; ++i3) {
            const size_t q_i3   = (size_t) i3 * q->nb[3];
            const size_t pk_i3  = (size_t) i3 * pk->nb[3];
            const size_t dst_i3 = (size_t) i3 * op->nb[3];
            for (int64_t ib = 0; ib < n_batch; ++ib) {
                for (uint32_t h = 0; h < n_heads; ++h) {
                    const uint32_t h_k = h / gqa;
                    ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(pk_base,  pk_i3 + (size_t) h_k * pk->nb[2]), 0);
                    ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(q_base,   q_i3  + (size_t) ib * q->nb[2]  + (size_t) h   * q->nb[1]),  1);
                    ggml_metal_encoder_set_buffer(enc, milady_metal_buffer_offset(dst_base, dst_i3 + (size_t) ib * op->nb[2] + (size_t) h   * op->nb[1]), 2);
                    ggml_metal_encoder_dispatch_threadgroups(enc, (int) n_tokens, 1, 1, 32, 1, 1);
                }
            }
        }
    }

    return 1;
}

`;
  let patched = original.replace(funcAnchor, opFuncs + funcAnchor);
  const switchAnchor = `        case GGML_OP_ATTN_SCORE_QJL:
            {
                n_fuse = ggml_metal_op_attn_score_qjl(ctx, idx);
            } break;`;
  if (!patched.includes(switchAnchor)) {
    throw new Error(
      `[metal-tbq-polar-attn] ops.cpp QJL switch anchor not found at ${opsPath}`,
    );
  }
  patched = patched.replace(
    switchAnchor,
    `${switchAnchor}
        case GGML_OP_ATTN_SCORE_TBQ:
            {
                n_fuse = ggml_metal_op_attn_score_tbq(ctx, idx);
            } break;
        case GGML_OP_ATTN_SCORE_POLAR:
            {
                n_fuse = ggml_metal_op_attn_score_polar(ctx, idx);
            } break;`,
  );
  if (!dryRun) fs.writeFileSync(opsPath, patched, "utf8");
  return { changed: !dryRun, path: opsPath };
}

function patchMetalTbqPolarSupportsOp(cacheDir, { dryRun }) {
  const deviceMPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "ggml-metal-device.m",
  );
  const original = fs.readFileSync(deviceMPath, "utf8");
  if (original.includes(SENTINEL_TBQ_POLAR_ATTN)) {
    const patched = original.replace(
      `(op->src[1]->type == GGML_TYPE_TBQ3_0 ||
                 op->src[1]->type == GGML_TYPE_TBQ3_TCQ) &&`,
      `(op->src[1]->type == GGML_TYPE_TBQ3_0 ||
                 op->src[1]->type == GGML_TYPE_TBQ4_0 ||
                 op->src[1]->type == GGML_TYPE_TBQ3_TCQ) &&`,
    );
    if (patched !== original && !dryRun)
      fs.writeFileSync(deviceMPath, patched, "utf8");
    return { changed: patched !== original && !dryRun, path: deviceMPath };
  }
  const anchor = `        case GGML_OP_ATTN_SCORE_QJL:
            // ${SENTINEL_QJL_ATTN}`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-tbq-polar-attn] supports_op QJL anchor not found at ${deviceMPath}`,
    );
  }
  const insert = `        case GGML_OP_ATTN_SCORE_TBQ:
            // ${SENTINEL_TBQ_POLAR_ATTN}
            return has_simdgroup_reduction &&
                op->type == GGML_TYPE_F32 &&
                op->src[0] != NULL &&
                op->src[1] != NULL &&
                op->src[0]->type == GGML_TYPE_F32 &&
                (op->src[1]->type == GGML_TYPE_TBQ3_0 ||
                 op->src[1]->type == GGML_TYPE_TBQ4_0 ||
                 op->src[1]->type == GGML_TYPE_TBQ3_TCQ) &&
                op->src[0]->ne[0] == 128 &&
                op->src[1]->ne[0] == 128 &&
                ggml_is_contiguous_rows(op) &&
                ggml_is_contiguous_rows(op->src[0]) &&
                ggml_is_contiguous_rows(op->src[1]);
        case GGML_OP_ATTN_SCORE_POLAR:
            return has_simdgroup_reduction &&
                op->type == GGML_TYPE_F32 &&
                op->src[0] != NULL &&
                op->src[1] != NULL &&
                op->src[0]->type == GGML_TYPE_F32 &&
                op->src[1]->type == GGML_TYPE_Q4_POLAR &&
                op->src[0]->ne[0] == 128 &&
                op->src[1]->ne[0] == 128 &&
                ggml_is_contiguous_rows(op) &&
                ggml_is_contiguous_rows(op->src[0]) &&
                ggml_is_contiguous_rows(op->src[1]);
${anchor}`;
  const patched = original.replace(anchor, insert);
  if (!dryRun) fs.writeFileSync(deviceMPath, patched, "utf8");
  return { changed: !dryRun, path: deviceMPath };
}

function patchMetalTbqPolarAttnDispatch(cacheDir, { dryRun }) {
  const ggmlOps = patchGgmlTbqPolarAttnOps(cacheDir, { dryRun });
  const deviceHeader = patchMetalTbqPolarDeviceHeader(cacheDir, { dryRun });
  const deviceCpp = patchMetalTbqPolarDeviceCpp(cacheDir, { dryRun });
  const opsHeader = patchMetalTbqPolarOpsHeader(cacheDir, { dryRun });
  const opsCpp = patchMetalTbqPolarOpsCpp(cacheDir, { dryRun });
  const supportsOp = patchMetalTbqPolarSupportsOp(cacheDir, { dryRun });
  return { ggmlOps, deviceHeader, deviceCpp, opsHeader, opsCpp, supportsOp };
}

export function patchMetalDispatch(cacheDir, { dryRun = false } = {}) {
  const patchedFiles = [
    path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-device.h"),
    path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-device.cpp"),
    path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-ops.cpp"),
  ].filter((file) => {
    try {
      return fs.readFileSync(file, "utf8").includes(SENTINEL_DISPATCH);
    } catch {
      return false;
    }
  });

  const message =
    "[metal-dispatch] NOT wiring generic Metal GGML dispatch for milady " +
    "QJL/Polar/TBQ kernels. The standalone kernels use bespoke attention/" +
    "projection contracts that do not match generic MUL_MAT/GET_ROWS. " +
    "Dedicated ATTN_SCORE graph ops are required for runtime-ready bits.";
  if (patchedFiles.length > 0) {
    const detail =
      `${message} Found an older unsafe MILADY-DISPATCH-V1 patch in:\n` +
      `  ${patchedFiles.join("\n  ")}\n` +
      "Use a clean eliza-llama-cpp checkout/cache before producing artifacts.";
    if (!dryRun) {
      throw new Error(detail);
    }
    console.warn(detail);
  } else {
    console.log(`${dryRun ? "(dry-run) " : ""}${message}`);
  }
  const qjlAttn = patchMetalQjlAttnDispatch(cacheDir, { dryRun });
  const qjlAnchorsAlreadyPresent = [
    path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-device.h"),
    path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-ops.h"),
    path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-ops.cpp"),
  ].every(
    (file) =>
      fs.existsSync(file) &&
      fs.readFileSync(file, "utf8").includes(SENTINEL_QJL_ATTN),
  );
  const tbqPolarAttn =
    dryRun && !qjlAnchorsAlreadyPresent
      ? { deferredUntilQjlPatchWrites: true }
      : patchMetalTbqPolarAttnDispatch(cacheDir, { dryRun });
  console.log(
    `[metal-dispatch] ${dryRun ? "(dry-run) " : ""}wired dedicated GGML_OP_ATTN_SCORE_QJL dispatch via kernel_attn_score_qjl1_256_multi`,
  );
  console.log(
    `[metal-dispatch] ${dryRun ? "(dry-run) " : ""}wired dedicated GGML_OP_ATTN_SCORE_TBQ / GGML_OP_ATTN_SCORE_POLAR dispatch via shipped TurboQuant and PolarQuant kernels` +
      (tbqPolarAttn.deferredUntilQjlPatchWrites
        ? " (deferred in dry-run until QJL patch writes anchors)"
        : ""),
  );
  console.log(
    `[metal-dispatch] ${dryRun ? "(dry-run) " : ""}runtime-ready gates: ` +
      Object.entries(METAL_RUNTIME_DISPATCH_GATES)
        .map(
          ([key, gate]) =>
            `${key}=${gate.runtimeReady ? "runtime-ready" : gate.status}`,
        )
        .join(", "),
  );
  return {
    status: "attn-score-qjl-tbq-polar",
    unsafePatchPresent: patchedFiles,
    qjlAttn,
    tbqPolarAttn,
  };
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
  const embeddedLoader = patchEmbeddedMetallibLoader(cacheDir, { dryRun });
  const dispatch = patchMetalDispatch(cacheDir, { dryRun });
  console.log(
    `[metal-kernels] ${dryRun ? "(dry-run) " : ""}wired ${copied.length} shipped Metal kernels: ${METAL_KERNEL_FILES.join(", ")}`,
  );
  console.log(
    `[metal-kernels] ${dryRun ? "(dry-run) " : ""}CMakeLists.txt: ${cmake.changed ? "patched" : "already-patched"} (${cmake.path})`,
  );
  console.log(
    `[metal-kernels] ${dryRun ? "(dry-run) " : ""}embedded loader: ${embeddedLoader.changed ? "patched" : "already-patched"} (${embeddedLoader.path})`,
  );
  return { copied, cmake, embeddedLoader, dispatch };
}
