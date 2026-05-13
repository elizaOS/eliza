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
process.env.LOG_LEVEL ||= "info";

// Disable on-device optimisation pipeline (no prompt training on mobile).
process.env.ELIZA_DISABLE_AUTO_BOOTSTRAP ||= "1";
process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING ||= "1";

// ── Step 2: install the mobile fs sandbox shim ────────────────────────────
// Use ELIZA_STATE_DIR (set by ElizaAgentService) as the workspace root.
// Fall back to HOME/.eliza if running standalone outside the service.

import * as nodeFs from "node:fs";
import nodePath from "node:path";
import { installMobileFsShim } from "./mobile-fs-shim.ts";

// ── Resolve canonical paths and install mobile fs sandbox ─────────────────
//
// On Android, getFilesDir() returns /data/user/0/<pkg>/files but the bundle
// runs from /data/data/<pkg>/files (the real path; /data/user/0 is a symlink).
// The mobile-fs-shim uses string-prefix matching, so the sandbox root and all
// fs paths passed to it must use the same canonical form.
//
// Strategy:
//   1. Resolve HOME (= getFilesDir) through realpathSync → canonical root.
//   2. Update ELIZA_STATE_DIR / MILADY_STATE_DIR / HOME to use the canonical
//      prefix so any downstream path construction produces matching strings.
//   3. Set sandbox root = canonical HOME → covers .eliza/, agent/ assets, etc.
const _rawHome =
  process.env.HOME ||
  nodePath.dirname(
    process.env.ELIZA_STATE_DIR ||
      process.env.MILADY_STATE_DIR ||
      "/data/local/tmp/.eliza",
  );

let _canonicalHome: string;
try {
  _canonicalHome = nodeFs.realpathSync(_rawHome);
} catch {
  _canonicalHome = _rawHome;
}

// Remap any env var that starts with the old (symlink) prefix to the
// canonical (real) prefix so downstream code resolves paths consistently.
if (_canonicalHome !== _rawHome) {
  if (process.env.HOME) process.env.HOME = _canonicalHome;
  for (const key of [
    "ELIZA_STATE_DIR",
    "MILADY_STATE_DIR",
    "ELIZA_WORKSPACE_DIR",
    "MILADY_WORKSPACE_DIR",
    "TMPDIR",
  ] as const) {
    const val = process.env[key];
    if (val?.startsWith(_rawHome)) {
      process.env[key] = _canonicalHome + val.slice(_rawHome.length);
    }
  }
}

const stateDir =
  process.env.ELIZA_STATE_DIR ||
  process.env.MILADY_STATE_DIR ||
  `${_canonicalHome}/.eliza`;

installMobileFsShim(_canonicalHome);

// ── Debug file logger (bypasses stdio to avoid TIOCGWINSZ/SELinux issues) ───
// Writes to $ELIZA_STATE_DIR/android-bridge.log so we can read via adb run-as.
const _logPath = `${stateDir}/android-bridge.log`;
try {
  nodeFs.mkdirSync(stateDir, { recursive: true });
} catch {
  /* ignore */
}
function _logToFile(line: string): void {
  try {
    nodeFs.appendFileSync(_logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* ignore */
  }
}
_logToFile(`[android-bridge] process started, stateDir=${stateDir}`);

// ── Step 3: boot the runtime ──────────────────────────────────────────────

export async function runAndroidBridgeCli(): Promise<void> {
  // Log the process exit code for every exit (including process.exit(N) calls
  // from deep inside the runtime that bypass our try/catch).
  process.on("exit", (code) => {
    _logToFile(`[android-bridge] process.exit code=${code}`);
  });

  // Intercept console.error so errors logged by the runtime (e.g. the
  // "Could not start API server" message from eliza.ts) are captured in the
  // file log even though stdout/stderr are redirected to /dev/null on Android.
  const _origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    _logToFile(`[console.error] ${args.map(String).join(" ")}`);
    _origConsoleError(...args);
  };
  const _origConsoleWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    if (
      msg.includes("Error") ||
      msg.includes("error") ||
      msg.includes("fail")
    ) {
      _logToFile(`[console.warn] ${msg}`);
    }
    _origConsoleWarn(...args);
  };

  // Capture console.log/info for startup timing (removed once timing is known)
  const _origConsoleLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    _logToFile(`[console.log] ${msg}`);
    _origConsoleLog(...args);
  };
  const _origConsoleInfo = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    _logToFile(`[console.info] ${msg}`);
    _origConsoleInfo(...args);
  };

  process.on("unhandledRejection", (reason) => {
    const msg =
      reason instanceof Error ? reason.stack || reason.message : String(reason);
    _logToFile(`[android-bridge] unhandledRejection: ${msg}`);
    console.error("[android-bridge] unhandled rejection:", msg);
  });
  process.on("uncaughtException", (error) => {
    _logToFile(
      `[android-bridge] uncaughtException: ${error.stack || error.message}`,
    );
    console.error(
      "[android-bridge] uncaught exception:",
      error.stack || error.message,
    );
  });

  _logToFile("[android-bridge] importing startEliza...");
  const { startEliza } = await import("../runtime/index.ts");
  _logToFile("[android-bridge] calling startEliza({ serverOnly: true })...");

  // Heartbeat: log every 10s during startEliza so we can see where it stalls.
  const _hb = setInterval(() => {
    _logToFile("[android-bridge] startEliza still running...");
  }, 10_000);

  let runtime: Awaited<ReturnType<typeof startEliza>>;
  try {
    runtime = await startEliza({ serverOnly: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    _logToFile(`[android-bridge] startEliza THREW: ${msg}`);
    throw err;
  } finally {
    clearInterval(_hb);
  }
  _logToFile(
    `[android-bridge] startEliza returned: ${runtime ? "present" : "null"}`,
  );

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
