// ios-ffi stub for the iOS Bun-port agent bundle.
//
// `bun:ffi` on iOS is locked down to statically-linked symbols only. The
// runtime allow-list (see native/ios-bun-port/stubs/ios-ffi-allowlist.zig)
// gates which symbols can be resolved. This JS-side stub exposes the same
// API surface as desktop Bun's `bun:ffi`, but:
//
//   - `cc()` (the TinyCC C-compiler shim) throws — TinyCC is excluded from
//     the iOS Bun build (see milestones/M05).
//   - `dlopen(path)` with an absolute path throws — only `dlopen(null)`
//     and `dlopen(<sandbox-allowed-system-framework>)` are accepted.
//   - `read.<type>`, `FFIType`, `suffix` and the rest are pass-through to
//     the underlying runtime implementation (which gates symbols).
//
// On real iOS Bun this stub is NOT loaded — the runtime exposes `bun:ffi`
// natively. This stub exists so the same agent JS bundle can run on
// desktop dev environments (where it would shadow `bun:ffi` and surface
// the iOS-only constraints early).
//
// References:
//   - native/ios-bun-port/PLATFORM_MATRIX.md
//   - native/ios-bun-port/stubs/ios-ffi-allowlist.zig
"use strict";

const NOT_AVAILABLE_MSG =
  "bun:ffi.cc is not available on iOS — TinyCC is excluded from the iOS Bun build. " +
  "Pre-compile any FFI C code and ship it as a statically-linked library.";

const ABSOLUTE_DLOPEN_MSG =
  "bun:ffi.dlopen of arbitrary disk paths is forbidden on iOS. " +
  "Pass null to dlopen for in-binary symbols, or a public iOS system framework path.";

function isAllowedDlopenTarget(path) {
  if (path === null || path === undefined) return true; // in-binary symbols
  if (typeof path !== "string") return false;
  // Allow loading from /System/Library/ (Apple system frameworks).
  if (path.startsWith("/System/Library/")) return true;
  // Allow loading from /usr/lib/system/ (Apple libSystem etc.).
  if (path.startsWith("/usr/lib/system/")) return true;
  return false;
}

function dlopen(path, _symbols) {
  if (!isAllowedDlopenTarget(path)) {
    throw new Error(ABSOLUTE_DLOPEN_MSG);
  }
  // Pass through to native runtime; in the simulator / desktop fallback
  // case, throw because we can't actually open arbitrary symbols.
  throw new Error(
    "bun:ffi.dlopen passthrough requires the native iOS Bun runtime. " +
      "This stub indicates the agent bundle is being run outside the iOS Bun port.",
  );
}

function cc(_options) {
  throw new Error(NOT_AVAILABLE_MSG);
}

const FFIType = {
  char: "char",
  int8_t: "int8_t",
  uint8_t: "uint8_t",
  int16_t: "int16_t",
  uint16_t: "uint16_t",
  int32_t: "int32_t",
  uint32_t: "uint32_t",
  int64_t: "int64_t",
  uint64_t: "uint64_t",
  float: "float",
  double: "double",
  bool: "bool",
  ptr: "ptr",
  cstring: "cstring",
  function: "function",
  void: "void",
};

module.exports = {
  __iosStub: true,
  dlopen,
  cc,
  FFIType,
  suffix: "a", // iOS uses static archives
  read: new Proxy({}, { get: () => () => 0 }),
  ptr: () => 0,
  toBuffer: () => new Uint8Array(),
  toArrayBuffer: () => new ArrayBuffer(0),
  CString: class CString extends String {},
  CFunction: () => () => {
    throw new Error(NOT_AVAILABLE_MSG);
  },
};
