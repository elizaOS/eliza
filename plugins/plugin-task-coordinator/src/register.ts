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
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
