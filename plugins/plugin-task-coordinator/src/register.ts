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
