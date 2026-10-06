import { registerAppRoutePluginLoader } from "@elizaos/host/protocol";
import { registerAppShellPage, registerBuiltinWidgets } from "@elizaos/ui";
import { walletAppPlugin } from "./ui/plugin.ts";
import { WALLET_STATUS_WIDGET } from "./ui/widgets/wallet-status.helpers.ts";

export { getExplorerTokenUrl } from "./ui/inventory/chainConfig.ts";
export {
  BSC_GAS_READY_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
} from "./ui/inventory/constants.ts";

export function registerApp(): void {
  registerAppRoutePluginLoader(
    "@elizaos/plugin-wallet:ui",
    async () => walletAppPlugin,
  );

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
      import("./ui/InventoryView.tsx").then((module) => ({
        default: module.InventoryView,
      })),
  });

  registerBuiltinWidgets([WALLET_STATUS_WIDGET]);
}
