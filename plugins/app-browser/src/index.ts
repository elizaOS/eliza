import type { Plugin } from "@elizaos/core";
import { manageMiladyBrowserWorkspaceAction } from "./action";
import { appBrowserWorkspaceProvider } from "./provider";
import { AppBrowserWorkspaceService } from "./service";
import {
  approveMiladyWalletRequestAction,
  rejectMiladyWalletRequestAction,
  signWithMiladyWalletAction,
} from "./wallet-action";

export const appBrowserPlugin: Plugin = {
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

export {
  approveMiladyWalletRequestAction,
  AppBrowserWorkspaceService,
  appBrowserWorkspaceProvider,
  manageMiladyBrowserWorkspaceAction,
  rejectMiladyWalletRequestAction,
  signWithMiladyWalletAction,
};

export default appBrowserPlugin;
