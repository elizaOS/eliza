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
    {
      id: "screenshare",
      label: "Screen Share",
      description: "Remote desktop streaming and operator control surface",
      icon: "Monitor",
      path: "/screenshare",
      bundlePath: "dist/views/bundle.js",
      componentExport: "ScreenshareOperatorSurface",
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
export * from "./ui/index.js";
