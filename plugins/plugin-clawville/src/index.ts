import type { Plugin } from "@elizaos/core";

export {
  collectLaunchDiagnostics,
  handleAppRoutes,
  refreshRunSession,
  resolveLaunchSession,
} from "./routes.js";
export * from "./ui/index.js";

export function createAppClawvillePlugin(): Plugin {
  return {
    name: "@elizaos/plugin-clawville",
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
      runtimePlugin: "@elizaos/plugin-clawville",
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
    views: [
      // ONE declaration → GUI + XR + TUI, all drawn from the single
      // ClawvilleView spatial source. `modalities` is a plain literal here
      // (index.ts is not in the view bundle), so no brand-new `@elizaos/core`
      // runtime export reaches the bundle build.
      {
        id: "clawville",
        label: "ClawVille",
        description:
          "ClawVille game operator surface — agent controls and session management",
        icon: "Gamepad2",
        path: "/clawville",
        modalities: ["gui", "xr", "tui"],
        bundlePath: "dist/views/bundle.js",
        componentExport: "ClawvilleView",
        tags: ["game", "clawville"],
        visibleInManager: true,
        desktopTabEnabled: true,
      },
    ],
  };
}

export const appClawvillePlugin = createAppClawvillePlugin();

export default appClawvillePlugin;
export * from "./ui/index.js";

// In a terminal host (the Node agent, no DOM), register the ClawVille operator
// view so it renders inline in the terminal. Lazy + DOM-guarded so the terminal
// engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view.js")
    .then((m) => m.registerClawvilleTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
