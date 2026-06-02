import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { OdysseusTuiView, OrchestratorTuiView } from "./CodingAgentTasksPanel";
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

registerAppShellPage({
  id: "odysseus.tui",
  pluginId: "@elizaos/plugin-task-coordinator",
  label: "Odysseus TUI",
  icon: "Terminal",
  path: "/odysseus/tui",
  order: 72,
  group: "developer",
  Component: OdysseusTuiView,
});
