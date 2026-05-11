// pty-manager stub for the mobile agent bundle.
//
// AOSP builds can expose shell/coding/orchestrator actions, but the published
// pty-manager package depends on native node-pty prebuilds that do not ship for
// Android. Keep module initialization non-throwing so the orchestrator can load
// and report a structured runtime error instead of crashing during service
// startup. A real Android PTY backend should replace this stub when available.
"use strict";

const { EventEmitter } = require("node:events");

const NOT_AVAILABLE_MSG =
  "pty-manager is not available in the Android mobile bundle; install a real Android PTY backend or route coding agents to Cloud containers";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

class UnavailableBunCompatiblePTYManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  async spawn() {
    unavailable();
  }

  get(id) {
    return this.sessions.get(id);
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  async send() {
    unavailable();
  }

  async sendKeys() {
    unavailable();
  }

  async writeRaw() {
    unavailable();
  }

  async kill() {
    unavailable();
  }

  onSessionData(_id, _callback) {
    return () => {};
  }

  async *logs() {
    // Empty by design: no session can be spawned by this stub.
  }
}

module.exports = {
  __mobileStub: true,
  BunCompatiblePTYManager: UnavailableBunCompatiblePTYManager,
  PTYManager: UnavailableBunCompatiblePTYManager,
  ShellAdapter: class {},
  isBun: () => true,
  spawn: unavailable,
};
