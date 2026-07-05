import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import type { Plugin } from "@elizaos/core";
import {
  handleAppRoutes,
  prepareLaunch,
  refreshRunSession,
  resolveLaunchSession,
  stopRun,
} from "./routes.js";
import {
  SCREENSHARE_APP_NAME,
  SCREENSHARE_DISPLAY_NAME,
} from "./session-store.js";

const rawScreensharePlugin: Plugin = {
  name: SCREENSHARE_APP_NAME,
  description:
    "Streams the local desktop and accepts authenticated mouse and keyboard control from the Screen Share app.",
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single
    // ScreenshareView spatial source. `modalities` is a plain literal here
    // (index.ts is not in the view bundle), so no brand-new `@elizaos/core`
    // runtime export reaches the bundle build.
    {
      id: "screenshare",
      label: "Screen Share",
      description: "Remote desktop streaming and operator control surface",
      icon: "Monitor",
      path: "/screenshare",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "ScreenshareView",
      tags: ["screenshare", "remote", "desktop"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export const screensharePlugin = gatePluginSessionForHostedApp(
  rawScreensharePlugin,
  SCREENSHARE_APP_NAME,
);

export {
  handleAppRoutes,
  prepareLaunch,
  refreshRunSession,
  resolveLaunchSession,
  SCREENSHARE_APP_NAME,
  SCREENSHARE_DISPLAY_NAME,
  stopRun,
};

export default screensharePlugin;
export * from "./routes.js";

// In a terminal host (the Node agent, no DOM), register the screen-share view
// so it renders inline in the terminal. Lazy + DOM-guarded so the terminal
// engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view.js")
    .then((m) => m.registerScreenshareTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
