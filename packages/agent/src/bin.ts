#!/usr/bin/env node

import * as _earlyFs from "node:fs";
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
// Early diagnostic logger for Android: captures errors before the fs shim runs.
// Uses the raw node:fs (captured above) so the shim can't interfere.
// Writes to $ELIZA_STATE_DIR/bin-debug.log — readable via adb run-as.
const _binDebugLog =
  process.env.ELIZA_PLATFORM === "android"
    ? (() => {
        const stateDir =
          process.env.ELIZA_STATE_DIR ||
          process.env.MILADY_STATE_DIR ||
          `${process.env.HOME ?? "/data/local/tmp"}/.eliza`;
        const logPath = `${stateDir}/bin-debug.log`;
        try {
          _earlyFs.mkdirSync(stateDir, { recursive: true });
        } catch {
          /* ignore */
        }
        return (msg: string) => {
          try {
            _earlyFs.appendFileSync(
              logPath,
              `${new Date().toISOString()} ${msg}\n`,
            );
          } catch {
            /* ignore */
          }
        };
      })()
    : () => {};
_binDebugLog(
  `[bin.ts] started ELIZA_PLATFORM=${process.env.ELIZA_PLATFORM ?? "(unset)"} ELIZA_STATE_DIR=${process.env.ELIZA_STATE_DIR ?? "(unset)"}`,
);

if (process.env.ELIZA_PLATFORM === "android") {
  _binDebugLog("[bin.ts] entering android block");
  try {
    const { registerAospLlamaLoader, ensureAospLocalInferenceHandlers } =
      await import("@elizaos/plugin-aosp-local-inference");
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
  } catch (e) {
    // Android-only local inference is optional outside the privileged AOSP build.
    _binDebugLog(
      `[bin.ts] aosp-local-inference init error (ok): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    await import("./runtime/android-app-plugins.ts");
    _binDebugLog("[bin.ts] android-app-plugins loaded ok");
  } catch (e) {
    // Android-only app plugins not bundled in this build; plugin-resolver.ts
    // returns null for these IDs and the rest of the runtime is unaffected.
    _binDebugLog(
      `[bin.ts] android-app-plugins init error (ok): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
_binDebugLog("[bin.ts] pre-runAutonomousCli");

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
  const msg =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  _binDebugLog(`[bin.ts] FATAL runAutonomousCli threw: ${msg}`);
  console.error("[eliza-autonomous] Failed to start:", msg);
  process.exit(1);
});
