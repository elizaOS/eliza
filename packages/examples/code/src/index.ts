#!/usr/bin/env node
// Suppress elizaOS logs before any imports
process.env.LOG_LEVEL = "fatal";

import type { AgentRuntime } from "@elizaos/core";
import { main as cliMain } from "./cli.js";
import { loadEnv } from "./lib/load-env.js";

loadEnv();

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Determine if we should run in interactive (TUI) mode.
 * Interactive mode requires:
 * - stdin and stdout both be TTYs
 * - No message argument provided (unless --interactive flag)
 */
function shouldRunInteractive(): boolean {
  const args = process.argv.slice(2);

  // Explicit interactive flag
  if (args.includes("-i") || args.includes("--interactive")) {
    return true;
  }

  // Help/version should use CLI mode
  if (
    args.includes("-h") ||
    args.includes("--help") ||
    args.includes("-v") ||
    args.includes("--version")
  ) {
    return false;
  }

  // If there are any arguments (message, file, etc.), use CLI mode
  if (args.length > 0) {
    return false;
  }

  // Check if TTY is available
  // Bun/watch can sometimes leave `isTTY` undefined even in a real terminal.
  // Only treat it as non-interactive if it is explicitly `false`.
  return process.stdin.isTTY !== false && process.stdout.isTTY !== false;
}

function shouldRunCodingOnly(): boolean {
  const args = process.argv.slice(2);
  const env = process.env.ELIZA_CODE_CODING_ONLY?.trim().toLowerCase();
  return (
    env === "1" ||
    env === "true" ||
    args.includes("--coding-only") ||
    args.includes("--no-orchestrator")
  );
}

// ============================================================================
// Interactive Mode (TUI)
// ============================================================================

let isShuttingDown = false;

// Module-scoped handle to the live TUI app so the fatal handlers below can
// restore the terminal (raw mode / bracketed paste / cursor) before exiting —
// that teardown only runs via app.stop(), so a bare process.exit(1) on an
// unhandled error used to leave the user's shell wedged.
let activeApp: { stop: () => void } | undefined;

/** Best-effort terminal restore before a fatal exit. Never throws. */
function restoreTerminalBestEffort(): void {
  try {
    activeApp?.stop();
  } catch {
    // Nothing we can do; still try the raw escape-sequence restore below.
  }
  try {
    if (process.stdout.isTTY) {
      // Disable bracketed paste + Kitty keyboard protocol, show the cursor.
      process.stdout.write("\x1b[?2004l\x1b[<u\x1b[?25h");
    }
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  } catch {
    // Give up quietly — we're already on the fatal path.
  }
}

async function cleanup(runtime: AgentRuntime): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    const [{ shutdownAgent }, { resetAgentClient }, { useStore }] =
      await Promise.all([
        import("./lib/agent.js"),
        import("./lib/agent-client.js"),
        import("./lib/store.js"),
      ]);

    // Save session before shutdown
    await useStore.getState().saveSessionState();

    if (runtime) {
      await shutdownAgent(runtime);
    }
    resetAgentClient();
  } catch {
    // Shutdown helper errors do not affect the primary exit path.
  }

  process.exit(0);
}

async function runInteractive(): Promise<void> {
  // Validate TTY
  if (process.stdin.isTTY === false || process.stdout.isTTY === false) {
    console.error("❌ Interactive mode requires a terminal.");
    console.error(
      "   Use CLI mode for non-interactive usage: eliza-code --help",
    );
    process.exit(1);
  }

  const [{ App }, { initializeAgent }] = await Promise.all([
    import("./App.js"),
    import("./lib/agent.js"),
  ]);

  let runtime: AgentRuntime | undefined;
  let app: InstanceType<typeof App> | undefined;

  // Initialize the agent
  runtime = await initializeAgent({ codingOnly: shouldRunCodingOnly() });

  // Handle SIGINT (Ctrl+C) and SIGTERM
  const handleSignal = () => {
    if (app) {
      app.stop();
    }
    if (runtime) {
      cleanup(runtime);
    }
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // Clear the screen before rendering TUI
  console.clear();

  // Create and run the app
  app = new App(runtime);
  activeApp = app;
  await app.run();
  activeApp = undefined;

  // App exited normally (e.g., Ctrl+Q)
  await cleanup(runtime);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  if (shouldRunInteractive()) {
    await runInteractive();
  } else {
    const exitCode = await cliMain();

    // Special code -1 means: force interactive mode
    if (exitCode === -1) {
      await runInteractive();
    } else {
      process.exit(exitCode);
    }
  }
}

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  restoreTerminalBestEffort();
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  restoreTerminalBestEffort();
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

// Run the app
main().catch((error) => {
  restoreTerminalBestEffort();
  console.error("Fatal error:", error);
  process.exit(1);
});

// ============================================================================
// Exports for Testing
// ============================================================================

export { runInteractive, shouldRunInteractive };
