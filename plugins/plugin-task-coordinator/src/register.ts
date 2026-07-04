/**
 * Registration side-effect module — imported for effect, not exports. Activates
 * the slot-registry fills (`register-slots`) that give the `@elizaos/ui`
 * empty-slot defaults their real components, and, when running without a DOM
 * (the Node agent / terminal host), lazily registers the two tri-modal views
 * into the terminal registry so they render inline in the terminal.
 */
import { logger } from "@elizaos/core";
import "./register-slots.js";

// In a terminal host (the Node agent, no DOM), register the unified
// orchestrator + task-coordinator views so they render inline in the terminal.
// Lazy + DOM-guarded so the terminal engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => {
      m.registerOrchestratorTerminalView();
      m.registerTaskCoordinatorTerminalView();
    })
    .catch((err: unknown) => {
      // error-policy:J4 terminal rendering is best-effort and must not block
      // plugin load, but the failure must be visible — the two views silently
      // not rendering in the terminal is otherwise indistinguishable from idle.
      logger.warn(
        `[task-coordinator] Failed to register terminal views: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
}
