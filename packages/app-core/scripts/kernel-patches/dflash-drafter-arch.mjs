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
const REPO_ROOT = path.resolve(REPO_PACKAGES_DIR, "..");
const DFLASH_DRAFT_SOURCE = path.join(
  REPO_ROOT,
  "plugins",
  "plugin-local-inference",
  "native",
  "dflash",
  "dflash_draft.cpp",
);
const DFLASH_DRAFT_MODEL_RELS = [
  "src/models/dflash-draft.cpp",
  "src/models/dflash_draft.cpp",
];

function dflashDraftModelRelForRoot(llamaCppRoot) {
  const cmake = path.join(llamaCppRoot, "src", "CMakeLists.txt");
  if (fs.existsSync(cmake)) {
    const source = fs.readFileSync(cmake, "utf8");
    for (const rel of DFLASH_DRAFT_MODEL_RELS) {
      if (source.includes(rel.slice("src/".length))) {
        return rel;
      }
    }
  }
  for (const rel of DFLASH_DRAFT_MODEL_RELS) {
    if (fs.existsSync(path.join(llamaCppRoot, rel))) {
      return rel;
    }
  }
  return "src/models/dflash_draft.cpp";
}

function usesModelSubclassApi(llamaCppRoot) {
  const candidates = [
    path.join(llamaCppRoot, "src", "models", "models.h"),
    path.join(llamaCppRoot, "src", "llama-model.h"),
  ];
  return candidates.some((file) => {
    if (!fs.existsSync(file)) return false;
    const source = fs.readFileSync(file, "utf8");
    return source.includes("llama_model_base");
  });
}

function hparamsMemberExpr(llamaCppRoot, member) {
  const header = path.join(llamaCppRoot, "src", "llama-hparams.h");
  if (fs.existsSync(header)) {
    const source = fs.readFileSync(header, "utf8");
    if (
      source.includes(` ${member};`) ||
      source.includes(` ${member} =`) ||
      source.includes(` ${member} //`)
    ) {
      return `hparams.${member}`;
    }
  }
  return `hparams.${member}()`;
}

function adaptDflashDraftSource(source, llamaCppRoot) {
  return source
    .replaceAll(
      "hparams.n_embd_head_v()",
      hparamsMemberExpr(llamaCppRoot, "n_embd_head_v"),
    )
    .replaceAll(
      "hparams.n_embd_head_k()",
      hparamsMemberExpr(llamaCppRoot, "n_embd_head_k"),
    );
}

function dflashDraftSourceForRoot(llamaCppRoot) {
  const source = adaptDflashDraftSource(
    fs.readFileSync(DFLASH_DRAFT_SOURCE, "utf8"),
    llamaCppRoot,
  );
  if (usesModelSubclassApi(llamaCppRoot)) {
    return source;
  }
  const start = source.indexOf(
    "void llama_model_dflash_draft::load_arch_hparams",
  );
  const end = source.indexOf("class llm_graph_input_dflash");
  if (start === -1 || end === -1 || end <= start) {
    return source;
  }
  return `${source.slice(0, start)}${source.slice(end)}`;
}

function loaderMetadataExpr(llamaCppRoot) {
  const header = path.join(llamaCppRoot, "src", "llama-model-loader.h");
  if (fs.existsSync(header)) {
    const source = fs.readFileSync(header, "utf8");
    if (source.includes("gguf_context_ptr meta;")) {
      return "ml.meta.get()";
    }
  }
  return "ml.metadata";
}

function requireIncludes(source, needle, rel) {
  if (!source.includes(needle)) {
    throw new Error(
      `[dflash-build] dflash-drafter-arch: anchor not found in ${rel}: ${needle}`,
    );
  }
}

function insertAfter(
  source,
  anchor,
  insertion,
  rel,
  present = insertion.trim(),
) {
  if (source.includes(present)) return source;
  requireIncludes(source, anchor, rel);
  return source.replace(anchor, `${anchor}${insertion}`);
}

function insertBefore(
  source,
  anchor,
  insertion,
  rel,
  present = insertion.trim(),
) {
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

function patchCmake(source, rel, modelRel) {
  const cmakeModelPath = modelRel.slice("src/".length);
  if (
    source.includes('file(GLOB LLAMA_MODELS_SOURCES "models/*.cpp")') ||
    DFLASH_DRAFT_MODEL_RELS.some((candidate) =>
      source.includes(candidate.slice("src/".length)),
    )
  ) {
    return source;
  }
  return insertAfter(
    source,
    "            models/dream.cpp\n",
    `            ${cmakeModelPath}\n`,
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
  if (
    source.includes("struct llm_build_dflash_draft") &&
    (!source.includes(
      "struct llama_model_mistral3 : public llama_model_base",
    ) ||
      source.includes("struct llama_model_dflash_draft"))
  ) {
    return source;
  }
  let out = source;
  if (!out.includes("struct llm_build_dflash_draft")) {
    out = insertAfter(
      out,
      "struct llm_build_qwen3moe : public llm_graph_context {\n    llm_build_qwen3moe(const llama_model & model, const llm_graph_params & params);\n};\n",
      `
struct llm_build_dflash_draft : public llm_graph_context {
    llm_build_dflash_draft(const llama_model & model, const llm_graph_params & params);
};
`,
      rel,
    );
  }
  if (out.includes("struct llama_model_mistral3 : public llama_model_base {")) {
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
  }
  return out;
}

function patchModelCpp(source, rel, metadataExpr = "ml.metadata") {
  let out = source.replaceAll("ml.metadata", metadataExpr);
  if (out.includes("return new llama_model_dflash_draft(params);")) {
    return out;
  }
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
                const int kid = gguf_find_key(${metadataExpr}, key.c_str());
                if (kid >= 0 && gguf_get_kv_type(${metadataExpr}, kid) == GGUF_TYPE_ARRAY) {
                    const enum gguf_type arr_type = gguf_get_arr_type(${metadataExpr}, kid);
                    const size_t n = gguf_get_arr_n(${metadataExpr}, kid);
                    hparams.dflash_n_target_layers = std::min((uint32_t) n, (uint32_t) 8);
                    const void * data = gguf_get_arr_data(${metadataExpr}, kid);
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

function verifyDflashDrafterArchPatch(llamaCppRoot, modelRel) {
  const requiredMarkers = [
    ["src/llama-arch.h", "LLM_ARCH_DFLASH_DRAFT"],
    ["src/llama-arch.cpp", '"dflash-draft"'],
    ["src/llama-hparams.h", "dflash_n_target_features"],
    ["src/llama-model.h", "dflash_hidden_norm"],
    ["src/models/models.h", "llm_build_dflash_draft"],
    [modelRel, "llm_build_dflash_draft::llm_build_dflash_draft"],
  ];
  const missing = [];
  const cmakePath = path.join(llamaCppRoot, "src", "CMakeLists.txt");
  const cmakeSource = fs.existsSync(cmakePath)
    ? fs.readFileSync(cmakePath, "utf8")
    : "";
  if (
    !cmakeSource.includes('file(GLOB LLAMA_MODELS_SOURCES "models/*.cpp")') &&
    !cmakeSource.includes(modelRel.slice("src/".length))
  ) {
    missing.push(
      `src/CMakeLists.txt (missing ${modelRel.slice("src/".length)})`,
    );
  }
  for (const [rel, marker] of requiredMarkers) {
    const file = path.join(llamaCppRoot, rel);
    if (!fs.existsSync(file)) {
      missing.push(`${rel} (missing file)`);
      continue;
    }
    if (!fs.readFileSync(file, "utf8").includes(marker)) {
      missing.push(`${rel} (missing ${marker})`);
    }
  }
  const modelSources = [
    path.join(llamaCppRoot, "src/models/dflash_draft.cpp"),
    path.join(llamaCppRoot, "src/models/dflash-draft.cpp"),
  ];
  if (
    !modelSources.some(
      (file) =>
        fs.existsSync(file) &&
        fs
          .readFileSync(file, "utf8")
          .includes("llm_build_dflash_draft::llm_build_dflash_draft"),
    )
  ) {
    missing.push(
      "src/models/dflash[-_]draft.cpp (missing dflash graph builder)",
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `[dflash-build] dflash-drafter-arch: patch verification failed: ${missing.join(", ")}`,
    );
  }
  const modelCpp = fs.readFileSync(
    path.join(llamaCppRoot, "src", "llama-model.cpp"),
    "utf8",
  );
  if (
    !modelCpp.includes("new llama_model_dflash_draft") &&
    !modelCpp.includes("std::make_unique<llm_build_dflash_draft>")
  ) {
    throw new Error(
      `[dflash-build] dflash-drafter-arch: patch verification failed: src/llama-model.cpp (missing dflash-draft model wiring)`,
    );
  }
}

export function patchDflashDrafterArch(llamaCppRoot, { dryRun = false } = {}) {
  const touched = [];
  const modelRel = dflashDraftModelRelForRoot(llamaCppRoot);
  const dest = path.join(llamaCppRoot, modelRel);
  if (!fs.existsSync(DFLASH_DRAFT_SOURCE)) {
    throw new Error(
      `[dflash-build] dflash-drafter-arch: missing source ${DFLASH_DRAFT_SOURCE}`,
    );
  }
  const source = dflashDraftSourceForRoot(llamaCppRoot);
  if (!fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== source) {
    if (!dryRun) fs.writeFileSync(dest, source, "utf8");
    touched.push(modelRel);
  }
  for (const rel of DFLASH_DRAFT_MODEL_RELS) {
    if (rel === modelRel) continue;
    const alternate = path.join(llamaCppRoot, rel);
    if (
      fs.existsSync(alternate) &&
      fs.readFileSync(alternate, "utf8") === source
    ) {
      if (!dryRun) fs.rmSync(alternate);
      touched.push(`${rel} (removed stale alternate)`);
    }
  }

  const transforms = [
    ["src/CMakeLists.txt", (source, rel) => patchCmake(source, rel, modelRel)],
    ["src/llama-arch.h", patchArchHeader],
    ["src/llama-arch.cpp", patchArchCpp],
    ["src/llama-hparams.h", patchHparams],
    ["src/llama-model.h", patchModelHeader],
    ["src/models/models.h", patchModelsHeader],
    [
      "src/llama-model.cpp",
      (source, rel) =>
        patchModelCpp(source, rel, loaderMetadataExpr(llamaCppRoot)),
    ],
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
  verifyDflashDrafterArchPatch(llamaCppRoot, modelRel);
  if (touched.length === 0) {
    console.log(
      "[dflash-build] dflash-draft architecture support already present",
    );
  } else {
    console.log(
      `[dflash-build] patched dflash-draft architecture support: ${touched.join(", ")}`,
    );
  }
}
