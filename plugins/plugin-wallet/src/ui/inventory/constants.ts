/**
 * Shared inventory row/item types (`TokenRow`, `NftItem`) and the small
 * formatting/matching helpers used across the wallet inventory UI: chain
 * name normalization and badge codes, balance display formatting, address
 * lowercasing, and lenient numeric parsing for untrusted balance strings.
 */
import type { AvatarFallbackTone } from "@elizaos/ui";

export const BSC_GAS_READY_THRESHOLD = 0.005;
export const BSC_GAS_THRESHOLD = 0.005;
export const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

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
}

export interface NftItem {
  chain: string;
  name: string;
  imageUrl: string;
  collectionName: string;
}

export function chainIcon(chain: string): {
  code: string;
  tone: AvatarFallbackTone;
} {
  const c = chain.toLowerCase();
  if (c === "ethereum" || c === "mainnet")
    return { code: "E", tone: "chainEthereum" };
  if (c === "base") return { code: "B", tone: "chainBase" };
  if (c === "bsc" || c === "bnb chain" || c === "bnb smart chain")
    return { code: "B", tone: "chainBsc" };
  if (
    c === "avax" ||
    c === "avalanche" ||
    c === "c-chain" ||
    c === "avalanche c-chain"
  )
    return { code: "A", tone: "chainAvalanche" };
  if (c === "arbitrum") return { code: "A", tone: "chainArbitrum" };
  if (c === "optimism") return { code: "O", tone: "chainOptimism" };
  if (c === "polygon") return { code: "P", tone: "chainPolygon" };
  if (c === "solana") return { code: "S", tone: "chainSolana" };
  return { code: chain.charAt(0).toUpperCase(), tone: "default" };
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

export function formatBalance(balance: string): string {
  const num = parseFiniteAmount(balance);
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  if (num < 1) return num.toFixed(6);
  if (num < 1000) return num.toFixed(4);
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function toNormalizedAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

export function parseFiniteAmount(
  value: string | number | null | undefined,
): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
