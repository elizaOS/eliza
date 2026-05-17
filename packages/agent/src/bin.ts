#!/usr/bin/env node

// Static import: Bun.build must include the AOSP loader in the mobile bundle.
// We pin it to globalThis to prevent tree-shaking — the only consumer is a
// dynamic import in cli/index.ts, which is enough for resolution but not
// inclusion. Without this guard the symbol silently disappears from the bundle.
import * as _earlyFs from "node:fs";
import { runAutonomousCli } from "./cli/index.ts";

// Early diagnostic logger for Android: captures errors before the fs shim runs.
// Uses raw node:fs so the shim can't interfere. Writes to $ELIZA_STATE_DIR/bin-debug.log.
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
      "@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap"
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
