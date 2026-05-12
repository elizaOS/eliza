#!/usr/bin/env node

// Static import so `Bun.build` pulls the AOSP llama loader into the mobile
// bundle. The adapter self-gates on `ELIZA_LOCAL_LLAMA=1` and no-ops on
// every other platform/runtime, so the import is safe everywhere; we only
// need it bundled so `ensure-local-inference-handler.ts`'s dynamic import of
// `@elizaos/plugin-aosp-local-inference` resolves on-device. Registration
// itself happens through that handler, not from this side-effect import.
//
// We capture the named export into `globalThis` to defeat Bun.build's
// tree-shaking — a bare side-effect import would let the bundler drop
// `registerAospLlamaLoader` because nothing else in this entry references it,
// which is exactly what we observed empirically (only the source-map comment
// survived, the symbol did not). Dropping it would silently break the
// dynamic import path on AOSP. Keep this guard pinned.
// Static import so `Bun.build` pulls the AOSP local-inference bootstrap
// into the mobile bundle. The bootstrap runs `ensureAospLocalInferenceHandlers`
// after `startEliza()` returns the runtime, registering TEXT_SMALL /
// TEXT_LARGE / TEXT_EMBEDDING handlers backed by the AOSP llama loader.
// Without this static import + globalThis pin, Bun.build tree-shakes the
// symbol out (the only consumer is a dynamic import in `cli/index.ts`,
// which is enough for resolution but not for inclusion in some Bun.build
// configurations). Mirror the `__elizaAospLlamaLoader` pattern.
import { runAutonomousCli } from "./cli/index.ts";

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
if (process.env.ELIZA_PLATFORM === "android") {
  try {
    const {
      registerAospLlamaLoader,
      ensureAospLocalInferenceHandlers,
    } = await import("@elizaos/plugin-aosp-local-inference");
    (
      globalThis as {
        __elizaAospLlamaLoader?: typeof registerAospLlamaLoader;
      }
    ).__elizaAospLlamaLoader = registerAospLlamaLoader;
    (
      globalThis as {
        __elizaAospLocalInferenceBootstrap?: typeof ensureAospLocalInferenceHandlers;
      }
    ).__elizaAospLocalInferenceBootstrap = ensureAospLocalInferenceHandlers;
  } catch {
    // Android-only local inference is optional outside the privileged AOSP build.
  }

  try {
    await import("./runtime/android-app-plugins.ts");
  } catch {
    // Android-only app plugins not bundled in this build; plugin-resolver.ts
    // returns null for these IDs and the rest of the runtime is unaffected.
  }
}

if (process.env.ELIZA_DEVICE_BRIDGE_ENABLED === "1") {
  try {
    const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
      "@elizaos/plugin-capacitor-bridge"
    );
    (
      globalThis as {
        __elizaMobileDeviceBridgeBootstrap?: typeof ensureMobileDeviceBridgeInferenceHandlers;
      }
    ).__elizaMobileDeviceBridgeBootstrap =
      ensureMobileDeviceBridgeInferenceHandlers;
  } catch {
    // Device bridge is explicitly opt-in; absence just leaves cloud/local-model
    // provider selection to the runtime.
  }
}

runAutonomousCli().catch((error) => {
  console.error(
    "[eliza-autonomous] Failed to start:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
