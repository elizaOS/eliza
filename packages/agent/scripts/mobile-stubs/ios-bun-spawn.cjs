// ios-bun-spawn stub for the iOS Bun-port agent bundle.
//
// `Bun.spawn` and `Bun.spawnSync` are inert on iOS for the same reason
// `child_process.spawn` is inert: the sandbox forbids it. The Bun fork for
// iOS removes the underlying syscall but still exposes the API surface so
// imports don't break — this stub provides the JS-side error semantics.
//
// References:
//   - native/ios-bun-port/PLATFORM_MATRIX.md
//   - native/ios-bun-port/milestones/M05-audit-syscalls.md
"use strict";

const NOT_AVAILABLE_MSG =
  "Bun.spawn is not available on iOS — the iOS sandbox forbids subprocess creation.";

function spawn(_argv, _opts) {
  throw new Error(NOT_AVAILABLE_MSG);
}

function spawnSync(_argv, _opts) {
  return {
    success: false,
    exitCode: 127,
    signalCode: null,
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(NOT_AVAILABLE_MSG),
    pid: -1,
    resourceUsage: null,
  };
}

module.exports = {
  __iosStub: true,
  spawn,
  spawnSync,
};
