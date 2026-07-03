/**
 * `walletAppPlugin` — the plugin descriptor registering the wallet inventory
 * shell page, the shared GUI/XR/TUI wallet view, and the chat-sidebar wallet
 * status widget.
 */
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
        tabAffinity: "inventory",
        group: "wallet",
        order: 50,
        componentExport: "@elizaos/plugin-wallet-ui#InventoryView",
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
      relatedActions: [
        "WALLET",
        "EVM_SWAP",
        "EVM_TRANSFER",
        "SOLANA_SWAP",
        "SOLANA_TRANSFER",
        "CROSS_CHAIN_TRANSFER",
        "BIRDEYE_WALLET_PORTFOLIO",
      ],
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
