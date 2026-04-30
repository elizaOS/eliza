// null-plugin.cjs — used by the mobile bundle for optional @elizaos plugins
// that pull in desktop-only transitive deps (plugin-cron drags in plugin-cli
// which pins old @elizaos/core, plugin-shell drags in PTY, plugin-pdf needs
// canvas, etc.).
//
// The agent runtime references these packages in three ways:
//
//   1. Top-level `require()` in try/catch — `if (pluginCron) { ... }` etc.
//      We can't `module.exports = null` because Bun's `__toESM(mod, 1)`
//      helper (used to wrap CJS for ESM `import * as X`) calls
//      `__getOwnPropNames(mod)` which throws on null.
//
//   2. ESM `import * as pluginX` and `import { foo } from "@elizaos/app-X"`.
//      Some named imports are *invoked* (e.g.
//      `wireCoordinatorBridgesWhenReady(state, ...)` in api/server.ts).
//      A bare `module.exports = {}` would leave those bindings as
//      `undefined` and crash the call.
//
// Solution: a Proxy-backed module where every property access returns a
// no-op function or another stub Proxy. This satisfies both shapes:
// `findRuntimePluginExport` still returns null (the proxy has no
// plugin-shaped fields), but any direct function call short-circuits to
// `undefined`.
"use strict";

const NOOP_FN = function noopStub() {
  return undefined;
};

// Use a plain object as the proxy target. Bun's `__toESM` calls
// `Object.getOwnPropertyNames(mod)` on the result of `require()` to
// build the ESM namespace; a function-target Proxy fails that check
// because functions have a non-configurable `prototype` that the
// `ownKeys` trap must include. Plain objects don't have that constraint.
function makeStubProxy() {
  const target = {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "default") return makeStubProxy();
      if (prop === "__esModule") return true;
      if (prop === "__mobileStub") return true;
      if (prop === "then") return undefined;
      if (prop === Symbol.iterator) return undefined;
      if (prop === Symbol.toPrimitive) return () => "";
      // Plugin-shaped fields the resolver reads. Returning undefined makes
      // `findRuntimePluginExport` fall through to "no valid Plugin export".
      if (prop === "name" || prop === "description") return undefined;
      if (
        prop === "providers" ||
        prop === "actions" ||
        prop === "services" ||
        prop === "events" ||
        prop === "evaluators" ||
        prop === "routes" ||
        prop === "init"
      ) {
        return undefined;
      }
      return NOOP_FN;
    },
    has() {
      return true;
    },
  });
}

module.exports = makeStubProxy();
