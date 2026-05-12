// ios-child-process stub for the iOS Bun-port agent bundle.
//
// iOS sandbox forbids subprocess creation (posix_spawn / fork / exec are
// blocked at the kernel level). Any agent code that imports `node:child_process`
// or calls `Bun.spawn` will hit this stub on iOS builds.
//
// The stub does NOT throw at module load time — that would prevent the
// agent from booting if any transitive dep imports `node:child_process`
// (e.g., a logger that uses `child_process` for stack-tracing). Instead,
// each export throws with a useful message when actually called.
//
// Used by ios-target builds; see eliza/packages/agent/scripts/build-mobile-bundle.mjs
// --target=ios.
//
// References:
//   - native/ios-bun-port/PLATFORM_MATRIX.md
//   - native/ios-bun-port/milestones/M05-audit-syscalls.md
"use strict";

const { EventEmitter } = require("node:events");

const NOT_AVAILABLE_MSG =
  "child_process is not available on iOS — the iOS sandbox forbids subprocess creation. " +
  "Refactor to use in-process logic, a Capacitor native plugin, or an HTTP call to a remote service.";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

class UnavailableChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = -1;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    // Defer the throw to the next tick so callers that try to wire up
    // listeners on the returned object don't crash before they get the
    // chance. Emit 'error' instead of throwing synchronously to match
    // Node.js behavior for spawn errors.
    queueMicrotask(() => {
      this.emit("error", new Error(NOT_AVAILABLE_MSG));
      this.emit("exit", 127, null);
      this.emit("close", 127, null);
    });
  }

  kill() {
    return false;
  }
  ref() {}
  unref() {}
  disconnect() {}
  send() {
    return false;
  }
}

function spawn(_command, _args, _options) {
  return new UnavailableChildProcess();
}

function spawnSync() {
  return {
    pid: -1,
    output: [null, null, Buffer.from(NOT_AVAILABLE_MSG)],
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(NOT_AVAILABLE_MSG),
    status: 127,
    signal: null,
    error: new Error(NOT_AVAILABLE_MSG),
  };
}

function exec(_cmd, _opts, cb) {
  const child = new UnavailableChildProcess();
  if (typeof cb === "function") {
    queueMicrotask(() =>
      cb(new Error(NOT_AVAILABLE_MSG), "", NOT_AVAILABLE_MSG),
    );
  }
  return child;
}

function execSync() {
  unavailable();
}

function execFile(_file, _args, _opts, cb) {
  const child = new UnavailableChildProcess();
  if (typeof cb === "function") {
    queueMicrotask(() =>
      cb(new Error(NOT_AVAILABLE_MSG), "", NOT_AVAILABLE_MSG),
    );
  }
  return child;
}

function execFileSync() {
  unavailable();
}

function fork() {
  return new UnavailableChildProcess();
}

module.exports = {
  __iosStub: true,
  spawn,
  spawnSync,
  exec,
  execSync,
  execFile,
  execFileSync,
  fork,
  ChildProcess: UnavailableChildProcess,
};

// Named exports for ESM-style imports
module.exports.default = module.exports;
