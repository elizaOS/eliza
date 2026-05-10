// null-plugin.cjs — used by the mobile bundle for optional @elizaos plugins
// that pull in desktop-only transitive deps (e.g. plugin-cli
// which pins old @elizaos/core, plugin-shell drags in PTY, plugin-pdf needs
// canvas, etc.).
//
// The agent runtime references these packages in three ways:
//
//   1. Top-level `require()` in try/catch — `if (pluginShell) { ... }` etc.
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
  // Pre-define the property names that agent-side bundlers (Bun.build,
  // and Node-style `__toESM`) rebuild a namespace from at module-load
  // time. `__toESM(mod, 1)` reads `Object.getOwnPropertyNames(mod)` and
  // uses THAT list — the Proxy `get` trap is bypassed for unknown names,
  // so any property that isn't an own key on `target` ends up `undefined`
  // in the destructured ESM namespace, no matter how clever the trap is.
  //
  // Production failure that surfaced this: the agent's plugin-routes
  // ctx-object pulled `applyWhatsAppQrOverride: import_plugin_whatsapp3
  // .applyWhatsAppQrOverride`, but the namespace had no own keys, so
  // the destructure produced `undefined`, and runtime crashed with
  // `applyWhatsAppQrOverride3 is not a function`.
  //
  // Fix: pre-populate the target with no-op functions for every name the
  // agent's transitive imports destructure off these stubs. The trap then
  // only handles dynamic access (still NOOP_FN), keeping
  // findRuntimePluginExport's plugin-shape probe inert.
  const PRE_POPULATED_NAMES = [
    // plugin-whatsapp surface used by agent api/server.ts +
    // plugin-routes.ts
    "applyWhatsAppQrOverride",
    "handleWhatsAppRoute",
    "WHATSAPP_MAX_PAIRING_SESSIONS",
    // plugin-signal surface (same routing pattern)
    "applySignalQrOverride",
    "handleSignalRoute",
    // plugin-discord-local (api server)
    "handleDiscordLocalRoute",
    // plugin-mcp / plugin-streaming used elsewhere; safer to populate
    // since some are stubbed via `optionalPluginStubs`.
    "handleMcpRoutes",
    "handleTtsRoutes",
    "streamManager",
    "validateX402Startup",
  ];
  const target = {};
  for (const name of PRE_POPULATED_NAMES) {
    target[name] = NOOP_FN;
  }
  return new Proxy(target, {
    get(t, prop) {
      if (Object.hasOwn(t, prop)) return t[prop];
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
