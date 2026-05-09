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
import { ensureMobileDeviceBridgeInferenceHandlers as __elizaMobileDeviceBridgeBootstrap } from "./runtime/mobile-device-bridge-bootstrap.js";

// Pull @elizaos/app-{wifi,contacts,phone}'s runtime plugin adapter into the
// mobile bundle. The adapter imports each app package's `/plugin` subpath,
// applies the agent-side hosted-app session gate, and Object.assigns those
// modules into STATIC_ELIZA_PLUGINS so plugin-resolver.ts picks them up before
// falling through to a wildcard app plugin import that has no
// node_modules tree to resolve on-device.
//
// Dynamic + try/catch instead of a static `import` so non-mobile builds
// (the Docker agent server image, desktop CLI on a fresh machine) don't
// crash at module init when those workspace packages aren't installed.
// Bun.build still bundles the target because the path is a string
// literal, so the Android bundle keeps the same behavior.
try {
  await import("./runtime/android-app-plugins.js");
} catch {
  // Android-only app plugins not bundled in this build; plugin-resolver.ts
  // returns null for these IDs and the rest of the runtime is unaffected.
}

(
  globalThis as { __elizaAospLlamaLoader?: typeof __elizaAospLlamaLoader }
).__elizaAospLlamaLoader = __elizaAospLlamaLoader;

(
  globalThis as {
    __elizaAospLocalInferenceBootstrap?: typeof __elizaAospLocalInferenceBootstrap;
  }
).__elizaAospLocalInferenceBootstrap = __elizaAospLocalInferenceBootstrap;

(
  globalThis as {
    __elizaMobileDeviceBridgeBootstrap?: typeof __elizaMobileDeviceBridgeBootstrap;
  }
).__elizaMobileDeviceBridgeBootstrap = __elizaMobileDeviceBridgeBootstrap;

runAutonomousCli().catch((error) => {
  console.error(
    "[eliza-autonomous] Failed to start:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
