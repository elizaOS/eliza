// node-llama-cpp stub for the mobile agent bundle.
//
// node-llama-cpp ships native prebuilds for x64/arm64-darwin/linux/win, none
// for Android bionic. The agent already gates every call site behind a
// dynamic import wrapped in try/catch (see embedding-manager.ts and
// services/local-inference/engine.ts). Returning a module that throws on
// every getter keeps that pattern honest: the bundle resolves, the runtime
// short-circuits, and nothing crashes import-side.
"use strict";

const NOT_AVAILABLE_MSG =
  "node-llama-cpp is not available on Android — local on-device inference must use the llama-cpp-capacitor JNI binding instead";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

const LlamaLogLevel = Object.freeze({
  disabled: "disabled",
  fatal: "fatal",
  error: "error",
  warn: "warn",
  info: "info",
  log: "log",
  debug: "debug",
});

module.exports = {
  __mobileStub: true,
  getLlama: unavailable,
  Llama: unavailable,
  LlamaModel: unavailable,
  LlamaContext: unavailable,
  LlamaEmbeddingContext: unavailable,
  LlamaChatSession: unavailable,
  LlamaJsonSchemaGrammar: unavailable,
  LlamaGrammar: unavailable,
  ChatHistoryItem: unavailable,
  Token: unavailable,
  resolveModelFile: unavailable,
  isLlamaText: () => false,
  LlamaLogLevel,
};
