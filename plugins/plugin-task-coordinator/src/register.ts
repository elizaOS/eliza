import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { OrchestratorTuiView } from "./CodingAgentTasksPanel";
import { OrchestratorWorkbench } from "./OrchestratorWorkbench";
import { OdysseusShell } from "./odysseus/OdysseusShell";

registerAppShellPage({
  id: "orchestrator",
  pluginId: "@elizaos/plugin-task-coordinator",
  label: "Orchestrator",
  icon: "Layers",
  path: "/orchestrator",
  order: 70,
  group: "developer",
  fullBleed: true,
  Component: OrchestratorWorkbench,
});

// odysseus 1:1 port — rendered at /odysseus while iterated; folds into
// /orchestrator once approved.
registerAppShellPage({
  id: "odysseus",
  pluginId: "@elizaos/plugin-task-coordinator",
  label: "Odysseus",
  icon: "MessageSquare",
  path: "/odysseus",
  order: 69,
  group: "developer",
  fullBleed: true,
  Component: OdysseusShell,
});

registerAppShellPage({
  id: "orchestrator.tui",
  pluginId: "@elizaos/plugin-task-coordinator",
  label: "Orchestrator TUI",
  icon: "Terminal",
  path: "/orchestrator/tui",
  order: 71,
  group: "developer",
  Component: OrchestratorTuiView,
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
