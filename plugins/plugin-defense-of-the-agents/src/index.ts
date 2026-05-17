import type { Plugin } from "@elizaos/core";

export function createAppDefenseOfTheAgentsPlugin(): Plugin {
  return {
    name: "@elizaos/plugin-defense-of-the-agents",
    description:
      "Defense of the Agents app wrapper for Eliza. Serves a Eliza spectator shell and routes session commands to the live game API.",
    app: {
      displayName: "Defense of the Agents",
      category: "game",
      launchType: "connect",
      launchUrl: "https://www.defenseoftheagents.com/",
      capabilities: ["strategy", "telemetry", "lane-control"],
      runtimePlugin: "@elizaos/plugin-defense-of-the-agents",
      viewer: {
        url: "/api/apps/defense-of-the-agents/viewer",
        sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
      },
      session: {
        mode: "spectate-and-steer",
        features: ["commands", "telemetry", "suggestions"],
      },
    },
    views: [
      {
        id: "defense-of-the-agents",
        label: "Defense of the Agents",
        description: "Defense of the Agents spectator and operator surface — strategy and telemetry",
        icon: "Gamepad2",
        path: "/defense-of-the-agents",
        bundlePath: "dist/views/bundle.js",
        componentExport: "DefenseAgentsOperatorSurface",
        tags: ["game", "strategy", "defense-of-the-agents"],
        visibleInManager: true,
        desktopTabEnabled: true,
      },
    ],
  };
}

export const appDefenseOfTheAgentsPlugin = createAppDefenseOfTheAgentsPlugin();

export default appDefenseOfTheAgentsPlugin;
export * from "./routes";
export * from "./ui";
