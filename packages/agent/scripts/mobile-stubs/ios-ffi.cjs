// ios-ffi stub for the iOS Bun-port agent bundle.
//
// App Store iOS builds do not expose Bun FFI. Native integrations must be
// linked into the signed app and called through Swift/C bridge APIs. This
// JS-side stub exposes enough of the desktop Bun `bun:ffi` shape that bundled
// modules can load, but all executable/native binding paths fail closed:
//
//   - `cc()` (the TinyCC C-compiler shim) throws — TinyCC is excluded from
//     the iOS Bun build (see milestones/M05).
//   - `dlopen(...)` always throws.
//   - `cc(...)` always throws; TinyCC is excluded.
//   - `read.<type>`, `FFIType`, and `suffix` exist only for import-time
//     compatibility.
"use strict";

const NOT_AVAILABLE_MSG =
  "bun:ffi.cc is not available on iOS — TinyCC is excluded from the iOS Bun build. " +
  "Pre-compile any FFI C code and ship it as a statically-linked library.";

const DLOPEN_MSG =
  "bun:ffi.dlopen is not available in iOS App Store builds. " +
  "Use a signed Swift/C bridge instead of loading native code from JavaScript.";

function dlopen(path, _symbols) {
  throw new Error(`${DLOPEN_MSG} Requested target: ${String(path)}`);
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
