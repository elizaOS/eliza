/**
 * android-mobile-bridge.ts — Android counterpart to ios-bridge.ts.
 *
 * On Android, the elizaOS agent runs as a Bun child process managed by
 * `ElizaAgentService`. Unlike the iOS path (which uses a stdio JSON-RPC
 * bridge to a JSContext host), the Android Bun process boots the full
 * elizaOS backend as an HTTP server listening on 127.0.0.1:31337.
 *
 * The agent bundle entry-point (`serve` / `start` command) already binds
 * the server when `ELIZA_DISABLE_DIRECT_RUN` is unset.  This module:
 *   1. Sets Android-specific environment variables before any module import.
 *   2. Installs the mobile fs sandbox shim.
 *   3. Boots the elizaOS runtime via the canonical `startEliza` path.
 *   4. Wires the `ELIZA_DEVICE_BRIDGE_ENABLED` inference delegation layer
 *      so the Capacitor WebView's llama-cpp plugin routes through the
 *      on-device agent over loopback.
 *
 * This module is imported by the agent bundle's `android-bridge` CLI command:
 *   `bun agent-bundle.js android-bridge`
 *
 * Environment variables set here mirror those set by `ElizaAgentService`:
 *   - ELIZA_PLATFORM=android
 *   - ELIZA_MOBILE_PLATFORM=android
 *   - ELIZA_ANDROID_LOCAL_BACKEND=1   (Android-specific backend flag)
 *   - ELIZA_HEADLESS=1                (no terminal UI)
 *   - ELIZA_API_BIND=127.0.0.1        (loopback only)
 *   - ELIZA_VAULT_BACKEND=file
 *   - ELIZA_DISABLE_VAULT_PROFILE_RESOLVER=1
 *   - ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP=1
 *   - LOG_LEVEL=error                 (quiet on-device)
 *
 * All values use the `||=` pattern so that values pre-set by the
 * `ElizaAgentService` environment take precedence over these defaults.
 * The service sets richer values (e.g. `ELIZA_API_TOKEN`, port, state dir)
 * before spawning the bundle; this module only fills gaps for direct runs.
 */

import process from "node:process";

// ── Step 1: set Android env vars before any elizaOS module import ──────────

// These match what ElizaAgentService passes as process.env; keep in sync.
process.env.ELIZA_PLATFORM ||= "android";
process.env.ELIZA_MOBILE_PLATFORM ||= "android";
process.env.ELIZA_ANDROID_LOCAL_BACKEND ||= "1";
process.env.ELIZA_DISABLE_DIRECT_RUN ||= "1";
process.env.ELIZA_HEADLESS ||= "1";
process.env.ELIZA_API_BIND ||= "127.0.0.1";
process.env.ELIZA_VAULT_BACKEND ||= "file";
process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER ||= "1";
process.env.ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP ||= "1";
process.env.LOG_LEVEL ||= "error";

// Disable on-device optimisation pipeline (no prompt training on mobile).
process.env.ELIZA_DISABLE_AUTO_BOOTSTRAP ||= "1";
process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING ||= "1";

// ── Step 2: install the mobile fs sandbox shim ────────────────────────────
// Use ELIZA_STATE_DIR (set by ElizaAgentService) as the workspace root.
// Fall back to HOME/.eliza if running standalone outside the service.

import { installMobileFsShim } from "./mobile-fs-shim.ts";

const stateDir =
  process.env.ELIZA_STATE_DIR ||
  process.env.MILADY_STATE_DIR ||
  `${process.env.HOME ?? "/data/local/tmp"}/.eliza`;

installMobileFsShim(stateDir);

// ── Step 3: boot the runtime ──────────────────────────────────────────────

export async function runAndroidBridgeCli(): Promise<void> {
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[android-bridge] unhandled rejection:",
      reason instanceof Error ? reason.stack || reason.message : reason,
    );
  });
  process.on("uncaughtException", (error) => {
    console.error(
      "[android-bridge] uncaught exception:",
      error.stack || error.message,
    );
  });

  const { startEliza } = await import("../runtime/index.ts");

  const runtime = await startEliza({ serverOnly: true });

  console.log(
    `[android-bridge] startEliza returned: runtime=${runtime ? "present" : "null"}, ` +
      `ELIZA_ANDROID_LOCAL_BACKEND=${process.env.ELIZA_ANDROID_LOCAL_BACKEND ?? "(unset)"}`,
  );

  // ── Step 4: wire inference delegation if device-bridge enabled ────────────
  // The Capacitor WebView's llama-cpp plugin connects to the agent's
  // `/api/local-inference/device-bridge` WebSocket endpoint.  Without
  // this bootstrap, the bridge handler is never registered.
  if (runtime && process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1") {
    console.log("[android-bridge] importing mobile-device-bridge-bootstrap…");
    const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
      "@elizaos/plugin-capacitor-bridge"
    );
    const ok = await ensureMobileDeviceBridgeInferenceHandlers(runtime);
    console.log(
      `[android-bridge] ensureMobileDeviceBridgeInferenceHandlers returned ${ok}`,
    );
  }

  // Keep the process alive indefinitely — ElizaAgentService will SIGTERM
  // when the user stops the service or the app is swiped away.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  console.log("[android-bridge] shutdown signal received, exiting.");
}
