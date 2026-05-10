/**
 * Vincent App — @elizaos/app-vincent
 *
 * Full-screen overlay app for Vincent Hyperliquid and Polymarket trading
 * access.
 */

import type { OverlayApp } from "@elizaos/ui";
import { registerOverlayApp } from "@elizaos/ui";
import { VincentAppView } from "./VincentAppView";

export const VINCENT_APP_NAME = "@elizaos/app-vincent";

export const vincentApp: OverlayApp = {
  name: VINCENT_APP_NAME,
  displayName: "Vincent",
  description: "Connect Vincent to trade on Hyperliquid and Polymarket",
  category: "trading",
  icon: null,
  Component: VincentAppView,
};

// Self-register at import time
registerOverlayApp(vincentApp);
