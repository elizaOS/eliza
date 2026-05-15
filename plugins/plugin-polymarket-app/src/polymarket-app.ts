import type { OverlayApp } from "@elizaos/app-core";
import { registerOverlayApp } from "@elizaos/app-core";
import { PolymarketAppView } from "./PolymarketAppView";

export const POLYMARKET_APP_NAME = "@elizaos/app-polymarket";

export const polymarketApp: OverlayApp = {
  name: POLYMARKET_APP_NAME,
  displayName: "Polymarket",
  description: "Browse Polymarket markets and inspect native trading readiness",
  category: "trading",
  icon: null,
  Component: PolymarketAppView,
};

registerOverlayApp(polymarketApp);
