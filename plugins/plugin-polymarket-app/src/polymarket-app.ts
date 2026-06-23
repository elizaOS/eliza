import {
	type OverlayApp,
	registerOverlayApp,
} from "@elizaos/app-core/ui-compat";

export const POLYMARKET_APP_NAME = "@elizaos/plugin-polymarket-app";

export const polymarketApp: OverlayApp = {
  name: POLYMARKET_APP_NAME,
  displayName: "Polymarket",
  description: "Browse Polymarket markets and inspect native trading readiness",
  category: "trading",
  icon: null,
  loader: () =>
    import("./PolymarketAppView").then((m) => ({
      default: m.PolymarketAppView,
    })),
};

registerOverlayApp(polymarketApp);
