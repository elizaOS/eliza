// onnxruntime-node stub for the mobile agent bundle.
//
// onnxruntime-node has no Android prebuild. Mobile uses cloud / capacitor
// inference instead.
"use strict";

const NOT_AVAILABLE_MSG =
  "onnxruntime-node is not available on Android — use cloud or on-device JNI inference instead";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

class InferenceSession {
  static create() {
    return unavailable();
  }
}

class Tensor {
  constructor() {
    unavailable();
  }
}

module.exports = {
  __mobileStub: true,
  InferenceSession,
  Tensor,
  env: { wasm: { numThreads: 1 } },
  default: { InferenceSession, Tensor },
};
