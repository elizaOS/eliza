// The `ChatSidebarWidgetDefinition` registration value for the wallet status
// widget. Kept out of wallet-status.tsx so that file exports only React
// components and stays Fast-Refresh-compatible in dev.

import type { ChatSidebarWidgetDefinition } from "@elizaos/ui/components";
import { WalletStatusSidebarWidget } from "./wallet-status.tsx";

export const WALLET_STATUS_WIDGET: ChatSidebarWidgetDefinition = {
  id: "wallet.status",
  pluginId: "wallet",
  order: 70,
  defaultEnabled: true,
  Component: WalletStatusSidebarWidget,
};
