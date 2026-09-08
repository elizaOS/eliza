/**
 * Price Oracle — fetches USD prices for native and fungible tokens via DexScreener.
 *
 * - Free API, no key required
 * - Caches prices for configurable TTL (default 60s)
 * - Graceful degradation: returns null on failure so callers can fall back to wei comparison
 */

import { logger } from "@elizaos/logger";
import { requireLoginValue } from "../../../required";
import { redactedThrownDiagnostics } from "./safe-error.js";
import {
  getNativeDecimalsStrict,
  getTokenDecimalsStrict,
  getWrappedNativeAddress,
} from "./tokens.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PriceOracle {
  /** Get native token USD price for a chain. Returns null if unavailable. */
  getNativeUsdPrice(chainId: number): Promise<number | null>;

  /** Get ERC-20 token USD price. Returns null if unavailable. */
  getTokenUsdPrice(
    chainId: number,
    tokenAddress: string,
  ): Promise<number | null>;

  /**
   * Convert a wei/lamport value to USD.
   * If tokenAddress is undefined or "native", uses native token price.
   * Returns null if price is unavailable.
   */
  weiToUsd(
    weiValue: string,
    chainId: number,
    tokenAddress?: string,
  ): Promise<number | null>;

  /**
   * Convert a USD value to wei/lamports.
   * If tokenAddress is undefined or "native", uses native token price.
   * Returns null if price is unavailable.
   */
  usdToWei(
    usdValue: number,
    chainId: number,
    tokenAddress?: string,
  ): Promise<string | null>;
}

// ─── DexScreener Response Shape ───────────────────────────────────────────────

interface DexScreenerPair {
  chainId?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

const MAX_DEX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DEX_PAIRS = 1_000;

// ─── Cache Entry ──────────────────────────────────────────────────────────────

interface CacheEntry {
  price: number;
  fetchedAt: number;
}

/** Convert the exact decimal representation of a finite non-negative JS number
 * into an integer ratio. This avoids routing through a scaled Number before
 * BigInt conversion, which can overflow to Infinity or lose integer bits. */
function decimalNumberRatio(
  value: number,
): [numerator: bigint, denominator: bigint] | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) return null;
  const fraction = match[2] ?? "";
  let numerator = BigInt(`${match[1]}${fraction}`);
  const exponent = Number(match[3] ?? "0") - fraction.length;
  if (!Number.isSafeInteger(exponent)) return null;
  if (exponent >= 0) {
    numerator *= 10n ** BigInt(exponent);
    return [numerator, 1n];
  }
  return [numerator, 10n ** BigInt(-exponent)];
}

/** DexScreener documents priceUsd as a decimal string. Number() also accepts
 * JavaScript-only syntaxes such as hexadecimal and binary; accepting those in
 * an external price feed could turn malformed data into a valid policy price. */
function parsePositiveDecimal(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function readBoundedDexResponse(
  response: Response,
): Promise<DexScreenerResponse> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_DEX_RESPONSE_BYTES
  ) {
    throw new Error("DexScreener response exceeded the size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("DexScreener returned an empty response");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DEX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("DexScreener response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as DexScreenerResponse;
  if (!decoded || typeof decoded !== "object") {
    throw new Error("DexScreener returned an invalid response");
  }
  return decoded;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export function createPriceOracle(options?: {
  cacheTtlMs?: number;
}): PriceOracle {
  const cacheTtlMs = options?.cacheTtlMs ?? 60_000; // 60 seconds default
  const cache = new Map<string, CacheEntry>();

  function cacheKey(chainId: number, address: string): string {
    const normalized =
      chainId === 101 || chainId === 102 ? address : address.toLowerCase();
    return `${chainId}:${normalized}`;
  }

  function getCached(key: string): number | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > cacheTtlMs) {
      cache.delete(key);
      return null;
    }
    return entry.price;
  }

  function setCache(key: string, price: number): void {
    cache.set(key, { price, fetchedAt: Date.now() });
  }

  function dexScreenerChainId(chainId: number): string | null {
    switch (chainId) {
      case 1:
        return "ethereum";
      case 10:
        return "optimism";
      case 56:
        return "bsc";
      case 100:
        return "gnosischain";
      case 137:
        return "polygon";
      case 8453:
        return "base";
      case 42161:
        return "arbitrum";
      case 43114:
        return "avalanche";
      case 101:
        return "solana";
      default:
        return null;
    }
  }

  /**
   * Reject malformed token addresses before they reach the request URL
   * (SEC-118). EVM chains expect a 20-byte hex address; Solana a base58 mint.
   * Anything else (path/query metacharacters, wrong family) fails closed.
   */
  function isPlausibleTokenAddress(
    chainId: number,
    tokenAddress: string,
  ): boolean {
    if (chainId === 101 || chainId === 102) {
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress);
    }
    return /^0x[0-9a-fA-F]{40}$/.test(tokenAddress);
  }

  /**
   * Fetch price from DexScreener for a token address.
   * Picks the pair with highest liquidity for best accuracy.
   */
  async function fetchPrice(
    chainId: number,
    tokenAddress: string,
  ): Promise<number | null> {
    try {
      const expectedDexChainId = dexScreenerChainId(chainId);
      if (!expectedDexChainId) {
        logger.warn(
          {
            details: [
              `[price-oracle] No DexScreener chain mapping for chainId ${chainId}`,
            ],
          },
          "[Login:price-oracle] warn",
        );
        return null;
      }
      if (!isPlausibleTokenAddress(chainId, tokenAddress)) {
        logger.warn(
          {
            details: [
              `[price-oracle] Rejecting malformed token address for chainId ${chainId}: ${tokenAddress.slice(0, 64)}`,
            ],
          },
          "[Login:price-oracle] warn",
        );
        return null;
      }
      const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        logger.warn(
          {
            details: [
              `[price-oracle] DexScreener returned ${res.status} for ${tokenAddress}`,
            ],
          },
          "[Login:price-oracle] warn",
        );
        return null;
      }

      const data = await readBoundedDexResponse(res);
      if (!Array.isArray(data.pairs) || data.pairs.length === 0) {
        logger.warn(
          { details: [`[price-oracle] No pairs found for ${tokenAddress}`] },
          "[Login:price-oracle] warn",
        );
        return null;
      }
      if (data.pairs.length > MAX_DEX_PAIRS) {
        logger.warn(
          {
            details: [
              `[price-oracle] DexScreener returned too many pairs for ${tokenAddress}`,
            ],
          },
          "[Login:price-oracle] warn",
        );
        return null;
      }

      // Sort by liquidity (descending) and pick the best one with a valid priceUsd
      const sorted = [...data.pairs]
        .filter(
          (p) =>
            p.chainId === expectedDexChainId &&
            parsePositiveDecimal(p.priceUsd) !== null,
        )
        .sort((a, b) => {
          const aLiquidity =
            typeof a.liquidity?.usd === "number" &&
            Number.isFinite(a.liquidity.usd)
              ? a.liquidity.usd
              : 0;
          const bLiquidity =
            typeof b.liquidity?.usd === "number" &&
            Number.isFinite(b.liquidity.usd)
              ? b.liquidity.usd
              : 0;
          return bLiquidity - aLiquidity;
        });

      if (sorted.length === 0) return null;

      return parsePositiveDecimal(sorted[0].priceUsd);
    } catch (err) {
      logger.warn(
        {
          details: [
            `[price-oracle] Failed to fetch price for ${tokenAddress}`,
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:price-oracle] warn",
      );
      return null;
    }
  }

  async function getPrice(
    chainId: number,
    tokenAddress: string,
  ): Promise<number | null> {
    const key = cacheKey(chainId, tokenAddress);
    const cached = getCached(key);
    if (cached !== null) return cached;

    const price = await fetchPrice(chainId, tokenAddress);
    if (price !== null) {
      setCache(key, price);
    }
    return price;
  }

  const oracle: PriceOracle = {
    async getNativeUsdPrice(chainId: number): Promise<number | null> {
      // Monero (301/302) has no wrapped-native DexScreener pair, so this
      // returns null and every USD-denominated policy rule fails closed
      // (denies) for Monero requests. This is deliberate: quoting XMR via an
      // unrelated proxy pair would be dishonest pricing in a money path. Use
      // piconero-denominated limits for Monero until a vetted XMR price
      // source is added here.
      const wrappedAddress = getWrappedNativeAddress(chainId);
      if (!wrappedAddress) {
        logger.warn(
          {
            details: [
              `[price-oracle] No wrapped native address for chainId ${chainId}`,
            ],
          },
          "[Login:price-oracle] warn",
        );
        return null;
      }
      return getPrice(chainId, wrappedAddress);
    },

    async getTokenUsdPrice(
      chainId: number,
      tokenAddress: string,
    ): Promise<number | null> {
      return getPrice(chainId, tokenAddress);
    },

    async weiToUsd(
      weiValue: string,
      chainId: number,
      tokenAddress?: string,
    ): Promise<number | null> {
      const isNative =
        !tokenAddress || tokenAddress === "native" || tokenAddress === "";
      const price = isNative
        ? await oracle.getNativeUsdPrice(chainId)
        : await oracle.getTokenUsdPrice(
            chainId,
            requireLoginValue(tokenAddress, "tokenAddress"),
          );

      if (price === null) return null;

      // Strict decimals (SEC-190): unknown chains/tokens return null and the
      // conversion fails closed instead of guessing 18 decimals.
      const decimals = isNative
        ? getNativeDecimalsStrict(chainId)
        : getTokenDecimalsStrict(chainId, tokenAddress);
      if (decimals === null) {
        logger.warn(
          {
            details: [
              `[price-oracle] Unknown decimals for chainId ${chainId} token ${tokenAddress ?? "native"}; failing closed`,
            ],
          },
          "[Login:price-oracle] warn",
        );
        return null;
      }

      // Convert wei to token units: weiValue / 10^decimals
      // Use BigInt arithmetic to avoid floating point issues with large numbers
      const wei = BigInt(weiValue);
      const divisor = 10n ** BigInt(decimals);
      const wholePart = wei / divisor;
      const remainder = wei % divisor;

      // Convert to number: wholePart + remainder/divisor
      const tokenAmount =
        Number(wholePart) + Number(remainder) / Number(divisor);
      return tokenAmount * price;
    },

    async usdToWei(
      usdValue: number,
      chainId: number,
      tokenAddress?: string,
    ): Promise<string | null> {
      const isNative =
        !tokenAddress || tokenAddress === "native" || tokenAddress === "";
      const price = isNative
        ? await oracle.getNativeUsdPrice(chainId)
        : await oracle.getTokenUsdPrice(
            chainId,
            requireLoginValue(tokenAddress, "tokenAddress"),
          );

      if (price === null || price === 0) return null;

      // Strict decimals (SEC-190): unknown chains/tokens fail closed.
      const decimals = isNative
        ? getNativeDecimalsStrict(chainId)
        : getTokenDecimalsStrict(chainId, tokenAddress);
      if (decimals === null) {
        logger.warn(
          {
            details: [
              `[price-oracle] Unknown decimals for chainId ${chainId} token ${tokenAddress ?? "native"}; failing closed`,
            ],
          },
          "[Login:price-oracle] warn",
        );
        return null;
      }

      if (!Number.isFinite(usdValue) || usdValue < 0) return null;

      // Rational arithmetic (SEC-189): parse each Number's exact decimal /
      // exponent representation directly into BigInt. Never multiply a Number
      // before conversion: a large finite input can overflow that intermediate
      // to Infinity, while an unsafe integer has already lost bits. Round the
      // final exact ratio to nearest, half up.
      const usdRatio = decimalNumberRatio(usdValue);
      const priceRatio = decimalNumberRatio(price);
      if (!usdRatio || !priceRatio || priceRatio[0] <= 0n) return null;
      const numerator = usdRatio[0] * priceRatio[1] * 10n ** BigInt(decimals);
      const denominator = usdRatio[1] * priceRatio[0];
      const wei = (numerator * 2n + denominator) / (denominator * 2n);
      return wei.toString();
    },
  };

  return oracle;
}
