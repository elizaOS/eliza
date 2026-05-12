// Generic throw-on-use stub for Node built-ins not supported by the iOS
// JSContext runtime via __MILADY_BRIDGE__ v1.
//
// Currently used for: node:net, node:tls, node:dgram, node:cluster,
// worker_threads. The Swift Capacitor plugin in
// packages/native-plugins/bun-runtime/ exposes a fetch-based HTTP/HTTPS
// surface plus a WebSocket bridge, but raw TCP servers, TLS sockets,
// UDP datagrams, cluster fork, and worker threads are not in the v1
// bridge surface. Code that reaches into these modules on ios-jsc gets
// a loud, actionable error rather than a silent no-op.
"use strict";

const NOT_SUPPORTED =
  "This Node module is not available in the iOS JSContext runtime (ios-jsc). " +
  "Use fetch() / WebSocket via __MILADY_BRIDGE__ instead, or gate the call " +
  "behind a process.env.ELIZA_RUNTIME !== 'ios-jsc' check.";

function throwUnsupported() {
  throw new Error(NOT_SUPPORTED);
}

const handler = {
  get(_target, prop) {
    if (prop === "__iosJscStub") return true;
    if (prop === "default") return module.exports;
    if (prop === "__esModule") return true;
    return throwUnsupported;
  },
  apply: throwUnsupported,
  construct: throwUnsupported,
};

module.exports = new Proxy(function () {}, handler);
