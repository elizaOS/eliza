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
//   * Convert the EMBED_LIBRARY path used by iOS targets to embed compiled
//     metallib bytes rather than concatenated Metal source. This avoids
//     duplicate declarations between ggml-metal.metal + standalones and lets
//     iOS load the same multi-TU kernel set as desktop.

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
const SENTINEL_EMBED = "# MILADY-KERNEL-EMBED-PATCH-V1";
const SENTINEL_EMBED_LOADER = "// MILADY-EMBEDDED-METALLIB-LOADER-V1";
const SENTINEL_QJL_ATTN = "// MILADY-QJL-ATTN-DISPATCH-V1";

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
            "\n\n    target_sources(ggml-metal PRIVATE \"${METALLIB_EMBED_ASM}\")",
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
      patched.slice(0, embedStart) +
      embedReplacement +
      patched.slice(embedEnd);
    changed = true;
  }

  // The exact block we replace. This pipe pattern has been stable in the
  // milady-ai/llama.cpp fork for the entire v0.4.x line; if the upstream
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
    throw new Error("[metal-kernels] embedded loader replace produced no change");
  }
  if (!dryRun) fs.writeFileSync(deviceMPath, patched, "utf8");
  return { changed: !dryRun, path: deviceMPath };
}

const SENTINEL_DISPATCH = "// MILADY-DISPATCH-V1";

function patchMetalQjlAttnHeader(cacheDir, { dryRun }) {
  const headerPath = path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-device.h");
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
  const cppPath = path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-device.cpp");
  const original = fs.readFileSync(cppPath, "utf8");
  if (original.includes(SENTINEL_QJL_ATTN)) {
    const upgraded = original.replace(
      'const char * name = "kernel_attn_score_qjl1_256";',
      'const char * name = "kernel_attn_score_qjl1_256_multi";',
    );
    if (upgraded !== original && !dryRun) fs.writeFileSync(cppPath, upgraded, "utf8");
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
  const headerPath = path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-ops.h");
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
  const opsPath = path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-ops.cpp");
  const original = fs.readFileSync(opsPath, "utf8");
  if (original.includes(SENTINEL_QJL_ATTN)) {
    let upgraded = original.replace(
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
    upgraded = upgraded.replace(
      `        /* n_tokens   = */ n_tokens,
        /* proj_dim   = */ 256u,
    };`,
      `        /* n_tokens   = */ n_tokens,
        /* proj_dim   = */ 256u,
        /* tokens_per_threadgroup = */ 32u,
    };`,
    );
    upgraded = upgraded.replace(
      `            ggml_metal_encoder_dispatch_threadgroups(enc, (int) n_heads, (int) n_tokens, 1, 32, 1, 1);`,
      `            const int token_groups = (int) ((n_tokens + args.tokens_per_threadgroup - 1u) / args.tokens_per_threadgroup);
            ggml_metal_encoder_dispatch_threadgroups(enc, (int) n_heads, token_groups, 1, 32, 1, 1);`,
    );
    if (upgraded !== original && !dryRun) fs.writeFileSync(opsPath, upgraded, "utf8");
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
        /* tokens_per_threadgroup = */ 32u,
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
  const deviceMPath = path.join(cacheDir, "ggml", "src", "ggml-metal", "ggml-metal-device.m");
  const original = fs.readFileSync(deviceMPath, "utf8");
  if (original.includes(SENTINEL_QJL_ATTN)) {
    return { changed: false, path: deviceMPath };
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
                op->src[1]->ne[0] == 128;
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
    "Build output is symbol-shipped only until dedicated ATTN_SCORE and " +
    "bundle-aware graph ops land.";
  if (patchedFiles.length > 0) {
    const detail =
      `${message} Found an older unsafe MILADY-DISPATCH-V1 patch in:\n` +
      `  ${patchedFiles.join("\n  ")}\n` +
      "Use a clean milady-llama-cpp checkout/cache before producing artifacts.";
    if (!dryRun) {
      throw new Error(detail);
    }
    console.warn(detail);
  } else {
    console.log(`${dryRun ? "(dry-run) " : ""}${message}`);
  }
  const qjlAttn = patchMetalQjlAttnDispatch(cacheDir, { dryRun });
  console.log(
    `[metal-dispatch] ${dryRun ? "(dry-run) " : ""}wired dedicated GGML_OP_ATTN_SCORE_QJL dispatch via kernel_attn_score_qjl1_256_multi`,
  );
  return { status: "qjl-attn-only", unsafePatchPresent: patchedFiles, qjlAttn };
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
