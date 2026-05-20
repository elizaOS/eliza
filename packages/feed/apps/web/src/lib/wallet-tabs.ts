export type WalletTab = "balance" | "pnl" | "positions" | "deposit";

export const DEFAULT_WALLET_TAB: WalletTab = "positions";

export function parseWalletTab(tab: string | null | undefined): WalletTab {
  return tab === "balance" ||
    tab === "pnl" ||
    tab === "positions" ||
    tab === "deposit"
    ? tab
    : DEFAULT_WALLET_TAB;
}

export function getWalletTabHref(tab: WalletTab): string {
  return `/wallet?tab=${tab}`;
}
