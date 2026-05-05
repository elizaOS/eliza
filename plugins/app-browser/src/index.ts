import { gatePluginSessionForHostedApp } from "@elizaos/agent";
import type { Plugin } from "@elizaos/core";
import { manageElizaBrowserWorkspaceAction } from "./action";
import { appBrowserWorkspaceProvider } from "./provider";
import { browserWorkspaceRoutes } from "./setup-routes";
import { AppBrowserWorkspaceService } from "./service";

const rawAppBrowserPlugin: Plugin = {
  name: "@elizaos/app-browser",
  description:
    "Controls Eliza browser workspace tabs across the desktop bridge and web iframe workspace.",
  actions: [manageElizaBrowserWorkspaceAction],
  providers: [appBrowserWorkspaceProvider],
  services: [AppBrowserWorkspaceService],
  routes: browserWorkspaceRoutes,
};

export const appBrowserPlugin: Plugin = gatePluginSessionForHostedApp(
  rawAppBrowserPlugin,
  "@elizaos/app-browser",
);

export {
  AppBrowserWorkspaceService,
  appBrowserWorkspaceProvider,
  manageElizaBrowserWorkspaceAction,
};

export default appBrowserPlugin;
