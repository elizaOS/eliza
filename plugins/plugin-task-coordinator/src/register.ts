/**
 * Registers the task-coordinator's bundled shell pages and shared UI slots.
 * Native clients cannot execute agent-served JavaScript, so these lazy page
 * loaders are the signed in-app counterparts to the runtime view manifest.
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import "./register-slots.js";

const pluginId = "@elizaos/plugin-task-coordinator";
const agentSurface = { capabilities: ["agent-surface"] } as const;

registerAppShellPage({
  id: "task-coordinator",
  pluginId,
  label: "Task Coordinator",
  icon: "SquareTerminal",
  path: "/task-coordinator",
  viewKind: "preview",
  surface: agentSurface,
  loader: () =>
    import("./TaskCoordinatorView.js").then((module) => ({
      default: module.TaskCoordinatorView,
    })),
});

registerAppShellPage({
  id: "orchestrator",
  pluginId,
  label: "Orchestrator",
  icon: "Layers",
  path: "/orchestrator",
  viewKind: "developer",
  developerOnly: true,
  surface: agentSurface,
  loader: () =>
    import("./OrchestratorView.js").then((module) => ({
      default: module.OrchestratorView,
    })),
});

registerAppShellPage({
  id: "cockpit",
  pluginId,
  label: "Cockpit",
  icon: "TerminalSquare",
  path: "/cockpit",
  viewKind: "developer",
  developerOnly: true,
  surface: agentSurface,
  loader: () =>
    import("./CockpitRoute.js").then((module) => ({
      default: module.CockpitRoute,
    })),
});
