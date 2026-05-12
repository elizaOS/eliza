import type { Plugin } from "@elizaos/core";

export {
  collectLaunchDiagnostics,
  handleAppRoutes,
  refreshRunSession,
  resolveLaunchSession,
  stopRun,
} from "./routes.js";
export * from "./ui/index.js";

export function createAppClawvillePlugin(): Plugin {
  return {
    name: "@elizaos/app-clawville",
    description:
      "ClawVille app wrapper for Eliza. Serves an embedded viewer for the sea-themed agent game and routes session commands to the ClawVille API.",
    app: {
      displayName: "ClawVille",
      category: "game",
      launchType: "connect",
      launchUrl: "https://clawville.world/game",
      capabilities: [
        "game",
        "skill-learning",
        "tokens",
        "multi-agent",
        "solana-wallet",
      ],
      runtimePlugin: "@elizaos/app-clawville",
      viewer: {
        url: "/api/apps/clawville/viewer",
        sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
      },
      session: {
        mode: "spectate-and-steer",
        features: ["commands", "telemetry", "suggestions"],
      },
      uiExtension: {
        detailPanelId: "clawville-control",
      },
    },
  };
}

export const appClawvillePlugin = createAppClawvillePlugin();

export default appClawvillePlugin;
export * from "./ui/index.js";
