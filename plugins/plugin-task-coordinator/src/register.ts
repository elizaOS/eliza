/**
 * Registers the developer-only Orchestrator app-shell page and the plugin's
 * slot fills.
 *
 * Native clients reject agent-served executable view bundles, so the signed
 * build needs an in-process loader for the routes its device sweep asserts.
 * Only `/orchestrator` is bundled here: it is developer-gated and already has
 * web route coverage, so no product-visible surface changes on any host. The
 * remaining views stay on the agent-served manifest in `index.ts`.
 */
import { Capacitor } from "@capacitor/core";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import "./register-slots.js";

const NATIVE_TASK_COORDINATOR_PAGES = [
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
] as const;

export function registerNativeTaskCoordinatorPages(
  nativePlatform: boolean,
  register: typeof registerAppShellPage = registerAppShellPage,
): void {
  if (!nativePlatform) return;
  for (const page of NATIVE_TASK_COORDINATOR_PAGES) register(page);
}

registerNativeTaskCoordinatorPages(Capacitor.isNativePlatform());
