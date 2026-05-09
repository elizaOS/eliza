import type { Plugin } from "@elizaos/core";

export const walletAppPlugin: Plugin = {
  name: "@elizaos/app-wallet",
  description: "Non-custodial wallet inventory UI",
  app: {
    displayName: "Wallet",
    category: "wallet",
    icon: "Wallet",
    visibleInAppStore: true,
    developerOnly: false,
    navTabs: [
      {
        id: "wallet.inventory",
        label: "Wallet",
        icon: "Wallet",
        path: "/inventory",
        order: 50,
        componentExport: "@elizaos/app-wallet#InventoryView",
      },
    ],
  },
  widgets: [
    {
      id: "wallet.status",
      pluginId: "app-wallet",
      slot: "chat-sidebar",
      label: "Wallet Status",
      icon: "Wallet",
      order: 80,
      defaultEnabled: true,
    },
  ],
};
