/**
 * Registers native task-coordinator surfaces and the plugin's slot fills.
 *
 * Native clients reject agent-served executable view bundles, so these lazy
 * page loaders keep the same manifest routes available from the app binary.
 */
import { Capacitor } from "@capacitor/core";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import "./register-slots.js";

const NATIVE_TASK_COORDINATOR_PAGES = [
  {
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
  },
  {
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
  },
  {
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
  },
] as const;

export function registerNativeTaskCoordinatorPages(
  nativePlatform: boolean,
  register: typeof registerAppShellPage = registerAppShellPage,
): void {
  if (!nativePlatform) return;
  for (const page of NATIVE_TASK_COORDINATOR_PAGES) register(page);
}

registerNativeTaskCoordinatorPages(Capacitor.isNativePlatform());
