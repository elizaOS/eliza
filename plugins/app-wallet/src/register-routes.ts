/**
 * Side-effect module: registers the wallet UI plugin (route loader + bundled
 * shell page + bundled chat sidebar widget) with @elizaos/app-core.
 *
 * Hosts that bundle @elizaos/app-wallet should load this module exactly once
 * at boot so the registry entries are seeded before the shell mounts.
 */

import { registerAppRoutePluginLoader } from "@elizaos/core";
import { registerAppShellPage, registerBuiltinWidgets } from "@elizaos/ui";
import { InventoryView } from "./InventoryView";

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

queueMicrotask(async () => {
  try {
    const { WALLET_STATUS_WIDGET } = await import("./widgets/wallet-status");
    registerBuiltinWidgets([WALLET_STATUS_WIDGET]);
  } catch {
    // Widget registration is best-effort; route registration above is the critical path.
  }
});
