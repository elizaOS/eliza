import type {
  EvmChainBalance,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
} from "@elizaos/shared";
import { useMemo } from "react";
import type { InventoryChainFilters } from "@elizaos/ui";
import {
  CHAIN_CONFIGS,
  type ChainKey,
  PRIMARY_CHAIN_KEYS,
  resolveChainKey,
} from "./chainConfig";
import { isBscChainName, type NftItem, type TokenRow } from "./constants";
import {
  computeSingleChainFocus,
  matchesInventoryChainFilter,
  type PrimaryInventoryChainKey,
} from "./inventory-chain-filters";

export interface InventoryDataInput {
  walletBalances: WalletBalancesResponse | null;
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
  walletNfts: WalletNftsResponse | null;
  inventorySort: string;
  inventorySortDirection: "asc" | "desc";
  inventoryChainFilters: InventoryChainFilters;
}

export interface InventoryDataOutput {
  /** When exactly one chain toggle is on, that key; otherwise null. */
  singleChainFocus: PrimaryInventoryChainKey | null;
  tokenRows: TokenRow[];
  /** Unfiltered rows (for sidebar per-chain asset counts). */
  tokenRowsAllChains: TokenRow[];
  sortedRows: TokenRow[];
  chainErrors: EvmChainBalance[];
  focusChainHasError: boolean;
  allNfts: NftItem[];
  primaryChain: EvmChainBalance | null;
  primaryNativeBalanceNum: number;
  focusedRows: TokenRow[];
  visibleRows: TokenRow[];
  totalUsd: number;
  visibleChainErrors: EvmChainBalance[];
  focusedChainName: string | null;
  focusedChainError: string | null;
  focusedNativeBalance: string | null;
  focusedNativeSymbol: string | null;
  primaryChainError: string | null;
  primaryNativeBalance: string | null;
}

function hasVisibleBalance(row: TokenRow): boolean {
  return row.balanceRaw > 0 || row.valueUsd > 0;
}

function matchesSingleChainFocus(chainName: string, focus: ChainKey): boolean {
  const resolved = resolveChainKey(chainName);
  return resolved === focus;
}

/** Builds token rows as if every primary chain were included (before per-toggle filter). */
function buildTokenRowsAllChains({
  walletBalances,
  walletAddresses,
  walletConfig,
}: {
  walletBalances: WalletBalancesResponse | null;
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
}): TokenRow[] {
  const rows: TokenRow[] = [];
  const knownEvmAddr = walletAddresses?.evmAddress ?? walletConfig?.evmAddress;

  if (walletBalances?.evm) {
    const seenChainKeys = new Set<string>();
    for (const chain of walletBalances.evm.chains) {
      const chainKey = resolveChainKey(chain.chain);
      if (chainKey) seenChainKeys.add(chainKey);
      rows.push({
        chain: chain.chain,
        symbol: chain.nativeSymbol,
        name: `${chain.chain} native`,
        contractAddress: null,
        logoUrl: null,
        balance: chain.nativeBalance,
        valueUsd: Number.parseFloat(chain.nativeValueUsd) || 0,
        balanceRaw: Number.parseFloat(chain.nativeBalance) || 0,
        isNative: true,
      });
      if (chain.error) continue;
      for (const tk of chain.tokens) {
        rows.push({
          chain: chain.chain,
          symbol: tk.symbol,
          name: tk.name,
          contractAddress: tk.contractAddress ?? null,
          logoUrl: tk.logoUrl ?? null,
          balance: tk.balance,
          valueUsd: Number.parseFloat(tk.valueUsd) || 0,
          balanceRaw: Number.parseFloat(tk.balance) || 0,
          isNative: false,
        });
      }
    }
    if (knownEvmAddr) {
      for (const key of PRIMARY_CHAIN_KEYS) {
        if (key === "solana") continue;
        if (seenChainKeys.has(key)) continue;
        const cfg = CHAIN_CONFIGS[key];
        rows.unshift({
          chain: cfg.name,
          symbol: cfg.nativeSymbol,
          name: `${cfg.name} native`,
          contractAddress: null,
          logoUrl: null,
          balance: "0",
          valueUsd: 0,
          balanceRaw: 0,
          isNative: true,
        });
      }
    }
  } else if (knownEvmAddr) {
    for (const key of PRIMARY_CHAIN_KEYS) {
      if (key === "solana") continue;
      const cfg = CHAIN_CONFIGS[key];
      rows.push({
        chain: cfg.name,
        symbol: cfg.nativeSymbol,
        name: `${cfg.name} native`,
        contractAddress: null,
        logoUrl: null,
        balance: "0",
        valueUsd: 0,
        balanceRaw: 0,
        isNative: true,
      });
    }
  }

  if (walletBalances?.solana) {
    rows.push({
      chain: "Solana",
      symbol: "SOL",
      name: "Solana native",
      contractAddress: null,
      logoUrl: null,
      balance: walletBalances.solana.solBalance,
      valueUsd: Number.parseFloat(walletBalances.solana.solValueUsd) || 0,
      balanceRaw: Number.parseFloat(walletBalances.solana.solBalance) || 0,
      isNative: true,
    });
    for (const tk of walletBalances.solana.tokens) {
      rows.push({
        chain: "Solana",
        symbol: tk.symbol,
        name: tk.name,
        contractAddress: tk.mint ?? null,
        logoUrl: tk.logoUrl ?? null,
        balance: tk.balance,
        valueUsd: Number.parseFloat(tk.valueUsd) || 0,
        balanceRaw: Number.parseFloat(tk.balance) || 0,
        isNative: false,
      });
    }
  }
  return rows.filter(hasVisibleBalance);
}

export function useInventoryData({
  walletBalances,
  walletAddresses,
  walletConfig,
  walletNfts,
  inventorySort,
  inventorySortDirection,
  inventoryChainFilters,
}: InventoryDataInput): InventoryDataOutput {
  const singleChainFocus = useMemo(
    () => computeSingleChainFocus(inventoryChainFilters),
    [inventoryChainFilters],
  );
  const knownEvmAddr = walletAddresses?.evmAddress ?? walletConfig?.evmAddress;
  const _knownSolAddr =
    walletAddresses?.solanaAddress ?? walletConfig?.solanaAddress;

  const primaryChain = useMemo(() => {
    if (!walletBalances?.evm?.chains) return null;
    return (
      walletBalances.evm.chains.find((c: EvmChainBalance) =>
        isBscChainName(c.chain),
      ) ?? null
    );
  }, [walletBalances]);

  const primaryNativeBalanceNum = useMemo(() => {
    if (!primaryChain) return 0;
    return Number.parseFloat(primaryChain.nativeBalance) || 0;
  }, [primaryChain]);

  const tokenRowsAllChains = useMemo(
    () =>
      buildTokenRowsAllChains({
        walletBalances,
        walletAddresses,
        walletConfig,
      }),
    [walletBalances, walletAddresses, walletConfig],
  );

  const tokenRows = useMemo(
    () =>
      tokenRowsAllChains.filter((row) =>
        matchesInventoryChainFilter(row.chain, inventoryChainFilters),
      ),
    [tokenRowsAllChains, inventoryChainFilters],
  );

  const sortedRows = useMemo(() => {
    const sorted = [...tokenRows];
    const asc = inventorySortDirection === "asc";
    if (inventorySort === "value") {
      sorted.sort((a, b) => {
        const diff = a.valueUsd - b.valueUsd;
        if (diff !== 0) return asc ? diff : -diff;
        const diff2 = a.balanceRaw - b.balanceRaw;
        return asc ? diff2 : -diff2;
      });
    } else if (inventorySort === "chain") {
      sorted.sort((a, b) => {
        const c = a.chain.localeCompare(b.chain);
        if (c !== 0) return asc ? c : -c;
        const s = a.symbol.localeCompare(b.symbol);
        return asc ? s : -s;
      });
    } else if (inventorySort === "symbol") {
      sorted.sort((a, b) => {
        const s = a.symbol.localeCompare(b.symbol);
        if (s !== 0) return asc ? s : -s;
        const c = a.chain.localeCompare(b.chain);
        return asc ? c : -c;
      });
    }
    return sorted;
  }, [tokenRows, inventorySort, inventorySortDirection]);

  const chainErrors = useMemo(
    () =>
      (walletBalances?.evm?.chains ?? []).filter(
        (c: EvmChainBalance) => c.error,
      ),
    [walletBalances],
  );

  const focusChainHasError = useMemo(() => {
    return chainErrors.some((c) =>
      matchesInventoryChainFilter(c.chain, inventoryChainFilters),
    );
  }, [chainErrors, inventoryChainFilters]);

  const allNfts = useMemo((): NftItem[] => {
    if (!walletNfts) return [];
    const items: NftItem[] = [];
    for (const chainData of walletNfts.evm) {
      for (const nft of chainData.nfts) {
        items.push({
          chain: chainData.chain,
          name: nft.name,
          imageUrl: nft.imageUrl,
          collectionName: nft.collectionName || nft.tokenType,
        });
      }
    }
    if (walletNfts.solana) {
      for (const nft of walletNfts.solana.nfts) {
        items.push({
          chain: "Solana",
          name: nft.name,
          imageUrl: nft.imageUrl,
          collectionName: nft.collectionName,
        });
      }
    }
    const filtered = items.filter((nft) =>
      matchesInventoryChainFilter(nft.chain, inventoryChainFilters),
    );
    const sorted = [...filtered];
    const asc = inventorySortDirection === "asc";
    const normalizedSort = inventorySort === "value" ? "symbol" : inventorySort;

    if (normalizedSort === "chain") {
      sorted.sort((a, b) => {
        const chainDiff = a.chain.localeCompare(b.chain);
        if (chainDiff !== 0) return asc ? chainDiff : -chainDiff;
        const nameDiff = a.name.localeCompare(b.name);
        return asc ? nameDiff : -nameDiff;
      });
    } else {
      sorted.sort((a, b) => {
        const nameDiff = a.name.localeCompare(b.name);
        if (nameDiff !== 0) return asc ? nameDiff : -nameDiff;
        const chainDiff = a.chain.localeCompare(b.chain);
        return asc ? chainDiff : -chainDiff;
      });
    }

    return sorted;
  }, [
    walletNfts,
    inventoryChainFilters,
    inventorySort,
    inventorySortDirection,
  ]);

  const focusedChain = useMemo(() => {
    if (!singleChainFocus) return null;
    if (singleChainFocus === "solana") {
      return {
        name: CHAIN_CONFIGS.solana.name,
        nativeSymbol: CHAIN_CONFIGS.solana.nativeSymbol,
        nativeBalance: walletBalances?.solana?.solBalance ?? null,
        error: null,
      };
    }

    const chainConfig =
      CHAIN_CONFIGS[singleChainFocus as keyof typeof CHAIN_CONFIGS];
    const evmChain =
      walletBalances?.evm?.chains.find((chain) =>
        matchesSingleChainFocus(chain.chain, singleChainFocus),
      ) ?? null;

    if (!chainConfig && !evmChain) return null;

    return {
      name: evmChain?.chain ?? chainConfig?.name ?? singleChainFocus,
      nativeSymbol: evmChain?.nativeSymbol ?? chainConfig?.nativeSymbol ?? null,
      nativeBalance: evmChain?.nativeBalance ?? (knownEvmAddr ? "0" : null),
      error: evmChain?.error ?? null,
    };
  }, [singleChainFocus, knownEvmAddr, walletBalances]);

  const primaryChainError =
    primaryChain?.error ??
    chainErrors.find((chain) => isBscChainName(chain.chain))?.error ??
    null;
  const primaryNativeBalance: string | null =
    primaryChain?.nativeBalance ?? null;

  const focusedRows = sortedRows;
  const visibleRows = sortedRows;

  const totalUsd = useMemo(
    () => tokenRows.reduce((sum, r) => sum + r.valueUsd, 0),
    [tokenRows],
  );

  const visibleChainErrors = useMemo(() => {
    return chainErrors.filter((chain) =>
      matchesInventoryChainFilter(chain.chain, inventoryChainFilters),
    );
  }, [chainErrors, inventoryChainFilters]);

  return {
    singleChainFocus,
    tokenRows,
    tokenRowsAllChains,
    sortedRows,
    chainErrors,
    focusChainHasError,
    allNfts,
    primaryChain,
    primaryNativeBalanceNum,
    focusedRows,
    visibleRows,
    totalUsd,
    visibleChainErrors,
    focusedChainName: focusedChain?.name ?? null,
    focusedChainError: focusedChain?.error ?? null,
    focusedNativeBalance: focusedChain?.nativeBalance ?? null,
    focusedNativeSymbol: focusedChain?.nativeSymbol ?? null,
    primaryChainError,
    primaryNativeBalance,
  };
}
