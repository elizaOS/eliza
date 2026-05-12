// Source patch for Eliza-1 DFlash drafter GGUFs.
//
// The v1.0.0-eliza llama.cpp pin carries the DFlash speculative CLI surface,
// but not the standalone `general.architecture=dflash-draft` model loader used
// by the Eliza-1 drafter GGUFs. The build script resets the llama.cpp
// submodule before every artifact build, so this patch must be applied as a
// first-class, idempotent build hook rather than kept as a dirty submodule edit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PACKAGES_DIR = path.resolve(__dirname, "..", "..", "..");
const DFLASH_DRAFT_SOURCE = path.join(
  REPO_PACKAGES_DIR,
  "inference",
  "dflash",
  "dflash_draft.cpp",
);

function requireIncludes(source, needle, rel) {
  if (!source.includes(needle)) {
    throw new Error(
      `[dflash-build] dflash-drafter-arch: anchor not found in ${rel}: ${needle}`,
    );
  }
}

function insertAfter(source, anchor, insertion, rel, present = insertion.trim()) {
  if (source.includes(present)) return source;
  requireIncludes(source, anchor, rel);
  return source.replace(anchor, `${anchor}${insertion}`);
}

function insertBefore(source, anchor, insertion, rel, present = insertion.trim()) {
  if (source.includes(present)) return source;
  requireIncludes(source, anchor, rel);
  return source.replace(anchor, `${insertion}${anchor}`);
}

function patchTextFile(llamaCppRoot, rel, transform, touched) {
  const full = path.join(llamaCppRoot, rel);
  const before = fs.readFileSync(full, "utf8");
  const after = transform(before, rel);
  if (after !== before) {
    fs.writeFileSync(full, after, "utf8");
    touched.push(rel);
  }
}

function patchCmake(source, rel) {
  return insertAfter(
    source,
    "            models/dream.cpp\n",
    "            models/dflash_draft.cpp\n",
    rel,
  );
}

function patchArchHeader(source, rel) {
  let out = source;
  out = insertAfter(
    out,
    "    LLM_ARCH_QWEN35MOE,\n",
    "    LLM_ARCH_DFLASH_DRAFT,\n",
    rel,
  );
  out = insertAfter(
    out,
    "    LLM_KV_WKV_HEAD_SIZE,\n",
    `
    LLM_KV_DFLASH_BLOCK_SIZE,
    LLM_KV_DFLASH_MASK_TOKEN_ID,
    LLM_KV_DFLASH_TARGET_LAYER_IDS,
    LLM_KV_DFLASH_N_TARGET_FEATURES,
`,
    rel,
  );
  out = insertAfter(
    out,
    "    LLM_TENSOR_NEXTN_SHARED_HEAD_NORM,\n",
    "    LLM_TENSOR_DFLASH_FC,\n    LLM_TENSOR_DFLASH_HIDDEN_NORM,\n",
    rel,
  );
  return out;
}

function patchArchCpp(source, rel) {
  let out = source;
  out = insertAfter(
    out,
    '    { LLM_ARCH_QWEN35MOE,        "qwen35moe"        },\n',
    '    { LLM_ARCH_DFLASH_DRAFT,     "dflash-draft"     },\n',
    rel,
  );
  out = insertAfter(
    out,
    '    { LLM_KV_WKV_HEAD_SIZE, "%s.wkv.head_size" },\n',
    `
    { LLM_KV_DFLASH_BLOCK_SIZE,        "%s.dflash.block_size"        },
    { LLM_KV_DFLASH_MASK_TOKEN_ID,     "%s.dflash.mask_token_id"     },
    { LLM_KV_DFLASH_TARGET_LAYER_IDS,  "%s.dflash.target_layer_ids"  },
    { LLM_KV_DFLASH_N_TARGET_FEATURES, "%s.dflash.n_target_features" },
`,
    rel,
  );
  out = insertAfter(
    out,
    '    { LLM_TENSOR_OUTPUT,                                 "output" },\n',
    '    { LLM_TENSOR_DFLASH_FC,                              "dflash_fc" },\n    { LLM_TENSOR_DFLASH_HIDDEN_NORM,                     "dflash_hidden_norm" },\n',
    rel,
  );
  // Older llama.cpp pins kept the per-architecture tensor set in
  // llama-arch.cpp as a switch returning `{ LLM_TENSOR_* }`. Newer pins moved
  // tensor construction into src/models/*.cpp; when the DFlash draft model is
  // already registered there, there is no Qwen35 tensor-set anchor to patch.
  if (!out.includes("LLM_ARCH_DFLASH_DRAFT")) {
    out = insertBefore(
      out,
      "        case LLM_ARCH_QWEN35:\n            return {\n",
      `        case LLM_ARCH_DFLASH_DRAFT:
            return {
                LLM_TENSOR_TOKEN_EMBD,
                LLM_TENSOR_OUTPUT_NORM,
                LLM_TENSOR_OUTPUT,
                LLM_TENSOR_DFLASH_FC,
                LLM_TENSOR_DFLASH_HIDDEN_NORM,
                LLM_TENSOR_ATTN_NORM,
                LLM_TENSOR_ATTN_POST_NORM,
                LLM_TENSOR_ATTN_Q,
                LLM_TENSOR_ATTN_Q_NORM,
                LLM_TENSOR_ATTN_K,
                LLM_TENSOR_ATTN_K_NORM,
                LLM_TENSOR_ATTN_V,
                LLM_TENSOR_ATTN_OUT,
                LLM_TENSOR_FFN_GATE,
                LLM_TENSOR_FFN_DOWN,
                LLM_TENSOR_FFN_UP,
            };
`,
      rel,
    );
  }
  if (!out.includes("{LLM_TENSOR_DFLASH_FC,")) {
    const dflashTensorInfo =
      "    {LLM_TENSOR_DFLASH_FC,                  {LLM_TENSOR_LAYER_INPUT,  GGML_OP_MUL_MAT}},\n" +
      "    {LLM_TENSOR_DFLASH_HIDDEN_NORM,         {LLM_TENSOR_LAYER_INPUT,  GGML_OP_MUL}},\n";
    const lfm2TensorInfoAnchors = [
      "    {LLM_TENSOR_OUTPUT_NORM_LFM2,           {LLM_TENSOR_LAYER_OUTPUT,    GGML_OP_MUL}},\n",
      "    {LLM_TENSOR_OUTPUT_NORM_LFM2,           {LLM_TENSOR_LAYER_OUTPUT, GGML_OP_MUL}},\n",
    ];
    const anchor = lfm2TensorInfoAnchors.find((candidate) =>
      out.includes(candidate),
    );
    if (!anchor) {
      throw new Error(
        `[dflash-build] dflash-drafter-arch: anchor not found in ${rel}: LLM_TENSOR_OUTPUT_NORM_LFM2 tensor info row`,
      );
    }
    out = out.replace(anchor, `${anchor}${dflashTensorInfo}`);
  }
  return out;
}

function patchHparams(source, rel) {
  return insertAfter(
    source,
    "    uint32_t n_embd_head_kda = 0;\n",
    `
    // for DFlash drafter
    uint32_t dflash_block_size        = 16;
    uint32_t dflash_mask_token_id     = 0;
    uint32_t dflash_n_target_features = 25600;
    uint32_t dflash_n_target_layers   = 0;
    uint32_t dflash_target_layer_ids[8] = {};
`,
    rel,
  );
}

function patchModelHeader(source, rel) {
  return insertAfter(
    source,
    "    struct ggml_tensor * cls_norm  = nullptr;\n",
    `
    // DFlash hidden-state fusion weights.
    struct ggml_tensor * dflash_fc          = nullptr;
    struct ggml_tensor * dflash_hidden_norm = nullptr;
`,
    rel,
  );
}

function patchModelsHeader(source, rel) {
  let out = insertAfter(
    source,
    "struct llm_build_qwen3moe : public llm_graph_context {\n    llm_build_qwen3moe(const llama_model & model, const llm_graph_params & params);\n};\n",
    `
struct llm_build_dflash_draft : public llm_graph_context {
    llm_build_dflash_draft(const llama_model & model, const llm_graph_params & params);
};
`,
    rel,
  );
  out = insertBefore(
    out,
    "struct llama_model_mistral3 : public llama_model_base {\n",
    `
struct llama_model_dflash_draft : public llama_model_base {
    llama_model_dflash_draft(const struct llama_model_params & params) : llama_model_base(params) {}
    void load_arch_hparams(llama_model_loader & ml) override;
    void load_arch_tensors(llama_model_loader & ml) override;
    std::unique_ptr<llm_graph_context> build_arch_graph(const llm_graph_params & params) const override;
};

`,
    rel,
  );
  return out;
}

function patchModelCpp(source, rel) {
  let out = source;
  if (out.includes("return new llama_model_qwen35(params);")) {
    out = insertBefore(
      out,
      "        case LLM_ARCH_MISTRAL3:\n",
      `        case LLM_ARCH_DFLASH_DRAFT:
            return new llama_model_dflash_draft(params);
`,
      rel,
      "new llama_model_dflash_draft",
    );
    out = insertAfter(
      out,
      "        case LLM_ARCH_QWEN3NEXT:\n        case LLM_ARCH_MIMO2:\n",
      "        case LLM_ARCH_DFLASH_DRAFT:\n",
      rel,
      "        case LLM_ARCH_DFLASH_DRAFT:\n        case LLM_ARCH_STEP35:\n",
    );
    return out;
  }
  out = insertBefore(
    out,
    "        case LLM_ARCH_MAINCODER:\n",
    `        case LLM_ARCH_DFLASH_DRAFT:
            {
                ml.get_key(LLM_KV_ATTENTION_LAYERNORM_RMS_EPS, hparams.f_norm_rms_eps);
                ml.get_key(LLM_KV_ATTENTION_CAUSAL,            hparams.causal_attn, false);
                ml.get_key(LLM_KV_DFLASH_BLOCK_SIZE,           hparams.dflash_block_size, false);
                ml.get_key(LLM_KV_DFLASH_MASK_TOKEN_ID,        hparams.dflash_mask_token_id, false);
                ml.get_key(LLM_KV_DFLASH_N_TARGET_FEATURES,    hparams.dflash_n_target_features, false);

                const std::string key = ml.llm_kv(LLM_KV_DFLASH_TARGET_LAYER_IDS);
                const int kid = gguf_find_key(ml.meta.get(), key.c_str());
                if (kid >= 0 && gguf_get_kv_type(ml.meta.get(), kid) == GGUF_TYPE_ARRAY) {
                    const enum gguf_type arr_type = gguf_get_arr_type(ml.meta.get(), kid);
                    const size_t n = gguf_get_arr_n(ml.meta.get(), kid);
                    hparams.dflash_n_target_layers = std::min((uint32_t) n, (uint32_t) 8);
                    const void * data = gguf_get_arr_data(ml.meta.get(), kid);
                    for (uint32_t i = 0; i < hparams.dflash_n_target_layers; ++i) {
                        if (arr_type == GGUF_TYPE_UINT32) {
                            hparams.dflash_target_layer_ids[i] = ((const uint32_t *) data)[i];
                        } else if (arr_type == GGUF_TYPE_INT32) {
                            hparams.dflash_target_layer_ids[i] = (uint32_t) ((const int32_t *) data)[i];
                        }
                    }
                }

                switch (hparams.n_layer) {
                    case 5: type = LLM_TYPE_0_6B; break;
                    default: type = LLM_TYPE_UNKNOWN;
                }
            } break;
`,
    rel,
    "ml.get_key(LLM_KV_DFLASH_BLOCK_SIZE",
  );
  out = insertBefore(
    out,
    "            case LLM_ARCH_QWEN3MOE:\n            case LLM_ARCH_QWEN3VLMOE:\n",
    `            case LLM_ARCH_DFLASH_DRAFT:
                {
                    // Shared from the target model at runtime. The DFlash GGUF does
                    // not carry standalone token or output embeddings.
                    tok_embd = create_tensor(tn(LLM_TENSOR_TOKEN_EMBD, "weight"), {n_embd, n_vocab}, TENSOR_NOT_REQUIRED);
                    output   = create_tensor(tn(LLM_TENSOR_OUTPUT,     "weight"), {n_embd, n_vocab}, TENSOR_NOT_REQUIRED);

                    output_norm = create_tensor(tn(LLM_TENSOR_OUTPUT_NORM, "weight"), {n_embd}, 0);

                    dflash_fc          = create_tensor(tn(LLM_TENSOR_DFLASH_FC,          "weight"), {(int64_t) hparams.dflash_n_target_features, n_embd}, 0);
                    dflash_hidden_norm = create_tensor(tn(LLM_TENSOR_DFLASH_HIDDEN_NORM, "weight"), {n_embd}, 0);

                    for (int i = 0; i < n_layer; ++i) {
                        auto & layer = layers[i];

                        layer.attn_norm      = create_tensor(tn(LLM_TENSOR_ATTN_NORM,      "weight", i), {n_embd}, 0);
                        layer.attn_post_norm = create_tensor(tn(LLM_TENSOR_ATTN_POST_NORM, "weight", i), {n_embd}, 0);

                        layer.wq = create_tensor(tn(LLM_TENSOR_ATTN_Q,   "weight", i), {n_embd, n_embd_head_k * n_head}, 0);
                        layer.wk = create_tensor(tn(LLM_TENSOR_ATTN_K,   "weight", i), {n_embd, n_embd_gqa}, 0);
                        layer.wv = create_tensor(tn(LLM_TENSOR_ATTN_V,   "weight", i), {n_embd, n_embd_v_gqa}, 0);
                        layer.wo = create_tensor(tn(LLM_TENSOR_ATTN_OUT, "weight", i), {n_embd_head_k * n_head, n_embd}, 0);

                        layer.attn_q_norm = create_tensor(tn(LLM_TENSOR_ATTN_Q_NORM, "weight", i), {n_embd_head_k}, 0);
                        layer.attn_k_norm = create_tensor(tn(LLM_TENSOR_ATTN_K_NORM, "weight", i), {n_embd_head_k}, 0);

                        layer.ffn_gate = create_tensor(tn(LLM_TENSOR_FFN_GATE, "weight", i), {n_embd,   n_ff}, 0);
                        layer.ffn_down = create_tensor(tn(LLM_TENSOR_FFN_DOWN, "weight", i), {  n_ff, n_embd}, 0);
                        layer.ffn_up   = create_tensor(tn(LLM_TENSOR_FFN_UP,   "weight", i), {n_embd,   n_ff}, 0);
                    }
                } break;
`,
    rel,
    "dflash_fc          = create_tensor",
  );
  out = insertBefore(
    out,
    `        case LLM_ARCH_QWEN35MOE:
            {
                llm = std::make_unique<llm_build_qwen35moe>(*this, params);
            } break;
        case LLM_ARCH_MISTRAL3:
`,
    `        case LLM_ARCH_DFLASH_DRAFT:
            {
                llm = std::make_unique<llm_build_dflash_draft>(*this, params);
            } break;
`,
    rel,
    "std::make_unique<llm_build_dflash_draft>",
  );
  out = insertAfter(
    out,
    "        case LLM_ARCH_QWEN3NEXT:\n        case LLM_ARCH_MIMO2:\n",
    "        case LLM_ARCH_DFLASH_DRAFT:\n",
    rel,
    "        case LLM_ARCH_DFLASH_DRAFT:\n        case LLM_ARCH_STEP35:\n",
  );
  return out;
}

export function patchDflashDrafterArch(llamaCppRoot, { dryRun = false } = {}) {
  const touched = [];
  const dest = path.join(llamaCppRoot, "src", "models", "dflash_draft.cpp");
  if (!fs.existsSync(DFLASH_DRAFT_SOURCE)) {
    throw new Error(
      `[dflash-build] dflash-drafter-arch: missing source ${DFLASH_DRAFT_SOURCE}`,
    );
  }
  const source = fs.readFileSync(DFLASH_DRAFT_SOURCE, "utf8");
  if (!fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== source) {
    if (!dryRun) fs.writeFileSync(dest, source, "utf8");
    touched.push("src/models/dflash_draft.cpp");
  }

  const transforms = [
    ["src/CMakeLists.txt", patchCmake],
    ["src/llama-arch.h", patchArchHeader],
    ["src/llama-arch.cpp", patchArchCpp],
    ["src/llama-hparams.h", patchHparams],
    ["src/llama-model.h", patchModelHeader],
    ["src/models/models.h", patchModelsHeader],
    ["src/llama-model.cpp", patchModelCpp],
  ];

  if (dryRun) {
    console.log(
      `[dflash-build] (dry-run) would patch llama.cpp with dflash-draft architecture support`,
    );
    return;
  }
  for (const [rel, transform] of transforms) {
    patchTextFile(llamaCppRoot, rel, transform, touched);
  }
  if (touched.length === 0) {
    console.log("[dflash-build] dflash-draft architecture support already present");
  } else {
    console.log(
      `[dflash-build] patched dflash-draft architecture support: ${touched.join(", ")}`,
    );
  }
}
