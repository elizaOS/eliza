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
      "llm_arch llm_arch_from_string(const std::string & name) {",
      '    if (name == "qwen35moe") {',
      "        return LLM_ARCH_QWEN35MOE;",
      "    }",
      "    return LLM_ARCH_UNKNOWN;",
      "}",
      '    { LLM_KV_WKV_HEAD_SIZE, "%s.wkv.head_size" },',
      '    { LLM_TENSOR_OUTPUT,                                 "output" },',
      "    {LLM_TENSOR_OUTPUT_NORM_LFM2,           {LLM_TENSOR_LAYER_OUTPUT,    GGML_OP_MUL}},",
      "llm_arch llm_arch_from_string(const std::string & name) {",
      "    for (const auto & kv : LLM_ARCH_NAMES) {",
      "        if (kv.second == name) {",
      "            return kv.first;",
      "        }",
      "    }",
      "    return LLM_ARCH_UNKNOWN;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/llama-hparams.h",
    [
      "struct llama_hparams {",
      "    uint32_t n_embd_head_k;",
      "    uint32_t n_embd_head_v;",
      "    uint32_t n_embd_head_kda = 0;",
      "};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/llama-model.h",
    "struct llama_model {\n    struct ggml_tensor * cls_norm  = nullptr;\n};\n",
  );
  write(
    root,
    "src/llama-model-loader.h",
    "struct llama_model_loader {\n    gguf_context_ptr meta;\n};\n",
  );
  write(
    root,
    "src/llama-model-loader.cpp",
    [
      "    template<typename T>",
      "    bool llama_model_loader::get_key(enum llm_kv kid, T & result, bool required) {",
      "        return get_key(llm_kv(kid), result, required);",
      "}",
      "    template<typename T>",
      "    bool llama_model_loader::get_key_or_arr(enum llm_kv kid, T & result, uint32_t n, bool required) {",
      "        return get_key_or_arr(llm_kv(kid), result, n, required);",
      "}",
      "bool llama_model_loader::get_key_or_arr(enum llm_kv kid, uint32_t & result, bool required) {",
      "        const std::string key = llm_kv(kid);",
      "",
      "        const int id = gguf_find_key(metadata, key.c_str());",
      "",
      "        if (id < 0) {",
      "            if (required) {",
      '                throw std::runtime_error(format("key not found in model: %s", key.c_str()));',
      "            }",
      "            return false;",
      "        }",
      "",
      "        // throw and error if type is an array",
      "        if (gguf_get_kv_type(metadata, id) == GGUF_TYPE_ARRAY) {",
      "            if (required) {",
      '                throw std::runtime_error(format("expected scalar, found array for key: %s", key.c_str()));',
      "            }",
      "            return false;",
      "        }",
      "",
      "        return get_key(key, result, required);",
      "}",
      "const llama_model_loader::llama_tensor_weight * llama_model_loader::get_weight(const char * name) const {",
      "    auto pos = weights_map.find(name);",
      "    if (pos != weights_map.end()) {",
      "        return &pos->second;",
      "    }",
      "",
      "    return nullptr;",
      "}",
      "",
    ].join("\n"),
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
      fs.readFileSync(path.join(root, "src/llama-arch.cpp"), "utf8"),
    ).toMatch(/"dflash"/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-arch.cpp"), "utf8"),
    ).toMatch(/name == "dflash-draft"/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-arch.cpp"), "utf8"),
    ).toMatch(/LLM_TENSOR_DFLASH_FC,\s+"fc"/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-arch.cpp"), "utf8"),
    ).toMatch(/LLM_TENSOR_DFLASH_HIDDEN_NORM,\s+"hidden_norm"/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8"),
    ).toMatch(/std::make_unique<llm_build_dflash_draft>/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8"),
    ).toMatch(/ml\.meta\.get\(\)/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8"),
    ).not.toMatch(/ml\.metadata/);
    expect(
      fs.readFileSync(path.join(root, "src/models/dflash_draft.cpp"), "utf8"),
    ).not.toMatch(/llama_model_dflash_draft::/);
    expect(
      fs.readFileSync(path.join(root, "src/models/dflash_draft.cpp"), "utf8"),
    ).toMatch(/hparams\.n_embd_head_v;/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8"),
    ).toMatch(/dflash\.target_layer_ids/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model.cpp"), "utf8"),
    ).toMatch(/LLM_TENSOR_FFN_NORM/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model-loader.cpp"), "utf8"),
    ).toMatch(/get_key\(alt, result, false\)/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model-loader.cpp"), "utf8"),
    ).toMatch(/get_key_or_arr\(alt, result, n, false\)/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model-loader.cpp"), "utf8"),
    ).toMatch(/get_scalar\(alt, false\)/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model-loader.cpp"), "utf8"),
    ).toMatch(/name_str == "fc\.weight"/);
    expect(
      fs.readFileSync(path.join(root, "src/llama-model-loader.cpp"), "utf8"),
    ).toMatch(/post_attention_norm/);
    expect(
      fs.readFileSync(path.join(root, "src/models/dflash_draft.cpp"), "utf8"),
    ).not.toMatch(/hparams\.n_embd_head_v\(\)/);
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

  it("uses the hyphenated upstream dflash-draft filename when CMake references it", () => {
    const root = makeLlamaCppFixture();
    write(
      root,
      "src/CMakeLists.txt",
      "set(LLAMA_MODELS\n            models/dream.cpp\n            models/dflash-draft.cpp\n)\n",
    );

    patchDflashDrafterArch(root);

    expect(fs.existsSync(path.join(root, "src/models/dflash-draft.cpp"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, "src/models/dflash_draft.cpp"))).toBe(
      false,
    );
    const cmake = fs.readFileSync(
      path.join(root, "src/CMakeLists.txt"),
      "utf8",
    );
    expect(cmake).toContain("models/dflash-draft.cpp");
    expect(cmake).not.toContain("models/dflash_draft.cpp");
  });
});
