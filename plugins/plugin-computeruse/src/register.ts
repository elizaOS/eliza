import { registerAppShellPage } from "@elizaos/ui";

export function registerApp(): void {
  registerAppShellPage({
    id: "computer-use-sessions",
    pluginId: "@elizaos/plugin-computeruse",
    label: "Computer Sessions",
    icon: "MonitorUp",
    path: "/computer-use-sessions",
    order: 930,
    viewKind: "release",
    surface: { capabilities: ["agent-surface"] },
    loader: () =>
      import("./views/ComputerUseSessionsView.tsx").then((module) => ({
        default: module.ComputerUseSessionsView,
      })),
  });
}
