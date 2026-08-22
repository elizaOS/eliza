#!/usr/bin/env node
/**
 * Boots the interactive and one-shot eliza-code entrypoints after capturing
 * the host executable-search baseline needed by shell-backed coding tools.
 */

// Suppress elizaOS logs before any imports
process.env.LOG_LEVEL = "fatal";

// FIRST import: capture the executable-search authority before any runtime
// module (or loadEnv) can mutate process.env — same contract as the acp
// entry. Without it the one-shot/TUI child resolves git/rg/bun against an
// empty baseline and every SHELL dispatch dies "not available in PATH"
// (live 2026-08-18: repo tasks completed with no commits).
import "./host-baseline.js";

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
  } catch (error) {
    // error-policy:J6 Terminal restoration continues through every teardown
    // step, while stderr preserves each failed step for diagnosis.
    process.stderr.write(
      `[eliza-code] app teardown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  try {
    if (process.stdout.isTTY) {
      // Disable bracketed paste + Kitty keyboard protocol, show the cursor.
      process.stdout.write("\x1b[?2004l\x1b[<u\x1b[?25h");
    }
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  } catch (error) {
    // error-policy:J6 This is the last terminal teardown path before exit.
    process.stderr.write(
      `[eliza-code] terminal restore failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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
  } catch (error) {
    // error-policy:J6 Process shutdown must reach exit even if persistence or
    // service teardown fails, but the failure remains observable on stderr.
    process.stderr.write(
      `[eliza-code] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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

  const [{ App }, { initializeAgent }, { resolveTuiOwnerUserId }] =
    await Promise.all([
      import("./App.js"),
      import("./lib/agent.js"),
      import("./lib/tui-owner.js"),
    ]);

  let runtime: AgentRuntime | undefined;
  let app: InstanceType<typeof App> | undefined;

  // Same owner/tooling bootstrap as the ACP server and the one-shot CLI
  // (acp.ts / cli.ts): without it the TUI user resolves to GUEST and every
  // OWNER/ADMIN-gated coding tool is withheld from the planner — the agent
  // chats but can never act (live 2026-08-10 TUI session: "ship something"
  // looped "I handled the available step.").
  // Load the exact store instance that App and the message client use before
  // booting the runtime. Creating a separate fallback session here would give
  // a fresh TUI two user IDs and grant OWNER to the one that sends no turns.
  const ownerUserId = await resolveTuiOwnerUserId();
  process.env.ELIZA_ADMIN_ENTITY_ID ??= ownerUserId;

  // Initialize the agent
  runtime = await initializeAgent({ codingOnly: shouldRunCodingOnly() });
  (
    runtime as unknown as { setSetting?: (k: string, v: unknown) => void }
  ).setSetting?.("ELIZA_ADMIN_ENTITY_ID", ownerUserId);

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

  // App exited normally (e.g., Ctrl+Q / double Ctrl+C). Cleanup is bounded and
  // the process exits explicitly: leaked runtime handles (DB, timers) must
  // never hold the user's terminal hostage after a quit (live 2026-08-10:
  // quit ran but the prompt never returned).
  await Promise.race([
    cleanup(runtime),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  process.exit(0);
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
