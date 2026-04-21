import type { Plugin } from "@elizaos/core";
import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import { manageElizaBrowserWorkspaceAction } from "./action";
import { appBrowserWorkspaceProvider } from "./provider";
import { AppBrowserWorkspaceService } from "./service";
import {
  approveElizaWalletRequestAction,
  rejectElizaWalletRequestAction,
  signWithElizaWalletAction,
} from "./wallet-action";

const rawAppBrowserPlugin: Plugin = {
  name: "@elizaos/app-browser",
  description:
    "Controls Eliza browser workspace tabs and Steward wallet signing requests across the desktop bridge and web iframe workspace.",
  actions: [
    manageElizaBrowserWorkspaceAction,
    signWithElizaWalletAction,
    approveElizaWalletRequestAction,
    rejectElizaWalletRequestAction,
  ],
  providers: [appBrowserWorkspaceProvider],
  services: [AppBrowserWorkspaceService],
};

export const appBrowserPlugin: Plugin = gatePluginSessionForHostedApp(
  rawAppBrowserPlugin,
  "@elizaos/app-browser",
);

export {
  approveElizaWalletRequestAction,
  AppBrowserWorkspaceService,
  appBrowserWorkspaceProvider,
  manageElizaBrowserWorkspaceAction,
  rejectElizaWalletRequestAction,
  signWithElizaWalletAction,
};

export default appBrowserPlugin;
