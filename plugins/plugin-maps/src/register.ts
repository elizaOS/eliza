import { registerAppShellPage } from "@elizaos/ui";

export function registerApp(): void {
  registerAppShellPage({
    id: "maps",
    pluginId: "@elizaos/plugin-maps",
    label: "Maps",
    icon: "Map",
    path: "/maps",
    order: 925,
    viewKind: "release",
    surface: {
      header: "fullscreen",
      capabilities: ["agent-surface"],
    },
    loader: () =>
      import("./components/MapsPage.tsx").then((module) => ({
        default: module.MapsPage,
      })),
  });
}
