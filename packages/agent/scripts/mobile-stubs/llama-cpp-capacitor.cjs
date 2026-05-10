// llama-cpp-capacitor stub for the mobile agent bundle.
//
// llama-cpp-capacitor is the WebView-side Capacitor JNI binding for iOS and
// the Capacitor Android variant of the local inference plugin. The bun
// agent process running on AOSP does NOT use it — on Android the runtime
// goes through `bun:ffi` against `libllama.so` + `libeliza-llama-shim.so`
// directly via `aosp-llama-adapter.ts`. The only consumer of this package
// is `packages/native-plugins/llama/src/capacitor-llama-adapter.ts`, which
// dynamically imports it inside the WebView path. Bun.build still has to
// resolve the import statically; the stub keeps the bundle building while
// guaranteeing the WebView path throws clearly if it's ever hit on AOSP.
"use strict";

const NOT_AVAILABLE_MSG =
  "llama-cpp-capacitor is not available on the bun-side AOSP agent — local inference goes through bun:ffi + libllama.so via aosp-llama-adapter.ts";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

module.exports = {
  __mobileStub: true,
  LlamaCpp: new Proxy(
    {},
    {
      get() {
        return unavailable;
      },
    },
  ),
};
