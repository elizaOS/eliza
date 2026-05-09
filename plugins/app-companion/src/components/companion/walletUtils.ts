import { getExplorerTokenUrl } from "@elizaos/app-wallet";
import {
  BSC_GAS_READY_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
} from "@elizaos/app-wallet";
import type { BscTradeTxStatusResponse } from "@elizaos/shared";

export {
  BSC_GAS_READY_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
};

export type TranslatorFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function getWalletTxStatusLabel(
  status: string,
  t: TranslatorFn,
): string {
  const key = `wallet.txStatus.${status}`;
  const translated = t(key);
  return translated === key ? status : translated;
}

export function mapWalletTradeError(
  err: unknown,
  t: TranslatorFn,
  fallbackKey: string,
): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return t(fallbackKey);
}

export const BSC_SWAP_GAS_RESERVE = 0.002;
export const ELIZA_BSC_TOKEN_ADDRESS =
  "0xc20e45e49e0e79f0fc81e71f05fd2772d6587777";
export const BSC_USDT_TOKEN_ADDRESS =
  "0x55d398326f99059fF775485246999027B3197955";
export const BSC_USDC_TOKEN_ADDRESS =
  "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
export const BSC_NATIVE_LOGO_URL =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/info/logo.png";
export const SOL_NATIVE_LOGO_URL =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png";
export const AVAX_NATIVE_LOGO_URL =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/avalanchec/info/logo.png";
export const WALLET_RECENT_TRADES_KEY = "anime_wallet_recent_trades";
export const MAX_WALLET_RECENT_TRADES = 10;

export type WalletPortfolioChainFilter =
  | "all"
  | "bsc"
  | "evm"
  | "solana"
  | "avax"
  | (string & {});

export type WalletTokenRow = {
  key: string;
  symbol: string;
  name: string;
  chain: string;
  chainKey: Exclude<WalletPortfolioChainFilter, "all">;
  assetAddress: string | null;
  isNative: boolean;
  valueUsd: number;
  balance: string;
  logoUrl: string | null;
};

export type WalletCollectibleRow = {
  key: string;
  chain: string;
  chainKey: Exclude<WalletPortfolioChainFilter, "all">;
  name: string;
  collectionName: string;
  imageUrl: string | null;
};

export type WalletRecentTrade = {
  hash: string;
  side: "buy" | "sell";
  tokenAddress: string;
  amount: string;
  inputSymbol: string;
  outputSymbol: string;
  createdAt: number;
  status: BscTradeTxStatusResponse["status"];
  confirmations: number;
  nonce: number | null;
  reason: string | null;
  explorerUrl: string;
};

export type WalletRecentFilter = "all" | BscTradeTxStatusResponse["status"];

export type TokenMetadata = {
  symbol: string;
  name: string;
  logoUrl: string | null;
};

export function resolvePortfolioChainKey(
  chain: string,
): Exclude<WalletPortfolioChainFilter, "all"> {
  const normalized = chain.trim().toLowerCase();
  if (isBscChainName(chain)) return "bsc";
  if (isAvaxChainName(chain)) return "avax";
  if (normalized.includes("solana") || normalized === "sol") return "solana";
  return "evm";
}

export function formatRouteAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function getTokenExplorerUrl(row: WalletTokenRow): string | null {
  if (!row.assetAddress) return null;
  // Delegate to the central chain config registry
  return getExplorerTokenUrl(row.chain, row.assetAddress);
}

export function loadRecentTrades(): WalletRecentTrade[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(WALLET_RECENT_TRADES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is WalletRecentTrade =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof entry.hash === "string" &&
          typeof entry.side === "string" &&
          (entry.side === "buy" || entry.side === "sell") &&
          typeof entry.createdAt === "number" &&
          typeof entry.status === "string",
      )
      .slice(0, MAX_WALLET_RECENT_TRADES);
  } catch {
    return [];
  }
}

export function persistRecentTrades(rows: WalletRecentTrade[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      WALLET_RECENT_TRADES_KEY,
      JSON.stringify(rows.slice(0, MAX_WALLET_RECENT_TRADES)),
    );
  } catch {
    // Ignore persistence errors so wallet actions remain usable.
  }
}

/**
 * Returns a safe explorer URL, falling back to a configurable explorer
 * (defaults to bscscan) if the provided URL does not use an https/http
 * scheme (prevents javascript: URI injection).
 */
export function safeExplorerHref(
  explorerUrl: string | undefined | null,
  hash: string,
  fallbackBaseUrl = "https://bscscan.com",
): string {
  const fallback = `${fallbackBaseUrl}/tx/${hash}`;
  if (!explorerUrl) return fallback;
  return /^https?:\/\//i.test(explorerUrl) ? explorerUrl : fallback;
}

export function shortHash(hash: string): string {
  const normalized = hash.trim();
  if (normalized.length <= 14) return normalized;
  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
}

export function getRecentTradeGroupKey(
  createdAt: number,
  nowMs: number = Date.now(),
): "today" | "yesterday" | "earlier" {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date(nowMs);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfCreatedAt = new Date(createdAt);
  const createdDayStart = new Date(
    startOfCreatedAt.getFullYear(),
    startOfCreatedAt.getMonth(),
    startOfCreatedAt.getDate(),
  ).getTime();
  if (createdDayStart >= startOfToday) return "today";
  if (createdDayStart >= startOfToday - DAY_MS) return "yesterday";
  return "earlier";
}

export type DexScreenerTokenRef = {
  address?: string;
  symbol?: string;
  name?: string;
};

export type DexScreenerPair = {
  chainId?: string;
  baseToken?: DexScreenerTokenRef;
  quoteToken?: DexScreenerTokenRef;
  info?: {
    imageUrl?: string;
  };
};

export type DexScreenerTokenResponse = {
  pairs?: DexScreenerPair[];
};

/**
 * Fetch token metadata from DexScreener for any supported chain.
 * Falls back to `fetchBscTokenMetadata` signature when no chainId given.
 */
export async function fetchTokenMetadata(
  contractAddress: string,
  dexScreenerChainId = "bsc",
): Promise<TokenMetadata | null> {
  if (typeof fetch !== "function") return null;
  const trimmed = contractAddress.trim();
  if (!HEX_ADDRESS_RE.test(trimmed)) return null;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 3500);
  const normalized = trimmed.toLowerCase();
  const targetChainId = dexScreenerChainId.toLowerCase();

  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${trimmed}`,
      {
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as DexScreenerTokenResponse;
    const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];
    const pair = pairs.find(
      (item) => (item.chainId ?? "").toLowerCase() === targetChainId,
    );
    if (!pair) return null;
    const baseAddr = pair.baseToken?.address?.trim().toLowerCase();
    const quoteAddr = pair.quoteToken?.address?.trim().toLowerCase();
    const tokenRef =
      baseAddr === normalized
        ? pair.baseToken
        : quoteAddr === normalized
          ? pair.quoteToken
          : pair.baseToken;
    return {
      symbol: tokenRef?.symbol?.trim() || "TOKEN",
      name: tokenRef?.name?.trim() || "Unknown Token",
      logoUrl: pair.info?.imageUrl?.trim() || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
