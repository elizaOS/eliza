import type {
  EvmChainBalance,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
} from "@elizaos/shared/contracts/wallet";
import { useMemo } from "react";
import type { InventoryChainFilters } from "../../state/types";
import {
  CHAIN_CONFIGS,
  type ChainKey,
  PRIMARY_CHAIN_KEYS,
  resolveChainKey,
} from "./chainConfig";
import {
  isBscChainName,
  type NftItem,
  type TokenRow,
  type TrackedBscToken,
  type TrackedToken,
  toNormalizedAddress,
} from "./constants";
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
  trackedBscTokens: TrackedBscToken[];
  trackedTokens: TrackedToken[];
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

function hasContractAddress(
  row: TokenRow,
): row is TokenRow & { contractAddress: string } {
  return typeof row.contractAddress === "string";
}

function hasVisibleBalance(row: TokenRow): boolean {
  // Always show manually tracked tokens
  if (row.isTracked) return true;
  // Require at least $0.01 USD value to avoid dust rows (e.g. AVAX $0.00)
  if (row.valueUsd >= 0.01) return true;
  // Show native gas tokens with a meaningful raw balance even without USD pricing
  if (row.isNative && row.balanceRaw >= 0.0001) return true;
  return false;
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
  trackedBscTokens,
  trackedTokens,
}: {
  walletBalances: WalletBalancesResponse | null;
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
  trackedBscTokens: TrackedBscToken[];
  trackedTokens: TrackedToken[];
}): TokenRow[] {
  const rows: TokenRow[] = [];
  const knownEvmAddr = walletAddresses?.evmAddress ?? walletConfig?.evmAddress;
  const knownSolAddr =
    walletAddresses?.solanaAddress ?? walletConfig?.solanaAddress;

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
          isTracked: false,
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
  if (knownSolAddr && !walletBalances?.solana) {
    rows.push({
      chain: "Solana",
      symbol: "SOL",
      name: "Solana native",
      contractAddress: null,
      logoUrl: null,
      balance: "0",
      valueUsd: 0,
      balanceRaw: 0,
      isNative: true,
    });
  }

  const knownBscContracts = new Set(
    rows
      .filter(
        (row): row is TokenRow & { contractAddress: string } =>
          isBscChainName(row.chain) && hasContractAddress(row),
      )
      .map((row) => toNormalizedAddress(row.contractAddress)),
  );
  for (const tracked of trackedBscTokens) {
    const normalized = toNormalizedAddress(tracked.contractAddress);
    if (knownBscContracts.has(normalized)) continue;
    rows.push({
      chain: "BSC",
      symbol: tracked.symbol,
      name: tracked.name,
      contractAddress: tracked.contractAddress,
      logoUrl: tracked.logoUrl ?? null,
      balance: "0",
      valueUsd: 0,
      balanceRaw: 0,
      isNative: false,
      isTracked: true,
    });
  }
  for (const tracked of trackedTokens) {
    const exists = rows.some(
      (r) => r.contractAddress?.toLowerCase() === tracked.address.toLowerCase(),
    );
    if (!exists) {
      rows.push({
        chain: "BSC",
        symbol: `TKN-${tracked.address.slice(2, 6)}`,
        name: tracked.symbol || `Token ${tracked.address.slice(0, 10)}...`,
        contractAddress: tracked.address,
        logoUrl: null,
        balance: "0",
        valueUsd: 0,
        balanceRaw: 0,
        isNative: false,
        isTracked: true,
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
  trackedBscTokens,
  trackedTokens,
}: InventoryDataInput): InventoryDataOutput {
  const singleChainFocus = useMemo(
    () => computeSingleChainFocus(inventoryChainFilters),
    [inventoryChainFilters],
  );
  const knownEvmAddr = walletAddresses?.evmAddress ?? walletConfig?.evmAddress;
  const knownSolAddr =
    walletAddresses?.solanaAddress ?? walletConfig?.solanaAddress;

  // ── Legacy BSC aliases ─────────────────────────────────────────────
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
        trackedBscTokens,
        trackedTokens,
      }),
    [
      walletBalances,
      walletAddresses,
      walletConfig,
      trackedBscTokens,
      trackedTokens,
    ],
  );

  const tokenRows = useMemo(
    () =>
      tokenRowsAllChains.filter((row) =>
        matchesInventoryChainFilter(row.chain, inventoryChainFilters),
      ),
    [tokenRowsAllChains, inventoryChainFilters],
  );

  // ── Sort ──────────────────────────────────────────────────────────
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

  // ── Chain errors ──────────────────────────────────────────────────
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

  // ── Flatten NFTs ──────────────────────────────────────────────────
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

  // ── Derived values ────────────────────────────────────────────────
  const focusedChain = useMemo(() => {
    if (!singleChainFocus) return null;
    if (singleChainFocus === "solana") {
      return {
        name: CHAIN_CONFIGS.solana.name,
        nativeSymbol: CHAIN_CONFIGS.solana.nativeSymbol,
        nativeBalance:
          walletBalances?.solana?.solBalance ?? (knownSolAddr ? "0" : null),
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
  }, [singleChainFocus, knownEvmAddr, knownSolAddr, walletBalances]);

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
