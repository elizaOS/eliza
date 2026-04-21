/**
 * Shared constants, types, and utility helpers for the Inventory feature.
 */

/* ── Constants ──────────────────────────────────────────────────────── */

export const BSC_GAS_READY_THRESHOLD = 0.005;
export const BSC_GAS_THRESHOLD = 0.005;
export const TRACKED_BSC_TOKENS_KEY = "wt_tracked_bsc_tokens";
export const MAX_TRACKED_BSC_TOKENS = 30;
export const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/* ── Row types ──────────────────────────────────────────────────────── */

export interface TokenRow {
  chain: string;
  symbol: string;
  name: string;
  contractAddress: string | null;
  logoUrl: string | null;
  balance: string;
  valueUsd: number;
  balanceRaw: number;
  isNative: boolean;
  isTracked?: boolean;
}

export interface NftItem {
  chain: string;
  name: string;
  imageUrl: string;
  collectionName: string;
}

export interface TrackedBscToken {
  contractAddress: string;
  symbol: string;
  name: string;
  logoUrl?: string;
}

export interface TrackedToken {
  address: string;
  symbol: string;
  addedAt: number;
}

/* ── Chain helpers ───────────────────────────────────────────────────── */

export function chainIcon(chain: string): { code: string; cls: string } {
  const c = chain.toLowerCase();
  if (c === "ethereum" || c === "mainnet")
    return { code: "E", cls: "bg-chain-eth" };
  if (c === "base") return { code: "B", cls: "bg-chain-base" };
  if (c === "bsc" || c === "bnb chain" || c === "bnb smart chain")
    return { code: "B", cls: "bg-chain-bsc" };
  if (
    c === "avax" ||
    c === "avalanche" ||
    c === "c-chain" ||
    c === "avalanche c-chain"
  )
    return { code: "A", cls: "bg-chain-avax" };
  if (c === "arbitrum") return { code: "A", cls: "bg-chain-arb" };
  if (c === "optimism") return { code: "O", cls: "bg-chain-op" };
  if (c === "polygon") return { code: "P", cls: "bg-chain-pol" };
  if (c === "solana") return { code: "S", cls: "bg-chain-sol" };
  return { code: chain.charAt(0).toUpperCase(), cls: "bg-bg-muted" };
}

export function normalizeChainName(chain: string): string {
  return chain.trim().toLowerCase();
}

export function isBscChainName(chain: string): boolean {
  const c = normalizeChainName(chain);
  return c === "bsc" || c === "bnb chain" || c === "bnb smart chain";
}

export function isAvaxChainName(chain: string): boolean {
  const c = normalizeChainName(chain);
  return (
    c === "avax" ||
    c === "avalanche" ||
    c === "c-chain" ||
    c === "avalanche c-chain"
  );
}

/* ── Balance formatter ──────────────────────────────────────────────── */

export function formatBalance(balance: string): string {
  const num = Number.parseFloat(balance);
  if (Number.isNaN(num)) return balance;
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  if (num < 1) return num.toFixed(6);
  if (num < 1000) return num.toFixed(4);
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/* ── Address helpers ────────────────────────────────────────────────── */

export function toNormalizedAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

/* ── localStorage helpers for tracked BSC tokens ────────────────────── */

export function loadTrackedBscTokens(): TrackedBscToken[] {
  try {
    const raw = localStorage.getItem(TRACKED_BSC_TOKENS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is TrackedBscToken =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof item.contractAddress === "string" &&
          typeof item.symbol === "string" &&
          typeof item.name === "string" &&
          (item.logoUrl === undefined || typeof item.logoUrl === "string") &&
          HEX_ADDRESS_RE.test(item.contractAddress),
      )
      .slice(0, MAX_TRACKED_BSC_TOKENS);
  } catch {
    return [];
  }
}

export function saveTrackedBscTokens(next: TrackedBscToken[]): void {
  try {
    localStorage.setItem(TRACKED_BSC_TOKENS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function removeTrackedBscToken(
  contractAddress: string,
  prev: TrackedBscToken[],
): TrackedBscToken[] {
  const normalized = toNormalizedAddress(contractAddress);
  const next = prev.filter(
    (item) => toNormalizedAddress(item.contractAddress) !== normalized,
  );
  saveTrackedBscTokens(next);
  return next;
}

/* ── localStorage helpers for tracked tokens (TradePanel) ───────────── */

export function loadTrackedTokens(): TrackedToken[] {
  try {
    const raw = localStorage.getItem(TRACKED_BSC_TOKENS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as TrackedToken[];
  } catch {
    return [];
  }
}

export function saveTrackedTokens(tokens: TrackedToken[]): void {
  try {
    localStorage.setItem(TRACKED_BSC_TOKENS_KEY, JSON.stringify(tokens));
  } catch {
    // ignore in non-browser test runtime
  }
}
