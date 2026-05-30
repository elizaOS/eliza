import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { OrchestratorTuiView } from "./CodingAgentTasksPanel";
import { OrchestratorWorkbench } from "./OrchestratorWorkbench";

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
