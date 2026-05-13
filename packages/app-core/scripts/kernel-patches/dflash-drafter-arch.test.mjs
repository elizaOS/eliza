import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
      "struct llm_build_qwen35moe : public llm_graph_context {",
      "    llm_build_qwen35moe(const llama_model & model, const llm_graph_params & params);",
      "};",
      "struct llm_build_mistral3 : public llm_graph_context {",
      "    llm_build_mistral3(const llama_model & model, const llm_graph_params & params);",
      "};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/llama-model.cpp",
    [
      "void llama_model::load_hparams() {",
      "    switch (arch) {",
      "        case LLM_ARCH_MAINCODER:",
      "            break;",
      "    }",
      "}",
      "void llama_model::load_tensors() {",
      "    switch (arch) {",
      "            case LLM_ARCH_QWEN3MOE:",
      "            case LLM_ARCH_QWEN3VLMOE:",
      "                break;",
      "    }",
      "}",
      "void llama_model::build_graph() {",
      "    switch (arch) {",
      "        case LLM_ARCH_QWEN35MOE:",
      "            {",
      "                llm = std::make_unique<llm_build_qwen35moe>(*this, params);",
      "            } break;",
      "        case LLM_ARCH_MISTRAL3:",
      "            {",
      "                llm = std::make_unique<llm_build_mistral3>(*this, params);",
      "            } break;",
      "    }",
      "}",
      "void llama_model::mark_recurrent() {",
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

describe("patchDflashDrafterArch", () => {
  it("registers the dflash-draft model loader", () => {
    const root = makeLlamaCppFixture();

    patchDflashDrafterArch(root);

    expect(
      fs.readFileSync(path.join(root, "src/llama-arch.cpp"), "utf8"),
    ).toMatch(/"dflash-draft"/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8"),
    ).toMatch(/std::make_unique<llm_build_dflash_draft>/);
    expect(
      fs.readFileSync(path.join(root, "src/models/dflash_draft.cpp"), "utf8"),
    ).not.toMatch(/llama_model_dflash_draft::/);
    expect(fs.existsSync(path.join(root, "src/models/dflash_draft.cpp"))).toBe(
      true,
    );

    const before = fs.readFileSync(
      path.join(root, "src/llama-model.cpp"),
      "utf8",
    );
    patchDflashDrafterArch(root);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8"),
    ).toBe(before);
  });
});
