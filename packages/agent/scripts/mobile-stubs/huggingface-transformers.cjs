// @huggingface/transformers stub for the mobile agent bundle.
"use strict";

const NOT_AVAILABLE_MSG =
  "@huggingface/transformers is not available in the Android mobile bundle";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

module.exports = {
  __mobileStub: true,
  pipeline: unavailable,
  AutoTokenizer: { from_pretrained: unavailable },
  AutoModel: { from_pretrained: unavailable },
  AutoModelForCausalLM: { from_pretrained: unavailable },
  AutoProcessor: { from_pretrained: unavailable },
  env: {
    allowLocalModels: false,
    allowRemoteModels: false,
    cacheDir: "",
    backends: { onnx: {} },
  },
};
