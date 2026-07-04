/**
 * Side-effect module: registers the wallet UI plugin (route loader + bundled
 * shell page + bundled chat sidebar widget) with @elizaos/app-core.
 *
 * Hosts that bundle @elizaos/plugin-wallet-ui should load this module exactly once
 * at boot so the registry entries are seeded before the shell mounts.
 */

import { registerAppRoutePluginLoader } from "@elizaos/core";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { registerBuiltinWidgets } from "@elizaos/ui/widgets";
// Keep route/widget metadata eager, but load the unified wallet view only when
// the user opens /inventory. The view is the single `InventoryView` wrapper; in
// GUI/XR its `Escape` hatch renders the full inventory dashboard, in TUI the
// spatial fallback.
import { walletAppPlugin } from "./plugin.ts";
import { WALLET_STATUS_WIDGET } from "./widgets/wallet-status.helpers.ts";

registerAppRoutePluginLoader(
  "@elizaos/plugin-wallet-ui",
  async () => walletAppPlugin,
);

registerAppShellPage({
  id: "wallet.inventory",
  pluginId: "app-wallet",
  label: "Wallet",
  viewKind: "system",
  icon: "Wallet",
  path: "/inventory",
  tabAffinity: "inventory",
  group: "wallet",
  order: 50,
  loader: () =>
    import("./InventoryView.tsx").then((module) => ({
      default: module.InventoryView,
    })),
});

registerBuiltinWidgets([WALLET_STATUS_WIDGET]);
