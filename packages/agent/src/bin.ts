#!/usr/bin/env node
import { runAutonomousCli } from "./cli/index.js";
// Static import so `Bun.build` pulls the AOSP llama loader into the mobile
// bundle. The adapter self-gates on `ELIZA_LOCAL_LLAMA=1` and no-ops on
// every other platform/runtime, so the import is safe everywhere; we only
// need it bundled so `ensure-local-inference-handler.ts`'s dynamic import of
// `@elizaos/agent/runtime/aosp-llama-adapter` resolves on-device. Registration
// itself happens through that handler, not from this side-effect import.
//
// We capture the named export into `globalThis` to defeat Bun.build's
// tree-shaking — a bare side-effect import would let the bundler drop
// `registerAospLlamaLoader` because nothing else in this entry references it,
// which is exactly what we observed empirically (only the source-map comment
// survived, the symbol did not). Dropping it would silently break the
// dynamic import path on AOSP. Keep this guard pinned.
import { registerAospLlamaLoader as __elizaAospLlamaLoader } from "./runtime/aosp-llama-adapter.js";
// Static import so `Bun.build` pulls the AOSP local-inference bootstrap
// into the mobile bundle. The bootstrap runs `ensureAospLocalInferenceHandlers`
// after `startEliza()` returns the runtime, registering TEXT_SMALL /
// TEXT_LARGE / TEXT_EMBEDDING handlers backed by the AOSP llama loader.
// Without this static import + globalThis pin, Bun.build tree-shakes the
// symbol out (the only consumer is a dynamic import in `cli/index.ts`,
// which is enough for resolution but not for inclusion in some Bun.build
// configurations). Mirror the `__elizaAospLlamaLoader` pattern.
import { ensureAospLocalInferenceHandlers as __elizaAospLocalInferenceBootstrap } from "./runtime/aosp-local-inference-bootstrap.js";
// Static import so `Bun.build` pulls @elizaos/app-{wifi,contacts,phone}'s
// `/plugin` subpath into the mobile bundle. Each plugin imports from
// `@elizaos/agent` (the barrel that re-exports `runtime/eliza.ts`), so
// statically importing them HERE — after the aosp-* imports have already
// dragged eliza.ts through evaluation via their own deps — sidesteps the
// init cycle that would otherwise leave the plugins' named exports
// undefined. The imported modules are also Object.assign'd into
// STATIC_ELIZA_PLUGINS so plugin-resolver.ts picks them up before falling
// through to a runtime `import("@elizaos/app-*/plugin")` that has no
// node_modules tree to resolve on-device.
import "./runtime/android-app-plugins.js";

(
  globalThis as { __elizaAospLlamaLoader?: typeof __elizaAospLlamaLoader }
).__elizaAospLlamaLoader = __elizaAospLlamaLoader;

(
  globalThis as {
    __elizaAospLocalInferenceBootstrap?: typeof __elizaAospLocalInferenceBootstrap;
  }
).__elizaAospLocalInferenceBootstrap = __elizaAospLocalInferenceBootstrap;

runAutonomousCli().catch((error) => {
  console.error(
    "[eliza-autonomous] Failed to start:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
