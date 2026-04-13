import type { Plugin } from "@elizaos/core";
import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import { manageMiladyBrowserWorkspaceAction } from "./action";
import { appBrowserWorkspaceProvider } from "./provider";
import { AppBrowserWorkspaceService } from "./service";
import {
  approveMiladyWalletRequestAction,
  rejectMiladyWalletRequestAction,
  signWithMiladyWalletAction,
} from "./wallet-action";

const rawAppBrowserPlugin: Plugin = {
  name: "@elizaos/app-browser",
  description:
    "Controls Milady browser workspace tabs and Steward wallet signing requests across the desktop bridge and web iframe workspace.",
  actions: [
    manageMiladyBrowserWorkspaceAction,
    signWithMiladyWalletAction,
    approveMiladyWalletRequestAction,
    rejectMiladyWalletRequestAction,
  ],
  providers: [appBrowserWorkspaceProvider],
  services: [AppBrowserWorkspaceService],
};

export const appBrowserPlugin: Plugin = gatePluginSessionForHostedApp(
  rawAppBrowserPlugin,
  "@elizaos/app-browser",
);

export {
  approveMiladyWalletRequestAction,
  AppBrowserWorkspaceService,
  appBrowserWorkspaceProvider,
  manageMiladyBrowserWorkspaceAction,
  rejectMiladyWalletRequestAction,
  signWithMiladyWalletAction,
};

export default appBrowserPlugin;
