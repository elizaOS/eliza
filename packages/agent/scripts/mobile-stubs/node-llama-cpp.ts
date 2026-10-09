// node-llama-cpp stub for the mobile agent bundle.
//
// The mobile agent does not load node-llama-cpp or its platform prebuilds.
// Android AOSP local inference goes through bun:ffi + libllama.so, while the
// Capacitor app path uses the WebView-side llama-cpp-capacitor binding.
"use strict";

const NOT_AVAILABLE_MSG =
  "node-llama-cpp is not available in mobile agent bundles";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

class LlamaModel {
  constructor() {
    unavailable();
  }
}

class LlamaContext {
  constructor() {
    unavailable();
  }
}

class LlamaChatSession {
  constructor() {
    unavailable();
  }
}

const capabilities = Object.freeze({
  provider: "node-llama-cpp",
  available: false,
  platform: "mobile-stub",
  reason: NOT_AVAILABLE_MSG,
});

module.exports = {
  __mobileStub: true,
  __mobileCapabilities: capabilities,
  capabilities,
  LlamaModel,
  LlamaContext,
  LlamaChatSession,
  getLlama: unavailable,
  getLlamaForOptions: unavailable,
  getLlamaForOptionsOrDownload: unavailable,
  default: {
    __mobileStub: true,
    __mobileCapabilities: capabilities,
    capabilities,
    LlamaModel,
    LlamaContext,
    LlamaChatSession,
    getLlama: unavailable,
    getLlamaForOptions: unavailable,
    getLlamaForOptionsOrDownload: unavailable,
  },
};
