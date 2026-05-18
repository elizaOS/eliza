import type { OverlayApp } from "@elizaos/app-core";
import { registerOverlayApp } from "@elizaos/app-core";

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
