/**
 * Vincent App — @elizaos/app-vincent
 *
 * Full-screen overlay app for DeFi vault management and autotrading
 * via Vincent (https://heyvincent.ai). Follows the same OverlayApp
 * registration pattern as the Companion app.
 */

import type { OverlayApp } from "@elizaos/app-core";
import { registerOverlayApp } from "@elizaos/app-core";
import { VincentAppView } from "./VincentAppView";

export const VINCENT_APP_NAME = "@elizaos/app-vincent";

export const vincentApp: OverlayApp = {
  name: VINCENT_APP_NAME,
  displayName: "Vincent",
  description: "DeFi vault management and autotrading",
  category: "utility",
  icon: null,
  Component: VincentAppView,
};

// Self-register at import time
registerOverlayApp(vincentApp);
