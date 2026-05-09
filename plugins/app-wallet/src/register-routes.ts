/**
 * Side-effect module: registers the wallet UI plugin (route loader + bundled
 * shell page + bundled chat sidebar widget) with @elizaos/app-core.
 *
 * Hosts that bundle @elizaos/app-wallet should `import "@elizaos/app-wallet/register"`
 * (or just `import "@elizaos/app-wallet"`, which re-exports this side effect)
 * exactly once at boot so the registry entries are seeded before the shell
 * mounts.
 */

import { registerAppShellPage } from "@elizaos/app-core/app-shell-components";
import { registerAppRoutePluginLoader } from "@elizaos/core";
import { registerBuiltinWidgets } from "@elizaos/app-core/widgets/registry";
import { InventoryView } from "./InventoryView";
import { WALLET_STATUS_WIDGET } from "./widgets/wallet-status";

registerAppRoutePluginLoader("@elizaos/app-wallet", async () => {
  const { walletAppPlugin } = await import("./plugin");
  return walletAppPlugin;
});

registerAppShellPage({
  id: "wallet.inventory",
  pluginId: "app-wallet",
  label: "Wallet",
  icon: "Wallet",
  path: "/inventory",
  order: 50,
  Component: InventoryView,
});

registerBuiltinWidgets([WALLET_STATUS_WIDGET]);
