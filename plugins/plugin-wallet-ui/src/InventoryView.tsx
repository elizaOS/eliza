/**
 * InventoryView — the single registered component for the wallet surface across
 * GUI, XR, and TUI.
 *
 * It renders a {@link SpatialSurface} wrapping an {@link Escape} hatch:
 *
 *   - GUI / XR — `Escape` renders its real DOM children, the full multi-panel
 *     {@link InventoryAppView} dashboard (holdings rail, P&L chart, activity log,
 *     movers, LP positions, NFT grid).
 *   - TUI      — `Escape` never renders the DOM children (they can't run in a
 *     terminal); the spatial-primitive `tui` fallback ({@link InventorySpatialView})
 *     is emitted instead. The agent terminal mounts the same `InventorySpatialView`
 *     directly through the terminal registry (see `register-terminal-view.tsx`).
 *
 * The wrapper still owns the live wallet data (balances, NFTs, trading profile,
 * addresses, config) drawn from the app store + `useInventoryData` and builds the
 * presentational {@link WalletSnapshot} that feeds the `tui` fallback. There is
 * one componentExport (`InventoryView`); the rich dashboard is reached only
 * through this wrapper, never registered as a separate app/nav tab.
 */

import { client } from "@elizaos/ui/api";
import { useActivityEvents } from "@elizaos/ui/hooks";
import { Escape, SpatialSurface } from "@elizaos/ui/spatial";
import type { InventoryChainFilters } from "@elizaos/ui/state";
import { useAppSelectorShallow } from "@elizaos/ui/state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InventoryAppView } from "./components/InventoryAppView.tsx";
import {
  InventorySpatialView,
  type WalletSnapshot,
} from "./components/InventorySpatialView.tsx";
import { resolveWalletAddresses } from "./InventoryView.helpers.ts";
import { formatBalance, type TokenRow } from "./inventory/constants.ts";
import { useInventoryData } from "./inventory/useInventoryData.ts";

const ALL_INVENTORY_FILTERS: InventoryChainFilters = {
  ethereum: true,
  base: true,
  bsc: true,
  avax: true,
  solana: true,
};
const HIDDEN_TOKEN_IDS_KEY = "eliza:wallet:hidden-token-ids:v1";
const WALLET_REFRESH_INTERVAL_MS = 20_000;

function readHiddenTokenIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const raw = window.localStorage.getItem(HIDDEN_TOKEN_IDS_KEY);
  if (!raw) return new Set();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return new Set();
  return new Set(
    parsed.filter((item): item is string => typeof item === "string"),
  );
}

function writeHiddenTokenIds(next: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(HIDDEN_TOKEN_IDS_KEY, JSON.stringify([...next]));
}

function tokenId(row: TokenRow): string {
  const address =
    row.contractAddress && row.contractAddress.length > 0
      ? row.contractAddress.toLowerCase()
      : `native:${row.symbol.toLowerCase()}`;
  return `${row.chain.toLowerCase()}:${address}`;
}

function tokenHasInventory(row: TokenRow): boolean {
  return row.balanceRaw > 0 || row.valueUsd > 0;
}

function parseAmount(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function copyToClipboard(value: string | null): void {
  if (!value || typeof navigator === "undefined" || !navigator.clipboard) {
    return;
  }
  void navigator.clipboard.writeText(value);
}

function openRpcSettings(setTab: (tab: string) => void): void {
  setTab("settings");
  if (typeof window !== "undefined") {
    window.location.hash = "wallet-rpc";
  }
}

export function InventoryView() {
  const {
    walletEnabled,
    walletAddresses,
    walletConfig,
    walletBalances,
    walletNfts,
    loadWalletConfig,
    loadBalances,
    loadNfts,
    setState,
    setTab,
    setActionNotice,
  } = useAppSelectorShallow((s) => ({
    walletEnabled: s.walletEnabled,
    walletAddresses: s.walletAddresses,
    walletConfig: s.walletConfig,
    walletBalances: s.walletBalances,
    walletNfts: s.walletNfts,
    loadWalletConfig: s.loadWalletConfig,
    loadBalances: s.loadBalances,
    loadNfts: s.loadNfts,
    setState: s.setState,
    setTab: s.setTab,
    setActionNotice: s.setActionNotice,
  }));
  const { events: activityEvents } = useActivityEvents();
  void activityEvents;

  const [hiddenTokenIds, setHiddenTokenIds] = useState<Set<string>>(() =>
    readHiddenTokenIds(),
  );
  const [realizedPnlBnb, setRealizedPnlBnb] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const initialLoadRef = useRef(false);

  const loadTradingProfile = useCallback(async () => {
    const profile = await client.getWalletTradingProfile("30d");
    setRealizedPnlBnb(parseAmount(profile.summary.realizedPnlBnb));
  }, []);

  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    void loadWalletConfig();
    if (walletEnabled === false) return;
    void loadBalances();
    void loadNfts();
    void loadTradingProfile();
  }, [
    loadBalances,
    loadNfts,
    loadTradingProfile,
    loadWalletConfig,
    walletEnabled,
  ]);

  useEffect(() => {
    if (walletEnabled === false) return;
    const interval = window.setInterval(() => {
      void loadWalletConfig();
      void loadBalances();
      void loadNfts();
      void loadTradingProfile();
    }, WALLET_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadBalances, loadNfts, loadTradingProfile, loadWalletConfig, walletEnabled]);

  const inventoryData = useInventoryData({
    walletBalances,
    walletAddresses,
    walletConfig,
    walletNfts,
    inventorySort: "value",
    inventorySortDirection: "desc",
    inventoryChainFilters: ALL_INVENTORY_FILTERS,
  });

  const addresses = useMemo(
    () => resolveWalletAddresses({ walletAddresses, walletConfig }),
    [walletAddresses, walletConfig],
  );

  const visibleRows = useMemo(
    () =>
      inventoryData.tokenRowsAllChains
        .filter(tokenHasInventory)
        .filter((row) => !hiddenTokenIds.has(tokenId(row))),
    [hiddenTokenIds, inventoryData.tokenRowsAllChains],
  );

  const snapshot: WalletSnapshot = useMemo(() => {
    const selectedRpcProviders = walletConfig?.selectedRpcProviders
      ? Object.values(walletConfig.selectedRpcProviders).filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return {
      portfolioValueUsd: visibleRows.reduce((sum, row) => sum + row.valueUsd, 0),
      tokenRows: visibleRows.map((row) => ({
        id: tokenId(row),
        symbol: row.symbol,
        chain: row.chain,
        balance: formatBalance(row.balance),
        valueUsd: row.valueUsd,
        contractAddress: row.contractAddress,
        logoUrl: row.logoUrl,
      })),
      walletNfts: inventoryData.allNfts.map((nft) => ({
        id: `${nft.chain}:${nft.collectionName}:${nft.name}`,
        chain: nft.chain,
        collectionName: nft.collectionName,
        name: nft.name,
        imageUrl: nft.imageUrl,
      })),
      marketMovers: [],
      tradingProfile: { realizedPnlBnb, recentSwaps: [] },
      addresses,
      config: {
        evmBalanceReady: Boolean(walletConfig?.evmBalanceReady),
        solanaBalanceReady: Boolean(walletConfig?.solanaBalanceReady),
        selectedRpcProviders: [...new Set(selectedRpcProviders)],
      },
      walletEnabled,
      error,
    };
  }, [
    addresses,
    error,
    inventoryData.allNfts,
    realizedPnlBnb,
    visibleRows,
    walletConfig,
    walletEnabled,
  ]);

  const hideToken = useCallback(
    (id: string) => {
      const row = visibleRows.find((candidate) => tokenId(candidate) === id);
      const next = new Set(hiddenTokenIds);
      next.add(id);
      setHiddenTokenIds(next);
      writeHiddenTokenIds(next);
      if (row) setActionNotice(`${row.symbol} hidden from this wallet view.`);
    },
    [hiddenTokenIds, setActionNotice, visibleRows],
  );

  const refresh = useCallback(() => {
    setError(null);
    void loadWalletConfig();
    void loadBalances();
    void loadNfts();
    void loadTradingProfile();
  }, [loadBalances, loadNfts, loadTradingProfile, loadWalletConfig]);

  const enableWallet = useCallback(() => {
    setState("walletEnabled", true);
    void loadWalletConfig();
    void loadBalances();
    void loadNfts();
  }, [loadBalances, loadNfts, loadWalletConfig, setState]);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("hide-token:")) {
        hideToken(action.slice("hide-token:".length));
        return;
      }
      if (action.startsWith("open-token:")) {
        setTab("settings");
        return;
      }
      if (action.startsWith("tab:")) return;
      switch (action) {
        case "refresh":
          refresh();
          return;
        case "enable-wallet":
          enableWallet();
          return;
        case "rpc-settings":
          openRpcSettings(setTab);
          return;
        case "copy-evm":
          copyToClipboard(addresses.evmAddress);
          return;
        case "copy-solana":
          copyToClipboard(addresses.solanaAddress);
          return;
      }
    },
    [addresses, enableWallet, hideToken, refresh, setTab],
  );

  return (
    <SpatialSurface>
      <Escape
        tui={<InventorySpatialView snapshot={snapshot} onAction={onAction} />}
      >
        <InventoryAppView />
      </Escape>
    </SpatialSurface>
  );
}
