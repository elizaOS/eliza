import { registerAppShellPage, registerRendererService } from "@elizaos/ui";
import { startLifeOpsActivitySignalCapture } from "./lifeops/activity-signals-capture.js";

export function registerApp(): void {
  registerAppShellPage({
    id: "lifeops-connections",
    pluginId: "@elizaos/plugin-personal-assistant",
    label: "Mail & Calendars",
    icon: "Cable",
    path: "/lifeops/connections",
    order: 905,
    viewKind: "release",
    surface: { header: "fullscreen", capabilities: ["agent-surface"] },
    loader: () =>
      import(
        "./components/lifeops-connections/LifeOpsConnectionsView.tsx"
      ).then((module) => ({ default: module.LifeOpsConnectionsView })),
  });

  registerAppShellPage({
    id: "family-operations",
    pluginId: "@elizaos/plugin-personal-assistant",
    label: "Family Operations",
    icon: "UsersRound",
    path: "/lifeops/family",
    order: 906,
    viewKind: "release",
    surface: { header: "fullscreen", capabilities: ["agent-surface"] },
    loader: () =>
      import("./components/family-operations/FamilyOperationsView.tsx").then(
        (module) => ({ default: module.FamilyOperationsView }),
      ),
  });

  registerRendererService({
    id: "personal-assistant.lifeops-activity-signals",
    shells: ["main"],
    start: (context) => startLifeOpsActivitySignalCapture(true, context),
  });
}
