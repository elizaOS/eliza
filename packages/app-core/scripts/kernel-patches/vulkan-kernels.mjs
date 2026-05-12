// Vulkan kernel-shipment staging for the elizaOS/llama.cpp fork (v1.0.0-eliza).
//
// What this module does:
//
//   1. Copies the nine verified standalone .comp shaders from
//      packages/inference/vulkan/ into the fork at
//      ggml/src/ggml-vulkan/vulkan-shaders/<name>.comp. The fork's CMakeLists
//      uses `file(GLOB CONFIGURE_DEPENDS ${input_dir}/*.comp)` to discover
//      shader sources, so dropping files into vulkan-shaders/ is sufficient
//      for glslc to compile them. Registration with vulkan-shaders-gen (so
//      the resulting SPV bytes appear as `<name>_data[]`/`<name>_len` in
//      ggml-vulkan-shaders.hpp) is handled by the patch in
//      vulkan-dispatch-patches/01-vulkan-shaders-gen.patch.
//
//   2. Applies the two unified-anchor staging patches under
//      vulkan-dispatch-patches/:
//        - 01-vulkan-shaders-gen.patch — adds 9 string_to_spv() registrations
//          at the bottom of process_shaders().
//        - 02-ggml-vulkan-pipelines.patch — extends vk_device_struct with 9
//          pipeline slots and adds 9 ggml_vk_create_pipeline() calls at the
//          bottom of ggml_vk_load_shaders(). End result: each eliza SPV blob
//          is referenced at link time and `nm libggml-vulkan.so | grep
//          eliza_` shows the new symbols.
//
//   3. Adds Vulkan graph dispatch for the Eliza-1 attention score ops:
//        - GGML_OP_ATTN_SCORE_QJL
//        - GGML_OP_ATTN_SCORE_TBQ   (TBQ3_0, TBQ4_0, TBQ3_TCQ)
//        - GGML_OP_ATTN_SCORE_POLAR
//
//      These routes bind the standalone eliza pipelines directly. They are
//      intentionally conservative: q/pk/dst must be contiguous row tensors and
//      the current route only advertises support for the single-batch shape
//      used by the runtime smoke (ne[2]/ne[3] == 1, except pk head fanout).
//
//      Patches are idempotent: each carries a `ELIZA-VK-DISPATCH-PATCH-V1`
//      sentinel; if the sentinel is already present in the target file, the
//      hunk is skipped (re-running the build is safe).
//
// Out of scope:
//
//   * Generic mat-vec / get-rows replacement for every GGML call site. The
//     runtime patch wires the attention-score graph routes needed by the
//     Eliza-1 local voice/text path. Broader type-aware branches in
//     ggml_vk_get_dequantize_mul_mat_vec() remain future work because those
//     paths use different bind-set conventions from the standalone kernels.
//
//   * Batched ne[2]/ne[3] graph shapes. The source patch refuses to advertise
//     those shapes until a dedicated graph smoke covers offsets and fanout.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchGgmlTbqPolarAttnOps } from "./metal-kernels.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STANDALONE_VULKAN_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "inference",
  "vulkan",
);

const PATCHES_DIR = path.resolve(__dirname, "vulkan-dispatch-patches");

export const VULKAN_KERNEL_FILES = [
  "turbo3.comp",
  "turbo4.comp",
  "turbo3_tcq.comp",
  "qjl.comp",
  "qjl_get_rows.comp",
  "qjl_mul_mv.comp",
  "polar.comp",
  "polar_preht.comp",
  "polar_get_rows.comp",
];

// Multi-block-per-workgroup standalone variants (turbo3_multi.comp etc.). One
// SPV family per kernel; the blocks/tokens-per-workgroup count is a SPIR-V
// specialization constant (constant_id 0) the consumer sets at pipeline-create
// time, so the same blob tunes per device without recompilation. They are
// verified by `make -C packages/inference/verify vulkan-verify-multiblock`.
// Staged into the fork alongside the single-block kernels; the runtime routes
// non-voice / long-context scoring (large n_kv) through them with a
// device-tuned spec constant (BLOCKS_PER_WG / TOKENS_PER_WG = 4 default).
export const VULKAN_MULTIBLOCK_KERNEL_FILES = [
  "turbo3_multi.comp",
  "turbo4_multi.comp",
  "turbo3_tcq_multi.comp",
  "qjl_multi.comp",
];

// Fused-attention compute shaders (QJL-K score + V-mix, online softmax, score
// never materialised). One workgroup per (q_head); q_pos is a push constant.
// Verified standalone by `make -C packages/inference/verify vulkan-verify-fused`.
// Staged into the fork; the runtime wires GGML_OP_FUSED_ATTN_QJL_TBQ (and the
// Polar V-mix variant) graph dispatch onto these pipelines.
export const VULKAN_FUSED_KERNEL_FILES = [
  "fused_attn_qjl_tbq.comp",
  "fused_attn_qjl_polar.comp",
];

// Everything staged into the fork's vulkan-shaders/ directory.
const VULKAN_ALL_STAGED_FILES = [
  ...VULKAN_KERNEL_FILES,
  ...VULKAN_MULTIBLOCK_KERNEL_FILES,
  ...VULKAN_FUSED_KERNEL_FILES,
];

const SHADER_SENTINEL = "// ELIZA-VK-DISPATCH-PATCH-V1";
const PATCH_SENTINEL = "ELIZA-VK-DISPATCH-PATCH-V1";
const RUNTIME_SENTINEL = "// ELIZA-VK-RUNTIME-DISPATCH-V1";

const PATCH_TARGETS = [
  {
    file: "01-vulkan-shaders-gen.patch",
    target: path.posix.join(
      "ggml",
      "src",
      "ggml-vulkan",
      "vulkan-shaders",
      "vulkan-shaders-gen.cpp",
    ),
  },
  {
    file: "02-ggml-vulkan-pipelines.patch",
    target: path.posix.join(
      "ggml",
      "src",
      "ggml-vulkan",
      "ggml-vulkan.cpp",
    ),
  },
];

function assertStandalonesPresent() {
  const missing = [];
  for (const name of VULKAN_ALL_STAGED_FILES) {
    const src = path.join(STANDALONE_VULKAN_DIR, name);
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
      `[vulkan-kernels] missing/invalid standalone shader sources:\n  ${missing.join("\n  ")}`,
    );
  }
}

function copyStandalonesIntoFork(cacheDir, { dryRun }) {
  // vulkan-shaders/ is the directory the upstream CMakeLists uses for
  // file(GLOB CONFIGURE_DEPENDS *.comp) — dropping our files there causes
  // glslc to compile them automatically as part of the existing per-shader
  // add_custom_command pipeline. The string_to_spv() registration patch
  // (01-vulkan-shaders-gen.patch) wires the resulting .spv bytes into
  // ggml-vulkan-shaders.hpp.
  const targetDir = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-vulkan",
    "vulkan-shaders",
  );
  if (dryRun) {
    console.log(`[vulkan-kernels] (dry-run) ensure dir ${targetDir}`);
  } else if (!fs.existsSync(targetDir)) {
    throw new Error(
      `[vulkan-kernels] expected vulkan-shaders/ to exist in fork: ${targetDir}`,
    );
  }
  const copied = [];
  for (const name of VULKAN_ALL_STAGED_FILES) {
    const src = path.join(STANDALONE_VULKAN_DIR, name);
    const dst = path.join(targetDir, name);
    if (dryRun) {
      console.log(`[vulkan-kernels] (dry-run) cp ${src} -> ${dst}`);
    } else {
      const text = fs.readFileSync(src, "utf8");
      // Mark the staged copy with the same sentinel as the patches so a
      // human inspecting the fork tree can see the file came from us.
      const stamped =
        `${SHADER_SENTINEL} — staged from packages/inference/vulkan/${name} by\n` +
        `// build-llama-cpp-dflash.mjs. Frozen — do not edit in fork.\n` +
        text;
      fs.writeFileSync(dst, stamped, "utf8");
    }
    copied.push(name);
  }
  return copied;
}

// Parse one anchor-driven patch file. Returns an array of hunks; each hunk
// has { anchor, sentinel, inject } strings.
function parsePatchFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const hunks = [];
  let cur = null;
  let inInject = false;
  let injectLines = [];
  for (const line of lines) {
    if (line.startsWith("ANCHOR")) {
      cur = { anchor: line.replace(/^ANCHOR\s+/, ""), sentinel: null, inject: null };
    } else if (line.startsWith("SENTINEL")) {
      if (!cur) throw new Error(`[vulkan-kernels] SENTINEL before ANCHOR in ${filePath}`);
      cur.sentinel = line.replace(/^SENTINEL\s+/, "").trim();
    } else if (line === "---INJECT-BEGIN---") {
      inInject = true;
      injectLines = [];
    } else if (line === "---INJECT-END---") {
      if (!cur) throw new Error(`[vulkan-kernels] INJECT-END without ANCHOR in ${filePath}`);
      cur.inject = injectLines.join("\n");
      hunks.push(cur);
      cur = null;
      inInject = false;
    } else if (inInject) {
      injectLines.push(line);
    }
  }
  if (hunks.length === 0) {
    throw new Error(`[vulkan-kernels] no hunks parsed from ${filePath}`);
  }
  return hunks;
}

// Apply one parsed hunk to file contents. Returns { text, applied } where
// applied=false means the inject block was already present (idempotent skip).
//
// Idempotency uses an *exact* check — the inject block already in the file —
// rather than a coarse global sentinel, so multi-hunk patches against the
// same file (e.g. struct-field hunk + load-shaders hunk) can be applied
// independently and re-applied safely.
function applyHunk(text, hunk, ctx) {
  // Use the first non-blank line of the inject block as the per-hunk
  // sentinel. Each inject block in our patches starts with a unique
  // `// ELIZA-VK-DISPATCH-PATCH-V1 BEGIN — <description>` comment, so
  // first-non-blank identifies it precisely.
  const firstLine = hunk.inject.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) {
    throw new Error(`[vulkan-kernels] empty inject block in ${ctx}`);
  }
  if (text.includes(firstLine)) {
    return { text, applied: false };
  }
  const idx = text.indexOf(hunk.anchor);
  if (idx === -1) {
    throw new Error(
      `[vulkan-kernels] anchor not found in ${ctx}: ${JSON.stringify(hunk.anchor)}`,
    );
  }
  // Find the start of the line containing the anchor so we insert before it.
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const before = text.slice(0, lineStart);
  const after = text.slice(lineStart);
  return { text: before + hunk.inject + after, applied: true };
}

function applyPatches(cacheDir, { dryRun }) {
  const results = [];
  for (const { file, target } of PATCH_TARGETS) {
    const patchPath = path.join(PATCHES_DIR, file);
    const targetPath = path.join(cacheDir, target);
    if (!fs.existsSync(patchPath)) {
      throw new Error(`[vulkan-kernels] missing patch file: ${patchPath}`);
    }
    if (!fs.existsSync(targetPath)) {
      throw new Error(`[vulkan-kernels] missing target file: ${targetPath}`);
    }
    const hunks = parsePatchFile(patchPath);
    if (dryRun) {
      console.log(
        `[vulkan-kernels] (dry-run) would apply ${hunks.length} hunk(s) from ${file} to ${target}`,
      );
      results.push({ file, target, hunks: hunks.length, applied: 0, skipped: hunks.length });
      continue;
    }
    let text = fs.readFileSync(targetPath, "utf8");
    let applied = 0;
    let skipped = 0;
    for (const hunk of hunks) {
      const r = applyHunk(text, hunk, target);
      text = r.text;
      if (r.applied) applied++; else skipped++;
    }
    fs.writeFileSync(targetPath, text, "utf8");
    results.push({ file, target, hunks: hunks.length, applied, skipped });
  }
  return results;
}

function ensureLineAfter(text, anchor, line, ctx) {
  if (text.includes(line)) return { text, changed: false };
  if (!text.includes(anchor)) {
    throw new Error(
      `[vulkan-kernels] repair anchor not found in ${ctx}: ${anchor}`,
    );
  }
  return {
    text: text.replace(anchor, `${anchor}\n${line}`),
    changed: true,
  };
}

function repairPolarPrehtShaderRegistration(cacheDir, { dryRun }) {
  const targetPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-vulkan",
    "vulkan-shaders",
    "vulkan-shaders-gen.cpp",
  );
  const anchor = `    string_to_spv("eliza_polar",          "polar.comp",          {});`;
  const line = `    string_to_spv("eliza_polar_preht",    "polar_preht.comp",    {});`;
  const original = fs.readFileSync(targetPath, "utf8");
  const repaired = ensureLineAfter(original, anchor, line, targetPath);
  if (repaired.changed && !dryRun) {
    fs.writeFileSync(targetPath, repaired.text, "utf8");
  }
  return {
    target: targetPath,
    changed: repaired.changed && !dryRun,
    wouldChange: repaired.changed,
  };
}

function repairPolarPrehtPipeline(cacheDir, { dryRun }) {
  const targetPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-vulkan",
    "ggml-vulkan.cpp",
  );
  let text = fs.readFileSync(targetPath, "utf8");
  let changed = false;

  {
    const r = ensureLineAfter(
      text,
      `    vk_pipeline pipeline_eliza_polar;`,
      `    vk_pipeline pipeline_eliza_polar_preht;`,
      targetPath,
    );
    text = r.text;
    changed = changed || r.changed;
  }
  {
    const r = ensureLineAfter(
      text,
      `    ggml_vk_create_pipeline(device, device->pipeline_eliza_polar,          "eliza_polar",          eliza_polar_len,          eliza_polar_data,          "main", 3, 6 * sizeof(uint32_t), {1, 1, 1}, {}, 1);`,
      `    ggml_vk_create_pipeline(device, device->pipeline_eliza_polar_preht,    "eliza_polar_preht",    eliza_polar_preht_len,    eliza_polar_preht_data,    "main", 3, 6 * sizeof(uint32_t), {1, 1, 1}, {}, 1);`,
      targetPath,
    );
    text = r.text;
    changed = changed || r.changed;
  }

  if (changed && !dryRun) {
    fs.writeFileSync(targetPath, text, "utf8");
  }
  return {
    target: targetPath,
    changed: changed && !dryRun,
    wouldChange: changed,
  };
}

function extractTcqCodebookSource() {
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
      `[vulkan-runtime-dispatch] could not extract TCQ codebook from ${referencePath}`,
    );
  }
  return match[1].trim();
}

function patchVulkanRuntimeDispatch(cacheDir, { dryRun }) {
  // TBQ and Polar attention-score graph constructors are backend-neutral ggml
  // surface area. The Metal patch already owns the idempotent ggml.h/ggml.c
  // mutation; reuse it here so a fresh Vulkan-only build can compile the same
  // graph ops instead of depending on a previous Metal build having dirtied the
  // cached fork.
  const ggmlOps = patchGgmlTbqPolarAttnOps(cacheDir, { dryRun });

  const vulkanPath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-vulkan",
    "ggml-vulkan.cpp",
  );
  let original = fs.readFileSync(vulkanPath, "utf8");
  let patched = original;

  // 02-ggml-vulkan-pipelines.patch historically created eliza_polar with a
  // 3*u32 push-constant range. Runtime graph dispatch needs per-head output and
  // K-head byte offsets so it can bind the whole tensor and avoid illegal
  // unaligned descriptor offsets. Keep old cached checkouts repairable.
  patched = patched.replace(
    `"eliza_polar",          eliza_polar_len,          eliza_polar_data,          "main", 3, 3 * sizeof(uint32_t),`,
    `"eliza_polar",          eliza_polar_len,          eliza_polar_data,          "main", 3, 6 * sizeof(uint32_t),`,
  );


  if (!patched.includes(RUNTIME_SENTINEL)) {
    const contextAnchor = `    // for GGML_VK_PERF_LOGGER`;
    if (!patched.includes(contextAnchor)) {
      throw new Error(
        `[vulkan-runtime-dispatch] context anchor not found in ${vulkanPath}`,
      );
    }
    patched = patched.replace(
      contextAnchor,
      `    ${RUNTIME_SENTINEL}
    // Persistent device-side TCQ codebook used by GGML_OP_ATTN_SCORE_TBQ when
    // packed_k is GGML_TYPE_TBQ3_TCQ. Created lazily on first dispatch.
    vk_buffer eliza_turbo3_tcq_codebook;

${contextAnchor}`,
    );

    const codebook = extractTcqCodebookSource();
    const helperAnchor = `static void ggml_vk_compute_forward(ggml_backend_vk_context* ctx, ggml_cgraph * cgraph, ggml_tensor* tensor, int tensor_idx, bool almost_ready);`;
    if (!patched.includes(helperAnchor)) {
      throw new Error(
        `[vulkan-runtime-dispatch] compute-forward anchor not found in ${vulkanPath}`,
      );
    }
    const helper = `${RUNTIME_SENTINEL}
struct eliza_vk_qjl_score_push {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t proj_dim;
};

struct eliza_vk_tbq_score_push {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
};

struct eliza_vk_polar_score_push {
    uint32_t n_rows;
    uint32_t head_dim;
    uint32_t use_qjl;
    uint32_t k_offset_bytes;
    uint32_t q_offset;
    uint32_t y_offset;
};

struct eliza_vk_fused_attn_push {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t q_pos;
    uint32_t sm_scale_bits;
    uint32_t kv_tile;
};

// Long-context / non-voice scoring amortises the per-dispatch launch tax by
// folding several KV indices (resp. tokens) into one workgroup via the
// constant_id=0 spec constant (BLOCKS_PER_WG / TOKENS_PER_WG) baked into the
// _multi pipeline at create time. Voice / small-n_kv stays single-block.
//
// The *fold factor* is device-policy: it is chosen by vendor in
// ggml_vk_load_shaders (02-ggml-vulkan-pipelines.patch hunk 2) and stored on
// device->eliza_vk_{tbq,qjl}_multiblock_factor. The dispatch here reads that
// field so the grid divisor always matches whatever the pipeline was created
// with. From vulkan_bench (VK_QUERY_TYPE_TIMESTAMP per-dispatch sweep over
// {1,2,4,8,16}; vulkan_kopt_2026-05-11.json):
//   * NVIDIA discrete (RTX 5080 Laptop): TBQ factor 16 (turbo3 386us→48us at
//     4k, ~3.2x at 32k), QJL factor 8 (4742us→374us at 4k, ~8.6x at 32k).
//   * Intel Arc/Xe iGPU (Mesa ANV 25.2.8): bandwidth-bound at n_kv>=512, both
//     factors stay 4 — only the engage threshold matters. QJL engages from
//     1024 tokens (the fold hoists the 256-wide q_sketch + sign vector out of
//     the per-token loop, ~1.3x at 512 / ~1.8x at 4k); TBQ engages only at
//     n_kv>=8192 (it's a wash at 512 and a slight regression at 4k on ANV).
//   * Default / unprofiled (Adreno, Mali, AMD): conservative factor 4 and the
//     same thresholds — safe everywhere. AMD wave64 wants its own sweep.
// (The thresholds below are the same on every device; only the fold factor
// diverges. The discrete-GPU thresholds being identical to the iGPU ones is
// deliberate — on NVIDIA the _multi path is a win at *every* measured length
// (e.g. turbo3 512: 83us single → 30us folded), so engaging from 1024/8192
// only loses a little of the available speedup at the very small end.)
static const int64_t  ELIZA_VK_QJL_MULTIBLOCK_THRESHOLD = 1024;
static const int64_t  ELIZA_VK_TBQ_MULTIBLOCK_THRESHOLD = 8192;

static const float k_eliza_tbq3_tcq_codebook[512] = {
${codebook}
};

static vk_pipeline eliza_vk_pipeline_for_tbq(ggml_backend_vk_context * ctx, ggml_type type) {
    switch (type) {
        case GGML_TYPE_TBQ3_0:   return ctx->device->pipeline_eliza_turbo3;
        case GGML_TYPE_TBQ4_0:   return ctx->device->pipeline_eliza_turbo4;
        case GGML_TYPE_TBQ3_TCQ: return ctx->device->pipeline_eliza_turbo3_tcq;
        default: GGML_ABORT("eliza_vk_pipeline_for_tbq: unsupported type");
    }
}

static vk_pipeline eliza_vk_pipeline_for_tbq_multi(ggml_backend_vk_context * ctx, ggml_type type) {
    switch (type) {
        case GGML_TYPE_TBQ3_0:   return ctx->device->pipeline_eliza_turbo3_multi;
        case GGML_TYPE_TBQ4_0:   return ctx->device->pipeline_eliza_turbo4_multi;
        case GGML_TYPE_TBQ3_TCQ: return ctx->device->pipeline_eliza_turbo3_tcq_multi;
        default: GGML_ABORT("eliza_vk_pipeline_for_tbq_multi: unsupported type");
    }
}

static vk_buffer eliza_vk_turbo3_tcq_codebook(ggml_backend_vk_context * ctx) {
    if (ctx->eliza_turbo3_tcq_codebook == nullptr) {
        ctx->eliza_turbo3_tcq_codebook = ggml_vk_create_buffer_device(ctx->device, sizeof(k_eliza_tbq3_tcq_codebook));
        ggml_vk_buffer_write(ctx->eliza_turbo3_tcq_codebook, 0, k_eliza_tbq3_tcq_codebook, sizeof(k_eliza_tbq3_tcq_codebook));
    }
    return ctx->eliza_turbo3_tcq_codebook;
}

static void ggml_vk_eliza_attn_score_qjl(ggml_backend_vk_context * ctx, vk_context& subctx, ggml_tensor * dst) {
    const ggml_tensor * q  = dst->src[0];
    const ggml_tensor * pk = dst->src[1];
    GGML_ASSERT(q != nullptr && pk != nullptr);
    GGML_ASSERT(q->type == GGML_TYPE_F32);
    GGML_ASSERT(pk->type == GGML_TYPE_QJL1_256);
    GGML_ASSERT(dst->type == GGML_TYPE_F32);
    GGML_ASSERT(q->ne[0] == 256 && pk->ne[0] == 128);
    GGML_ASSERT(q->ne[2] == 1 && q->ne[3] == 1 && pk->ne[3] == 1 && dst->ne[2] == 1 && dst->ne[3] == 1);
    GGML_ASSERT(ggml_is_contiguous_rows(q));
    GGML_ASSERT(ggml_is_contiguous_rows(pk));
    GGML_ASSERT(ggml_is_contiguous_rows(dst));

    const uint32_t n_heads    = (uint32_t) q->ne[1];
    const uint32_t n_kv_heads = (uint32_t) ((const int32_t *) dst->op_params)[0];
    const uint32_t n_tokens   = (uint32_t) pk->ne[1];
    GGML_ASSERT(n_kv_heads > 0 && (n_heads % n_kv_heads) == 0);
    GGML_ASSERT(pk->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(dst->ne[0] == (int64_t) n_tokens && dst->ne[1] == (int64_t) n_heads);
    GGML_ASSERT(pk->nb[1] == ggml_row_size(GGML_TYPE_QJL1_256, 128));
    GGML_ASSERT(pk->nb[2] == (size_t) n_tokens * pk->nb[1]);

    const bool multi = (int64_t) n_tokens >= ELIZA_VK_QJL_MULTIBLOCK_THRESHOLD;
    const uint32_t qjl_fold = ctx->device->eliza_vk_qjl_multiblock_factor;
    vk_pipeline pipeline = multi ? ctx->device->pipeline_eliza_qjl_multi
                                 : ctx->device->pipeline_eliza_qjl;
    const uint32_t grid_y = multi ? (n_tokens + qjl_fold - 1u) / qjl_fold : n_tokens;
    ggml_pipeline_request_descriptor_sets(ctx, pipeline, 1);
    const eliza_vk_qjl_score_push pc = { n_heads, n_kv_heads, n_tokens, 256u };
    ggml_vk_dispatch_pipeline(
        ctx, subctx, pipeline,
        { ggml_vk_tensor_subbuffer(ctx, q), ggml_vk_tensor_subbuffer(ctx, pk), ggml_vk_tensor_subbuffer(ctx, dst) },
        pc, { n_heads, grid_y, 1 });
}

static void ggml_vk_eliza_attn_score_tbq(ggml_backend_vk_context * ctx, vk_context& subctx, ggml_tensor * dst) {
    const ggml_tensor * q  = dst->src[0];
    const ggml_tensor * pk = dst->src[1];
    GGML_ASSERT(q != nullptr && pk != nullptr);
    GGML_ASSERT(q->type == GGML_TYPE_F32);
    GGML_ASSERT(pk->type == GGML_TYPE_TBQ3_0 || pk->type == GGML_TYPE_TBQ4_0 || pk->type == GGML_TYPE_TBQ3_TCQ);
    GGML_ASSERT(dst->type == GGML_TYPE_F32);
    GGML_ASSERT(q->ne[0] == 128 && pk->ne[0] == 128);
    GGML_ASSERT(q->ne[2] == 1 && q->ne[3] == 1 && pk->ne[3] == 1 && dst->ne[2] == 1 && dst->ne[3] == 1);
    GGML_ASSERT(ggml_is_contiguous_rows(q));
    GGML_ASSERT(ggml_is_contiguous_rows(pk));
    GGML_ASSERT(ggml_is_contiguous_rows(dst));

    const uint32_t n_heads    = (uint32_t) q->ne[1];
    const uint32_t n_kv_heads = (uint32_t) ((const int32_t *) dst->op_params)[0];
    const uint32_t n_tokens   = (uint32_t) pk->ne[1];
    const uint32_t gqa        = n_heads / n_kv_heads;
    const uint32_t blocks_per_kv = (uint32_t) (pk->ne[0] / ggml_blck_size(pk->type));
    GGML_ASSERT(n_kv_heads > 0 && (n_heads % n_kv_heads) == 0);
    GGML_ASSERT(pk->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(dst->ne[0] == (int64_t) n_tokens && dst->ne[1] == (int64_t) n_heads);
    GGML_ASSERT(pk->nb[1] == ggml_row_size(pk->type, 128));
    GGML_ASSERT(pk->nb[2] == (size_t) n_tokens * pk->nb[1]);

    const bool multi = (int64_t) n_tokens >= ELIZA_VK_TBQ_MULTIBLOCK_THRESHOLD;
    const uint32_t tbq_fold = ctx->device->eliza_vk_tbq_multiblock_factor;
    vk_pipeline pipeline = multi ? eliza_vk_pipeline_for_tbq_multi(ctx, pk->type)
                                 : eliza_vk_pipeline_for_tbq(ctx, pk->type);
    const uint32_t grid_x = multi ? (n_tokens + tbq_fold - 1u) / tbq_fold : n_tokens;
    const vk_subbuffer q_buf   = ggml_vk_tensor_subbuffer(ctx, q);
    const vk_subbuffer pk_buf  = ggml_vk_tensor_subbuffer(ctx, pk);
    const vk_subbuffer dst_buf = ggml_vk_tensor_subbuffer(ctx, dst);
    const bool is_tcq = pk->type == GGML_TYPE_TBQ3_TCQ;
    const vk_subbuffer codebook_buf = is_tcq ? ggml_vk_subbuffer(ctx, eliza_vk_turbo3_tcq_codebook(ctx)) : vk_subbuffer{};

    ggml_pipeline_request_descriptor_sets(ctx, pipeline, n_heads);
    for (uint32_t h = 0; h < n_heads; ++h) {
        const uint32_t h_k = h / gqa;
        const uint64_t head_offset = (uint64_t) h_k * (uint64_t) pk->nb[2];
        GGML_ASSERT(head_offset <= UINT32_MAX);
        const eliza_vk_tbq_score_push pc = {
            128u,
            n_tokens,
            blocks_per_kv,
            h,
            (uint32_t) head_offset,
        };
        if (is_tcq) {
            ggml_vk_dispatch_pipeline(ctx, subctx, pipeline, { q_buf, pk_buf, dst_buf, codebook_buf }, pc, { grid_x, 1, 1 });
        } else {
            ggml_vk_dispatch_pipeline(ctx, subctx, pipeline, { q_buf, pk_buf, dst_buf }, pc, { grid_x, 1, 1 });
        }
    }
}

static void ggml_vk_eliza_attn_score_polar(ggml_backend_vk_context * ctx, vk_context& subctx, ggml_tensor * dst) {
    const ggml_tensor * q  = dst->src[0];
    const ggml_tensor * pk = dst->src[1];
    GGML_ASSERT(q != nullptr && pk != nullptr);
    GGML_ASSERT(q->type == GGML_TYPE_F32);
    GGML_ASSERT(pk->type == GGML_TYPE_Q4_POLAR);
    GGML_ASSERT(dst->type == GGML_TYPE_F32);
    GGML_ASSERT(q->ne[0] == 128 && pk->ne[0] == 128);
    GGML_ASSERT(q->ne[2] == 1 && q->ne[3] == 1 && pk->ne[3] == 1 && dst->ne[2] == 1 && dst->ne[3] == 1);
    GGML_ASSERT(ggml_is_contiguous_rows(q));
    GGML_ASSERT(ggml_is_contiguous_rows(pk));
    GGML_ASSERT(ggml_is_contiguous_rows(dst));

    const int32_t * params = (const int32_t *) dst->op_params;
    const uint32_t n_heads    = (uint32_t) q->ne[1];
    const uint32_t n_kv_heads = (uint32_t) params[0];
    const uint32_t n_tokens   = (uint32_t) pk->ne[1];
    const uint32_t use_qjl    = (uint32_t) (params[1] != 0);
    const uint32_t gqa        = n_heads / n_kv_heads;
    GGML_ASSERT(n_kv_heads > 0 && (n_heads % n_kv_heads) == 0);
    GGML_ASSERT(pk->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(dst->ne[0] == (int64_t) n_tokens && dst->ne[1] == (int64_t) n_heads);
    GGML_ASSERT(pk->nb[1] == ggml_row_size(GGML_TYPE_Q4_POLAR, 128));
    GGML_ASSERT(pk->nb[2] == (size_t) n_tokens * pk->nb[1]);

    vk_pipeline pipeline = ctx->device->pipeline_eliza_polar;
    const vk_subbuffer pk_buf  = ggml_vk_tensor_subbuffer(ctx, pk);
    const vk_subbuffer q_buf   = ggml_vk_tensor_subbuffer(ctx, q);
    const vk_subbuffer dst_buf = ggml_vk_tensor_subbuffer(ctx, dst);

    ggml_pipeline_request_descriptor_sets(ctx, pipeline, n_heads);
    for (uint32_t h = 0; h < n_heads; ++h) {
        const uint32_t h_k = h / gqa;
        const uint64_t k_offset = (uint64_t) h_k * (uint64_t) pk->nb[2];
        const uint64_t q_offset = ((uint64_t) h * (uint64_t) q->nb[1]) / sizeof(float);
        const uint64_t y_offset = ((uint64_t) h * (uint64_t) dst->nb[1]) / sizeof(float);
        GGML_ASSERT(k_offset <= UINT32_MAX && q_offset <= UINT32_MAX && y_offset <= UINT32_MAX);
        const eliza_vk_polar_score_push pc = {
            n_tokens,
            128u,
            use_qjl,
            (uint32_t) k_offset,
            (uint32_t) q_offset,
            (uint32_t) y_offset,
        };
        ggml_vk_dispatch_pipeline(ctx, subctx, pipeline, { pk_buf, q_buf, dst_buf }, pc, { n_tokens, 1, 1 });
    }
}

// GGML_OP_FUSED_ATTN_QJL_TBQ — fused QJL-K score + TBQ3-V mix, online softmax,
// the per-token score vector never materialised. Mirrors the C reference
// eliza_fused_attn_qjl_tbq3() / fused_attn_qjl_tbq_ref() and the op contract
// reports/porting/2026-05-11/fused-attn-op-contract.md §3/§6:
//   src[0] = q          F32      [proj_dim=256, n_heads, n_q_pos, ne3]  (pre-projected QJL sketch)
//   src[1] = packed_k   QJL1_256 [head_dim=128, n_kv, n_kv_heads, ne3]  (nb[1] == 34)
//   src[2] = packed_v   TBQ3_0   [head_dim=128, n_kv, n_kv_heads, ne3]  (nb[1] == 56, 4 chunks/token)
//   dst    = out        F32      [head_dim=128, n_heads, n_q_pos, ne3]
//   op_params[0] = n_kv_heads, [1] = sm_scale (float bits), [2] = v_use_qjl (TBQ ignores it), [3] = kv_tile
// One workgroup per (q_head); q_pos is a push constant, so n_q_pos > 1 is a
// loop of dispatches (decode = 1). Conservative shape (ne3 == 1) matching the
// other eliza graph routes; the unfused score → softmax → V-mix path covers
// the wider shapes (AGENTS.md §3 — no silent degradation).
static void ggml_vk_eliza_fused_attn_qjl_tbq(ggml_backend_vk_context * ctx, vk_context& subctx, ggml_tensor * dst) {
    const ggml_tensor * q  = dst->src[0];
    const ggml_tensor * pk = dst->src[1];
    const ggml_tensor * pv = dst->src[2];
    GGML_ASSERT(q != nullptr && pk != nullptr && pv != nullptr);
    GGML_ASSERT(q->type == GGML_TYPE_F32);
    GGML_ASSERT(pk->type == GGML_TYPE_QJL1_256);
    GGML_ASSERT(pv->type == GGML_TYPE_TBQ3_0);
    GGML_ASSERT(dst->type == GGML_TYPE_F32);
    GGML_ASSERT(q->ne[0] == 256 && pk->ne[0] == 128 && pv->ne[0] == 128 && dst->ne[0] == 128);
    GGML_ASSERT(q->ne[3] == 1 && pk->ne[3] == 1 && pv->ne[3] == 1 && dst->ne[3] == 1);
    GGML_ASSERT(ggml_is_contiguous(q));
    GGML_ASSERT(ggml_is_contiguous(pk));
    GGML_ASSERT(ggml_is_contiguous(pv));
    GGML_ASSERT(ggml_is_contiguous(dst));

    const int32_t * params = (const int32_t *) dst->op_params;
    const uint32_t n_heads    = (uint32_t) q->ne[1];
    const uint32_t n_kv_heads = (uint32_t) params[0];
    const uint32_t sm_bits    = (uint32_t) params[1];
    const uint32_t kv_tile    = (uint32_t) params[3];
    const uint32_t n_tokens   = (uint32_t) pk->ne[1];
    const int64_t  n_q_pos    = q->ne[2];
    GGML_ASSERT(n_kv_heads > 0 && (n_heads % n_kv_heads) == 0);
    GGML_ASSERT(pk->ne[2] == (int64_t) n_kv_heads && pv->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(dst->ne[1] == (int64_t) n_heads && dst->ne[2] == n_q_pos);
    GGML_ASSERT(pk->nb[1] == ggml_row_size(GGML_TYPE_QJL1_256, 128));
    GGML_ASSERT(pv->nb[1] == ggml_row_size(GGML_TYPE_TBQ3_0, 128));
    GGML_ASSERT(pk->nb[2] == (size_t) n_tokens * pk->nb[1]);
    GGML_ASSERT(pv->nb[2] == (size_t) n_tokens * pv->nb[1]);

    vk_pipeline pipeline = ctx->device->pipeline_eliza_fused_attn_qjl_tbq;
    const vk_subbuffer q_buf   = ggml_vk_tensor_subbuffer(ctx, q);
    const vk_subbuffer pk_buf  = ggml_vk_tensor_subbuffer(ctx, pk);
    const vk_subbuffer pv_buf  = ggml_vk_tensor_subbuffer(ctx, pv);
    const vk_subbuffer dst_buf = ggml_vk_tensor_subbuffer(ctx, dst);

    ggml_pipeline_request_descriptor_sets(ctx, pipeline, (uint32_t) n_q_pos);
    for (int64_t p = 0; p < n_q_pos; ++p) {
        const eliza_vk_fused_attn_push pc = {
            n_heads, n_kv_heads, n_tokens, (uint32_t) p, sm_bits, kv_tile,
        };
        ggml_vk_dispatch_pipeline(ctx, subctx, pipeline, { q_buf, pk_buf, pv_buf, dst_buf }, pc, { n_heads, 1, 1 });
    }
}

`;
    patched = patched.replace(helperAnchor, helper + helperAnchor);

    const switchAnchor = `    case GGML_OP_FLASH_ATTN_EXT:
        ggml_vk_flash_attn(ctx, compute_ctx, src0, src1, src2, src3, node->src[4], node);

        break;`;
    if (!patched.includes(switchAnchor)) {
      throw new Error(
        `[vulkan-runtime-dispatch] graph switch anchor not found in ${vulkanPath}`,
      );
    }
    patched = patched.replace(
      switchAnchor,
      `    case GGML_OP_ATTN_SCORE_QJL:
        ggml_vk_eliza_attn_score_qjl(ctx, compute_ctx, node);

        break;
    case GGML_OP_ATTN_SCORE_TBQ:
        ggml_vk_eliza_attn_score_tbq(ctx, compute_ctx, node);

        break;
    case GGML_OP_ATTN_SCORE_POLAR:
        ggml_vk_eliza_attn_score_polar(ctx, compute_ctx, node);

        break;
    case GGML_OP_FUSED_ATTN_QJL_TBQ:
        ggml_vk_eliza_fused_attn_qjl_tbq(ctx, compute_ctx, node);

        break;

${switchAnchor}`,
    );

    const supportsAnchor = `        case GGML_OP_FLASH_ATTN_EXT:
            {`;
    if (!patched.includes(supportsAnchor)) {
      throw new Error(
        `[vulkan-runtime-dispatch] supports_op anchor not found in ${vulkanPath}`,
      );
    }
    const supports = `        case GGML_OP_ATTN_SCORE_QJL:
            return op->type == GGML_TYPE_F32 &&
                   op->src[0] != nullptr &&
                   op->src[1] != nullptr &&
                   op->src[0]->type == GGML_TYPE_F32 &&
                   op->src[1]->type == GGML_TYPE_QJL1_256 &&
                   op->src[0]->ne[0] == 256 &&
                   op->src[1]->ne[0] == 128 &&
                   op->src[0]->ne[2] == 1 &&
                   op->src[0]->ne[3] == 1 &&
                   op->src[1]->ne[3] == 1 &&
                   op->ne[2] == 1 &&
                   op->ne[3] == 1 &&
                   ggml_is_contiguous_rows(op) &&
                   ggml_is_contiguous_rows(op->src[0]) &&
                   ggml_is_contiguous_rows(op->src[1]);
        case GGML_OP_ATTN_SCORE_TBQ:
            return op->type == GGML_TYPE_F32 &&
                   op->src[0] != nullptr &&
                   op->src[1] != nullptr &&
                   op->src[0]->type == GGML_TYPE_F32 &&
                   (op->src[1]->type == GGML_TYPE_TBQ3_0 ||
                    op->src[1]->type == GGML_TYPE_TBQ4_0 ||
                    op->src[1]->type == GGML_TYPE_TBQ3_TCQ) &&
                   op->src[0]->ne[0] == 128 &&
                   op->src[1]->ne[0] == 128 &&
                   op->src[0]->ne[2] == 1 &&
                   op->src[0]->ne[3] == 1 &&
                   op->src[1]->ne[3] == 1 &&
                   op->ne[2] == 1 &&
                   op->ne[3] == 1 &&
                   ggml_is_contiguous_rows(op) &&
                   ggml_is_contiguous_rows(op->src[0]) &&
                   ggml_is_contiguous_rows(op->src[1]);
        case GGML_OP_ATTN_SCORE_POLAR:
            return op->type == GGML_TYPE_F32 &&
                   op->src[0] != nullptr &&
                   op->src[1] != nullptr &&
                   op->src[0]->type == GGML_TYPE_F32 &&
                   op->src[1]->type == GGML_TYPE_Q4_POLAR &&
                   op->src[0]->ne[0] == 128 &&
                   op->src[1]->ne[0] == 128 &&
                   op->src[0]->ne[2] == 1 &&
                   op->src[0]->ne[3] == 1 &&
                   op->src[1]->ne[3] == 1 &&
                   op->ne[2] == 1 &&
                   op->ne[3] == 1 &&
                   ggml_is_contiguous_rows(op) &&
                   ggml_is_contiguous_rows(op->src[0]) &&
                   ggml_is_contiguous_rows(op->src[1]);
        case GGML_OP_FUSED_ATTN_QJL_TBQ:
            return op->type == GGML_TYPE_F32 &&
                   op->src[0] != nullptr &&
                   op->src[1] != nullptr &&
                   op->src[2] != nullptr &&
                   op->src[0]->type == GGML_TYPE_F32 &&
                   op->src[1]->type == GGML_TYPE_QJL1_256 &&
                   op->src[2]->type == GGML_TYPE_TBQ3_0 &&
                   op->src[0]->ne[0] == 256 &&
                   op->src[1]->ne[0] == 128 &&
                   op->src[2]->ne[0] == 128 &&
                   op->ne[0] == 128 &&
                   op->src[0]->ne[3] == 1 &&
                   op->src[1]->ne[3] == 1 &&
                   op->src[2]->ne[3] == 1 &&
                   op->ne[3] == 1 &&
                   ggml_is_contiguous(op) &&
                   ggml_is_contiguous(op->src[0]) &&
                   ggml_is_contiguous(op->src[1]) &&
                   ggml_is_contiguous(op->src[2]);

`;
    patched = patched.replace(supportsAnchor, supports + supportsAnchor);
  }

  if (patched !== original && !dryRun) {
    fs.writeFileSync(vulkanPath, patched, "utf8");
  }
  return {
    ggmlOps,
    path: vulkanPath,
    changed: patched !== original && !dryRun,
    sentinel: RUNTIME_SENTINEL,
  };
}

// Public entry point used by build-llama-cpp-dflash.mjs.
export function patchVulkanKernels(cacheDir, { dryRun = false, target = null } = {}) {
  if (!cacheDir || !fs.existsSync(cacheDir)) {
    throw new Error(`[vulkan-kernels] cacheDir does not exist: ${cacheDir}`);
  }
  assertStandalonesPresent();
  const copied = copyStandalonesIntoFork(cacheDir, { dryRun });
  const patchResults = applyPatches(cacheDir, { dryRun });
  const prehtRegistration = repairPolarPrehtShaderRegistration(cacheDir, {
    dryRun,
  });
  const prehtPipeline = repairPolarPrehtPipeline(cacheDir, { dryRun });
  const runtimeDispatch = patchVulkanRuntimeDispatch(cacheDir, { dryRun });
  console.log(
    `[vulkan-kernels] ${dryRun ? "(dry-run) " : ""}target=${target ?? "unknown"} staged ${copied.length} standalone Vulkan shaders into vulkan-shaders/ ` +
      `and applied ${patchResults.length} shader/pipeline patches plus runtime graph dispatch:`,
  );
  for (const r of patchResults) {
    console.log(
      `[vulkan-kernels]   ${r.file} → ${r.target}: ${r.applied} hunk(s) applied, ${r.skipped} idempotent-skipped`,
    );
  }
  console.log(
    `[vulkan-kernels] runtime graph dispatch patch: ${runtimeDispatch.changed ? "patched" : "already-present/dry-run"} (${runtimeDispatch.path})`,
  );
  console.log(
    `[vulkan-kernels] polar_preht registration repair: ${prehtRegistration.wouldChange ? (dryRun ? "would-patch" : "patched") : "already-present"} (${prehtRegistration.target})`,
  );
  console.log(
    `[vulkan-kernels] polar_preht pipeline repair: ${prehtPipeline.wouldChange ? (dryRun ? "would-patch" : "patched") : "already-present"} (${prehtPipeline.target})`,
  );
  // AGENTS.md §3 enforcement (no eliza-missing vulkan binary) is done at
  // build-llama-cpp-dflash.mjs post-build via the requiredKernels audit.
  console.log(
    `[vulkan-kernels] runtime-ready evidence still requires ` +
      `make -C packages/inference/verify vulkan-dispatch-smoke on a native Vulkan build.`,
  );
  return {
    copied,
    patchResults,
    prehtRegistration,
    prehtPipeline,
    runtimeDispatch,
    runtimeReady: "source-patched-pending-smoke",
    requiredGraphSmoke: "make -C packages/inference/verify vulkan-dispatch-smoke",
  };
}
