import type { OverlayApp } from "@elizaos/app-core";
import { registerOverlayApp } from "@elizaos/app-core";

export const SWAP_APP_NAME = "@elizaos/plugin-waifu-swap-app";

/**
 * Overlay-app registration for the waifu swap view. The loader is lazy so the
 * view's component tree (and its swap capability client) is only fetched when
 * the window mounts — keeping it out of the main + mobile entry chunks.
 */
export const swapApp: OverlayApp = {
  name: SWAP_APP_NAME,
  displayName: "Swap",
  description:
    "Swap tokens through PancakeSwap v3 — quote, slippage control, and route detail",
  category: "trading",
  icon: null,
  loader: () =>
    import("./SwapAppView").then((m) => ({
      default: m.SwapAppView,
    })),
};

registerOverlayApp(swapApp);
