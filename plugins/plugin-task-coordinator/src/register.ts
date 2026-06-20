import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "orchestrator",
  pluginId: "@elizaos/plugin-task-coordinator",
  label: "Orchestrator",
  icon: "Layers",
  path: "/orchestrator",
  order: 70,
  group: "developer",
  fullBleed: true,
  loader: () =>
    import("./OrchestratorWorkbench").then((module) => ({
      default: module.OrchestratorWorkbench,
    })),
});

registerAppShellPage({
  id: "orchestrator.tui",
  pluginId: "@elizaos/plugin-task-coordinator",
  label: "Orchestrator TUI",
  icon: "Terminal",
  path: "/orchestrator/tui",
  order: 71,
  group: "developer",
  loader: () =>
    import("./CodingAgentTasksPanel").then((module) => ({
      default: module.OrchestratorTuiView,
    })),
});

// In a terminal host (the Node agent, no DOM), register the unified
// orchestrator view so it renders inline in the terminal. Lazy + DOM-guarded so
// the terminal engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerOrchestratorTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
