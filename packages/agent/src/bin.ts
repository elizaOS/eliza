#!/usr/bin/env node

import * as _earlyFs from "node:fs";
import { enableCompileCache } from "node:module";
import { homedir as _earlyHomedir } from "node:os";

// Enable Node 22.8+'s persistent V8 compile cache before any heavy import so
// the 2nd+ cold boot skips recompiling the ~70k LOC of transpiled plugin
// source. Anchored to <stateDir>/cache/node-compile — the SAME dir the dev
// orchestrator pins via NODE_COMPILE_CACHE (dev-ui.mjs) — so the packaged CLI
// path and the dev path share one warm cache instead of two.
//
// When NODE_COMPILE_CACHE is already set (dev path), Node enables the cache
// from the env var before any user code runs, so we skip — calling it again
// would be redundant. Wrapped defensively: a missing API (older Node) or any
// failure must never break boot.
(() => {
  try {
    if (
      typeof enableCompileCache !== "function" ||
      process.env.NODE_COMPILE_CACHE?.trim()
    ) {
      return;
    }
    const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
    // `process.env.HOME` is unset on Windows; `os.homedir()` returns
    // `%USERPROFILE%` there and `$HOME` on POSIX, so this cache anchors
    // identically to the rest of the codebase (see state-dir.ts).
    const home = process.env.HOME?.trim() || _earlyHomedir();
    const resolvedStateDir =
      process.env.ELIZA_STATE_DIR?.trim() ||
      (xdgStateHome
        ? `${xdgStateHome}/eliza`
        : home
          ? `${home}/.local/state/eliza`
          : undefined);
    if (resolvedStateDir) {
      enableCompileCache(`${resolvedStateDir}/cache/node-compile`);
    } else {
      enableCompileCache();
    }
  } catch {
    // V8 compile cache is a pure boot-time optimization; ignore any failure.
  }
})();

import { runAutonomousCli } from "./cli/index.ts";
import { configureMobileDnsIfNeeded } from "./runtime/mobile-dns.ts";

// Early diagnostic logger for Android: captures errors before the fs shim runs.
// Uses raw node:fs so the shim can't interfere. Writes to $ELIZA_STATE_DIR/bin-debug.log.
const _binDebugLog =
  process.env.ELIZA_PLATFORM === "android"
    ? (() => {
        const xdgStateHome =
          process.env.XDG_STATE_HOME ??
          `${process.env.HOME ?? "/data/local/tmp"}/.local/state`;
        const stateDir = process.env.ELIZA_STATE_DIR || `${xdgStateHome}/eliza`;
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

// Mobile devices ship no /etc/resolv.conf, so the musl bun agent can't resolve
// DNS — every outbound fetch (cloud, model catalog, connectors) fails until we
// point the resolver at public nameservers. No-op off-device. Runs at module
// eval, before the runtime boots or any fetch fires.
configureMobileDnsIfNeeded();

async function bootstrapMobileEntrypoint(): Promise<void> {
  if (process.env.ELIZA_PLATFORM === "android") {
    _binDebugLog("[bin.ts] entering android block");
    try {
      // Bundle anchor: evaluating this literal-specifier import forces
      // @elizaos/plugin-aosp-local-inference into the mobile bundle. Its exports
      // are re-imported and consumed by the runtime independently
      // (eliza.ts ensureAospLocalInferenceHandlers; plugin-local-inference's
      // registerAospLlamaLoader), so nothing is captured here.
      await import(/* @vite-ignore */ "@elizaos/plugin-aosp-local-inference");
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

  if (process.env.ELIZA_DEVICE_BRIDGE_ENABLED === "1") {
    try {
      // Bundle anchor only: eliza.ts imports and calls
      // ensureMobileDeviceBridgeInferenceHandlers on the runtime.
      await import(
        "@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap"
      );
    } catch {
      // Device bridge is explicitly opt-in; absence just leaves cloud/local-model
      // provider selection to the runtime.
    }
  }

  _binDebugLog("[bin.ts] pre-runAutonomousCli");
  await runAutonomousCli();
}

bootstrapMobileEntrypoint().catch((error) => {
  const msg =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  _binDebugLog(`[bin.ts] FATAL runAutonomousCli threw: ${msg}`);
  console.error("[eliza-autonomous] Failed to start:", msg);
  process.exit(1);
});
