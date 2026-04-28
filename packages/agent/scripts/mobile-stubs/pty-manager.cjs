// pty-manager stub for the mobile agent bundle.
//
// The PTY-backed coding-agent orchestrator does not run on Android; the
// agent-orchestrator plugin is excluded from MOBILE_CORE_PLUGINS, so this
// stub only exists to satisfy bundle-time module resolution if any code
// path reaches it through a deep static import chain.
"use strict";

const NOT_AVAILABLE_MSG =
  "pty-manager is not available in the Android mobile bundle";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

module.exports = {
  __mobileStub: true,
  spawn: unavailable,
  PtyManager: class {
    constructor() {
      return unavailable();
    }
  },
};
