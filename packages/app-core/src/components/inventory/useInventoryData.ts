/**
 * Custom hook: derives token rows, sorted rows, NFT items,
 * chain errors, and chain-specific computed values from app state.
 *
 * Chain-aware: uses the chainConfig registry so that filtering,
 * fallback rows, and derived values work for any supported chain.
 */

import type {
  EvmChainBalance,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
} from "@elizaos/app-core/api";
import { useMemo } from "react";
import {
  CHAIN_CONFIGS,
  PRIMARY_CHAIN_KEYS,
  resolveChainKey,
} from "../chainConfig";
import {
  isBscChainName,
  type NftItem,
  type TokenRow,
  type TrackedBscToken,
  type TrackedToken,
  toNormalizedAddress,
} from "./constants";

export interface InventoryDataInput {
  walletBalances: WalletBalancesResponse | null;
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
  walletNfts: WalletNftsResponse | null;
  inventorySort: string;
  inventoryChainFocus: string | null;
  trackedBscTokens: TrackedBscToken[];
  trackedTokens: TrackedToken[];
}

export interface InventoryDataOutput {
  chainFocus: string;
  tokenRows: TokenRow[];
  sortedRows: TokenRow[];
  chainErrors: EvmChainBalance[];
  /** @deprecated Use focusChainHasError instead */
  bscHasError: boolean;
  focusChainHasError: boolean;
  allNfts: NftItem[];
  /** @deprecated Use primaryChain instead */
  bscChain: EvmChainBalance | null;
  primaryChain: EvmChainBalance | null;
  /** @deprecated Use primaryNativeBalance (number) instead */
  bnbBalance: number;
  primaryNativeBalanceNum: number;
  /** @deprecated Use focusedRows instead */
  bscRows: TokenRow[];
  focusedRows: TokenRow[];
  visibleRows: TokenRow[];
  totalUsd: number;
  visibleChainErrors: EvmChainBalance[];
  focusedChainName: string | null;
  focusedChainError: string | null;
  focusedNativeBalance: string | null;
  focusedNativeSymbol: string | null;
  /** @deprecated Use primaryChainError instead */
  bscChainError: string | null;
  primaryChainError: string | null;
  /** @deprecated Use primaryNativeBalance instead */
  bscNativeBalance: string | null;
  primaryNativeBalance: string | null;
}

/** Returns true if a chain name matches the given focus key using chainConfig. */
function matchesChainFocus(chainName: string, focus: string): boolean {
  if (focus === "all") return true;
  const resolved = resolveChainKey(chainName);
  return resolved === focus;
}

function hasContractAddress(
  row: TokenRow,
): row is TokenRow & { contractAddress: string } {
  return typeof row.contractAddress === "string";
}

function hasVisibleBalance(row: TokenRow): boolean {
  return Boolean(row.isTracked || row.balanceRaw > 0 || row.valueUsd > 0);
}

export function useInventoryData({
  walletBalances,
  walletAddresses,
  walletConfig,
  walletNfts,
  inventorySort,
  inventoryChainFocus,
  trackedBscTokens,
  trackedTokens,
}: InventoryDataInput): InventoryDataOutput {
  const chainFocus = inventoryChainFocus ?? "all";
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

  // ── Flatten token rows ────────────────────────────────────────────
  const tokenRows = useMemo((): TokenRow[] => {
    const rows: TokenRow[] = [];

    if (walletBalances?.evm) {
      const seenChainKeys = new Set<string>();
      for (const chain of walletBalances.evm.chains) {
        const chainKey = resolveChainKey(chain.chain);
        if (chainKey) seenChainKeys.add(chainKey);
        // Filter by chain focus when not "all"
        if (chainFocus !== "all" && !matchesChainFocus(chain.chain, chainFocus))
          continue;
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
      // Insert fallback rows for primary chains not seen in API data
      if (knownEvmAddr) {
        for (const key of PRIMARY_CHAIN_KEYS) {
          if (key === "solana") continue; // handled below
          if (seenChainKeys.has(key)) continue;
          if (chainFocus !== "all" && chainFocus !== key) continue;
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
      // No EVM data at all — still expose the supported EVM chains.
      for (const key of PRIMARY_CHAIN_KEYS) {
        if (key === "solana") continue;
        if (chainFocus !== "all" && chainFocus !== key) continue;
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

    // Solana tokens
    if (
      (chainFocus === "all" || chainFocus === "solana") &&
      walletBalances?.solana
    ) {
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
    if (
      (chainFocus === "all" || chainFocus === "solana") &&
      knownSolAddr &&
      !walletBalances?.solana
    ) {
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

    // Add tracked tokens not already in the list
    if (chainFocus === "bsc" || chainFocus === "all") {
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
          (r) =>
            r.contractAddress?.toLowerCase() === tracked.address.toLowerCase(),
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
    }
    return rows.filter(hasVisibleBalance);
  }, [
    walletBalances,
    trackedBscTokens,
    chainFocus,
    trackedTokens,
    knownEvmAddr,
    knownSolAddr,
  ]);

  // ── Sort ──────────────────────────────────────────────────────────
  const sortedRows = useMemo(() => {
    const sorted = [...tokenRows];
    if (inventorySort === "value") {
      sorted.sort(
        (a, b) => b.valueUsd - a.valueUsd || b.balanceRaw - a.balanceRaw,
      );
    } else if (inventorySort === "chain") {
      sorted.sort(
        (a, b) =>
          a.chain.localeCompare(b.chain) || a.symbol.localeCompare(b.symbol),
      );
    } else if (inventorySort === "symbol") {
      sorted.sort(
        (a, b) =>
          a.symbol.localeCompare(b.symbol) || a.chain.localeCompare(b.chain),
      );
    }
    return sorted;
  }, [tokenRows, inventorySort]);

  // ── Chain errors ──────────────────────────────────────────────────
  const chainErrors = useMemo(
    () =>
      (walletBalances?.evm?.chains ?? []).filter(
        (c: EvmChainBalance) => c.error,
      ),
    [walletBalances],
  );

  const bscHasError = useMemo(
    () => chainErrors.some((c: EvmChainBalance) => isBscChainName(c.chain)),
    [chainErrors],
  );

  const focusChainHasError = useMemo(() => {
    if (chainFocus === "all") return chainErrors.length > 0;
    return chainErrors.some((c) => matchesChainFocus(c.chain, chainFocus));
  }, [chainErrors, chainFocus]);

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
    return items;
  }, [walletNfts]);

  // ── Derived values ────────────────────────────────────────────────
  const focusedChain = useMemo(() => {
    if (chainFocus === "all") return null;
    if (chainFocus === "solana") {
      return {
        name: CHAIN_CONFIGS.solana.name,
        nativeSymbol: CHAIN_CONFIGS.solana.nativeSymbol,
        nativeBalance:
          walletBalances?.solana?.solBalance ?? (knownSolAddr ? "0" : null),
        error: null,
      };
    }

    const chainConfig = CHAIN_CONFIGS[chainFocus as keyof typeof CHAIN_CONFIGS];
    const evmChain =
      walletBalances?.evm?.chains.find((chain) =>
        matchesChainFocus(chain.chain, chainFocus),
      ) ?? null;

    if (!chainConfig && !evmChain) return null;

    return {
      name: evmChain?.chain ?? chainConfig?.name ?? chainFocus,
      nativeSymbol: evmChain?.nativeSymbol ?? chainConfig?.nativeSymbol ?? null,
      nativeBalance: evmChain?.nativeBalance ?? (knownEvmAddr ? "0" : null),
      error: evmChain?.error ?? null,
    };
  }, [chainFocus, knownEvmAddr, knownSolAddr, walletBalances]);

  const primaryChainError =
    primaryChain?.error ??
    chainErrors.find((chain) => isBscChainName(chain.chain))?.error ??
    null;
  const primaryNativeBalance: string | null =
    primaryChain?.nativeBalance ?? null;

  const focusedRows = useMemo(() => {
    if (chainFocus === "all") return sortedRows;
    return sortedRows.filter((row) => matchesChainFocus(row.chain, chainFocus));
  }, [sortedRows, chainFocus]);

  const bscRows = sortedRows.filter((row) => isBscChainName(row.chain));
  const visibleRows = chainFocus === "all" ? sortedRows : focusedRows;

  const totalUsd = useMemo(
    () =>
      (chainFocus === "all" ? tokenRows : focusedRows).reduce(
        (sum, r) => sum + r.valueUsd,
        0,
      ),
    [tokenRows, focusedRows, chainFocus],
  );

  const visibleChainErrors = useMemo(() => {
    if (chainFocus === "all") return chainErrors;
    return chainErrors.filter((chain) =>
      matchesChainFocus(chain.chain, chainFocus),
    );
  }, [chainErrors, chainFocus]);

  return {
    chainFocus,
    tokenRows,
    sortedRows,
    chainErrors,
    bscHasError,
    focusChainHasError,
    allNfts,
    // Backwards-compat aliases
    bscChain: primaryChain,
    primaryChain,
    bnbBalance: primaryNativeBalanceNum,
    primaryNativeBalanceNum,
    bscRows,
    focusedRows,
    visibleRows,
    totalUsd,
    visibleChainErrors,
    focusedChainName: focusedChain?.name ?? null,
    focusedChainError: focusedChain?.error ?? null,
    focusedNativeBalance: focusedChain?.nativeBalance ?? null,
    focusedNativeSymbol: focusedChain?.nativeSymbol ?? null,
    bscChainError: primaryChainError,
    primaryChainError,
    bscNativeBalance: primaryNativeBalance,
    primaryNativeBalance,
  };
}
