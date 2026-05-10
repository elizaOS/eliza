import type { Plugin } from "@elizaos/core";

export function createAppDefenseOfTheAgentsPlugin(): Plugin {
  return {
    name: "@elizaos/app-defense-of-the-agents",
    description:
      "Defense of the Agents app wrapper for Eliza. Serves a Eliza spectator shell and routes session commands to the live game API.",
    app: {
      displayName: "Defense of the Agents",
      category: "game",
      launchType: "connect",
      launchUrl: "https://www.defenseoftheagents.com/",
      capabilities: ["strategy", "telemetry", "lane-control"],
      runtimePlugin: "@elizaos/app-defense-of-the-agents",
      viewer: {
        url: "/api/apps/defense-of-the-agents/viewer",
        sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
      },
      session: {
        mode: "spectate-and-steer",
        features: ["commands", "telemetry", "suggestions"],
      },
    },
  };
}

export const appDefenseOfTheAgentsPlugin = createAppDefenseOfTheAgentsPlugin();

export default appDefenseOfTheAgentsPlugin;
export * from "./routes";
export * from "./ui";
