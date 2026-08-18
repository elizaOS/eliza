/**
 * Registers the signed task-coordinator surfaces and their slot fills.
 *
 * Native clients reject agent-served executable view bundles, so these lazy
 * page loaders keep the same manifest routes available from the app binary.
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import "./register-slots.js";

registerAppShellPage({
  id: "task-coordinator",
  pluginId: "@elizaos/plugin-task-coordinator",
  label: "Task Coordinator",
  icon: "SquareTerminal",
  path: "/task-coordinator",
  viewKind: "preview",
  surface: {
    header: "fullscreen",
    capabilities: ["agent-surface"],
  },
  loader: () =>
    import("./TaskCoordinatorView.tsx").then((module) => ({
      default: module.TaskCoordinatorView,
    })),
});

registerAppShellPage({
  id: "orchestrator",
  pluginId: "@elizaos/plugin-task-coordinator",
  label: "Orchestrator",
  icon: "Layers",
  path: "/orchestrator",
  developerOnly: true,
  viewKind: "developer",
  surface: {
    header: "fullscreen",
    capabilities: ["agent-surface"],
  },
  loader: () =>
    import("./OrchestratorView.tsx").then((module) => ({
      default: module.OrchestratorView,
    })),
});

registerAppShellPage({
  id: "cockpit",
  pluginId: "@elizaos/plugin-task-coordinator",
  label: "Cockpit",
  icon: "TerminalSquare",
  path: "/cockpit",
  developerOnly: true,
  viewKind: "developer",
  surface: {
    header: "fullscreen",
    capabilities: ["agent-surface"],
  },
  loader: () =>
    import("./CockpitRoute.tsx").then((module) => ({
      default: module.CockpitRoute,
    })),
});
