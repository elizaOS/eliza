/**
 * `walletAppPlugin` — the plugin descriptor registering wallet and crypto
 * terminal shell surfaces plus the chat-sidebar wallet status widget.
 */
import type { Plugin } from "@elizaos/core";

export const walletAppPlugin: Plugin = {
  name: "@elizaos/plugin-wallet:ui",
  packageName: "@elizaos/plugin-wallet",
  description: "Non-custodial wallet and crypto terminal UI",
  app: {
    displayName: "Wallet",
    category: "wallet",
    icon: "Wallet",
    visibleInAppStore: true,
    viewKind: "system",
    developerOnly: false,
    navTabs: [
      {
        id: "wallet.terminal",
        viewKind: "system",
        label: "Crypto Terminal",
        icon: "TrendingUp",
        path: "/crypto",
        tabAffinity: "inventory",
        group: "wallet",
        order: 60,
        surface: {
          background: "opaque",
          capabilities: [],
        },
        componentExport: "@elizaos/plugin-wallet/ui#CryptoTerminalView",
      },
      {
        id: "wallet.inventory",
        viewKind: "system",
        label: "Wallet",
        icon: "Wallet",
        path: "/inventory",
        tabAffinity: "inventory",
        group: "wallet",
        order: 50,
        surface: {
          background: "opaque",
          capabilities: [],
        },
        componentExport: "@elizaos/plugin-wallet/ui#InventoryView",
      },
    ],
  },
  views: [
    {
      id: "crypto-terminal",
      viewKind: "system",
      label: "Crypto Terminal",
      description:
        "Unified portfolio, market intelligence, and confirmation-gated crypto execution surface",
      icon: "TrendingUp",
      path: "/crypto",
      responseContext: { primaryContext: "crypto" },
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      surface: {
        background: "opaque",
        capabilities: ["agent-surface"],
      },
      componentExport: "CryptoTerminalView",
      tags: ["finance", "crypto", "trading", "wallet"],
      anticipatoryIntent:
        "Surface portfolio state, market context, trading readiness, and risk-aware next actions without bypassing human confirmation.",
      relatedActions: [
        "WALLET",
        "TRADE",
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
    {
      id: "wallet",
      viewKind: "system",
      label: "Wallet",
      description: "Non-custodial wallet inventory and token balances",
      icon: "Wallet",
      path: "/wallet",
      responseContext: { primaryContext: "wallet" },
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: {
        background: "opaque",
        capabilities: ["agent-surface"],
      },
      componentExport: "InventoryView",
      tags: ["finance", "crypto", "wallet"],
      anticipatoryIntent:
        "Offer a portfolio summary and a fund/swap next step, grounded in balances, readiness, and recent wallet activity.",
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
