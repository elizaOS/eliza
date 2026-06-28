import type { Plugin } from "@elizaos/core";

export const walletAppPlugin: Plugin = {
  name: "@elizaos/plugin-wallet-ui",
  description: "Non-custodial wallet inventory UI",
  app: {
    displayName: "Wallet",
    category: "wallet",
    icon: "Wallet",
    visibleInAppStore: true,
    viewKind: "system",
    developerOnly: false,
    navTabs: [
      {
        id: "wallet.inventory",
        viewKind: "system",
        label: "Wallet",
        icon: "Wallet",
        path: "/inventory",
        order: 50,
        componentExport: "@elizaos/plugin-wallet-ui#InventoryAppView",
      },
    ],
  },
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single InventoryView
    // spatial source. `modalities` is a plain literal here (plugin.ts is not in
    // the view bundle), so no brand-new `@elizaos/core` runtime export reaches
    // the bundle build.
    {
      id: "wallet",
      viewKind: "system",
      label: "Wallet",
      description: "Non-custodial wallet inventory and token balances",
      icon: "Wallet",
      path: "/wallet",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "InventoryView",
      tags: ["finance", "crypto", "wallet"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  widgets: [
    {
      id: "wallet.status",
      pluginId: "wallet",
      slot: "chat-sidebar",
      label: "Wallet Status",
      icon: "Wallet",
      order: 70,
      defaultEnabled: true,
    },
  ],
};
