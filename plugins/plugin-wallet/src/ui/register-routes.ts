/**
 * Side-effect module: registers the wallet UI plugin, shell pages, and bundled
 * chat sidebar widget with the application shell.
 *
 * Hosts that bundle @elizaos/plugin-wallet should load this module exactly once
 * at boot so registry entries are seeded before the shell mounts.
 */

import { registerAppRoutePluginLoader } from "@elizaos/core";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { registerBuiltinWidgets } from "@elizaos/ui/widgets";
// Keep route/widget metadata eager, but load the wallet views only when the
// user opens /crypto or /inventory. Both views reach the inventory dashboard
// through an `Escape` hatch, the spatial fallback.
import { walletAppPlugin } from "./plugin.ts";
import { WALLET_STATUS_WIDGET } from "./widgets/wallet-status.helpers.ts";

registerAppRoutePluginLoader(
  "@elizaos/plugin-wallet:ui",
  async () => walletAppPlugin,
);

registerAppShellPage({
  id: "wallet.terminal",
  agentViewId: "crypto-terminal",
  pluginId: "app-wallet",
  label: "Crypto Terminal",
  viewKind: "system",
  icon: "TrendingUp",
  path: "/crypto",
  tabAffinity: "inventory",
  group: "wallet",
  order: 60,
  surface: {
    background: "opaque",
    capabilities: [],
  },
  loader: () =>
    import("./CryptoTerminalView.tsx").then((module) => ({
      default: module.CryptoTerminalView,
    })),
});

registerAppShellPage({
  id: "wallet.inventory",
  agentViewId: "wallet",
  pluginId: "app-wallet",
  label: "Wallet",
  viewKind: "system",
  icon: "Wallet",
  path: "/inventory",
  tabAffinity: "inventory",
  group: "wallet",
  order: 50,
  surface: {
    background: "opaque",
    capabilities: [],
  },
  loader: () =>
    import("./InventoryView.tsx").then((module) => ({
      default: module.InventoryView,
    })),
});

registerBuiltinWidgets([WALLET_STATUS_WIDGET]);
