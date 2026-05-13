import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { patchDflashDrafterArch } from "./dflash-drafter-arch.mjs";

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function makeLlamaCppFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dflash-arch-patch-"));
  write(
    root,
    "src/CMakeLists.txt",
    "set(LLAMA_MODELS\n            models/dream.cpp\n)\n",
  );
  write(
    root,
    "src/llama-arch.h",
    [
      "enum llm_arch {",
      "    LLM_ARCH_QWEN35MOE,",
      "};",
      "enum llm_kv {",
      "    LLM_KV_WKV_HEAD_SIZE,",
      "};",
      "enum llm_tensor {",
      "    LLM_TENSOR_NEXTN_SHARED_HEAD_NORM,",
      "};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/llama-arch.cpp",
    [
      '    { LLM_ARCH_QWEN35MOE,        "qwen35moe"        },',
      '    { LLM_KV_WKV_HEAD_SIZE, "%s.wkv.head_size" },',
      '    { LLM_TENSOR_OUTPUT,                                 "output" },',
      "    {LLM_TENSOR_OUTPUT_NORM_LFM2,           {LLM_TENSOR_LAYER_OUTPUT,    GGML_OP_MUL}},",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/llama-hparams.h",
    "struct llama_hparams {\n    uint32_t n_embd_head_kda = 0;\n};\n",
  );
  write(
    root,
    "src/llama-model.h",
    "struct llama_model {\n    struct ggml_tensor * cls_norm  = nullptr;\n};\n",
  );
  write(
    root,
    "src/models/models.h",
    [
      "struct llm_build_qwen3moe : public llm_graph_context {",
      "    llm_build_qwen3moe(const llama_model & model, const llm_graph_params & params);",
      "};",
      "struct llama_model_mistral3 : public llama_model_base {",
      "};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/llama-model.cpp",
    [
      "llama_model * llama_model_new(llm_arch arch, const llama_model_params & params) {",
      "    switch (arch) {",
      "        case LLM_ARCH_QWEN35:",
      "            return new llama_model_qwen35(params);",
      "        case LLM_ARCH_MISTRAL3:",
      "            return new llama_model_mistral3(params);",
      "    }",
      "}",
      "void llama_model::load_tensors() {",
      "    switch (arch) {",
      "        case LLM_ARCH_QWEN3NEXT:",
      "        case LLM_ARCH_MIMO2:",
      "        case LLM_ARCH_STEP35:",
      "            break;",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

test("patchDflashDrafterArch registers the dflash-draft model loader", () => {
  const root = makeLlamaCppFixture();

  patchDflashDrafterArch(root);

  assert.match(
    fs.readFileSync(path.join(root, "src/llama-arch.cpp"), "utf8"),
    /"dflash-draft"/,
  );
  assert.match(
    fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8"),
    /new llama_model_dflash_draft/,
  );
  assert.ok(fs.existsSync(path.join(root, "src/models/dflash_draft.cpp")));

  const before = fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8");
  patchDflashDrafterArch(root);
  assert.equal(
    fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8"),
    before,
  );
});
