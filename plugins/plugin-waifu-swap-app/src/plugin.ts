import type { Plugin } from "@elizaos/core";

/**
 * Waifu swap app-plugin.
 *
 * Pure frontend AppView: it ships a single GUI view that renders inside an
 * agent's ElizaOS web UI canvas and drives the PancakeSwap v3 swap capability on
 * the waifu.fun API (the generic capability-action route). It replaces the
 * broken waifu patron swap panel with a first-class app-plugin view. No agent
 * routes/actions/services — the backend already lives on the waifu API.
 *
 * Today the view is quote-only: the displayed quote comes from a transparent
 * local estimate (opportunistically upgraded with the backend `quote` action),
 * and on-chain execution is intentionally stubbed until the backend
 * `pancakeswap-v3:swap` handler + agent signer land (SWAP_EXECUTE_TODO).
 *
 * The `views` array is the discovery + launch contract read by
 * plugin-app-manager: it points at the third-partyized view bundle
 * (`dist/views/bundle.js`) and the `SwapAppView` component export, and marks
 * the view visible in the app manager and as a desktop tab.
 */
export const waifuSwapPlugin: Plugin = {
  name: "@elizaos/plugin-waifu-swap-app",
  description:
    "Native token-swap AppView for waifu agents — PancakeSwap v3 quote, slippage control, route detail, and a guarded swap action",
  views: [
    {
      id: "waifu-swap",
      label: "Swap",
      description:
        "Swap tokens through PancakeSwap v3 with live quotes and route detail",
      icon: "ArrowLeftRight",
      heroImagePath: "assets/hero.png",
      path: "/waifu-swap",
      bundlePath: "dist/views/bundle.js",
      componentExport: "SwapAppView",
      tags: ["trading", "swap", "waifu", "pancakeswap"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "waifu-swap",
      label: "Swap XR",
      description:
        "Swap tokens through PancakeSwap v3 with live quotes and route detail",
      icon: "ArrowLeftRight",
      heroImagePath: "assets/hero.png",
      path: "/waifu-swap",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "SwapAppView",
      tags: ["trading", "swap", "waifu", "pancakeswap"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};
