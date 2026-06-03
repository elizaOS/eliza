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
import { InventoryView } from "./InventoryView.tsx";
// These were previously dynamic imports, but `./index.ts` re-exports both as
// static bindings so the dynamic import never produced a separate chunk
// (INEFFECTIVE_DYNAMIC_IMPORT). Collapse to static imports to silence the
// warning; bundle size is unchanged because the static path was already used.
import { walletAppPlugin } from "./plugin.ts";
import { WALLET_STATUS_WIDGET } from "./widgets/wallet-status.tsx";

registerAppRoutePluginLoader(
  "@elizaos/plugin-wallet-ui",
  async () => walletAppPlugin,
);

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
