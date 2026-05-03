#!/usr/bin/env node
// Suppress elizaOS logs before any imports
process.env.LOG_LEVEL = "fatal";

import { App } from "./App.js";
import { main as cliMain } from "./cli.js";
import { initializeAgent, shutdownAgent } from "./lib/agent.js";
import { resetAgentClient } from "./lib/agent-client.js";
import { loadEnv } from "./lib/load-env.js";
import { useStore } from "./lib/store.js";

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

// ============================================================================
// Interactive Mode (TUI)
// ============================================================================

let isShuttingDown = false;

async function cleanup(
  runtime: ReturnType<typeof initializeAgent> extends Promise<infer T>
    ? T
    : never,
) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    // Save session before shutdown
    await useStore.getState().saveSessionState();

    if (runtime) {
      await shutdownAgent(runtime);
    }
    resetAgentClient();
  } catch {
    // Ignore cleanup errors
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

  let runtime: Awaited<ReturnType<typeof initializeAgent>> | undefined;
  let app: App | undefined;

  // Initialize the agent
  runtime = await initializeAgent();

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
  await app.run();

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
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

// Run the app
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

// ============================================================================
// Exports for Testing
// ============================================================================

export { shouldRunInteractive, runInteractive };
