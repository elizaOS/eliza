import {
	type OverlayApp,
	registerOverlayApp,
} from "@elizaos/app-core/ui-compat";

export const HYPERLIQUID_APP_NAME = "@elizaos/plugin-hyperliquid-app";

export const hyperliquidApp: OverlayApp = {
  name: HYPERLIQUID_APP_NAME,
  displayName: "Hyperliquid",
  description: "Native Hyperliquid market, position, and order status",
  category: "trading",
  icon: null,
  loader: () =>
    import("./HyperliquidAppView").then((m) => ({
      default: m.HyperliquidAppView,
    })),
};

registerOverlayApp(hyperliquidApp);
