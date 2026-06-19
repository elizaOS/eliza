import { logger } from "@elizaos/core";

export const DEXSCREENER_CHAIN_MAP: Record<number, string> = {
  1: "ethereum",
  56: "bsc",
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  137: "polygon",
  43114: "avalanche",
};

export const DEXPAPRIKA_CHAIN_MAP: Record<number, string> = {
  1: "ethereum",
  56: "bsc",
  8453: "base",
  42161: "arbitrum_one",
  10: "optimism",
  137: "polygon_pos",
  43114: "avalanche",
};

export const WRAPPED_NATIVE: Record<number, string> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  56: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  10: "0x4200000000000000000000000000000000000006",
  137: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  43114: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
};

export const DEX_PRICE_TIMEOUT_MS = 10_000;

export interface DexScreenerPair {
  baseToken?: { address?: string };
  priceUsd?: string | null;
  liquidity?: { usd?: number };
  info?: { imageUrl?: string };
}

export interface DexTokenMeta {
  price: string;
  logoUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function fetchDexScreenerPrices(
  chainId: number,
  addresses: string[],
): Promise<Map<string, DexTokenMeta>> {
  const results = new Map<string, DexTokenMeta>();
  const chain = DEXSCREENER_CHAIN_MAP[chainId];
  if (!chain || addresses.length === 0) return results;

  const batches: string[][] = [];
  for (let i = 0; i < addresses.length; i += 30) {
    batches.push(addresses.slice(i, i + 30));
  }

  await Promise.allSettled(
    batches.map(async (batch) => {
      try {
        const joined = batch.join(",");
        const res = await fetch(
          `https://api.dexscreener.com/tokens/v1/${chain}/${joined}`,
          { signal: AbortSignal.timeout(DEX_PRICE_TIMEOUT_MS) },
        );
        if (!res.ok) return;
        const rawPairs = await res.json();
        if (!Array.isArray(rawPairs)) return;
        const pairs = rawPairs as DexScreenerPair[];

        const best = new Map<string, DexScreenerPair>();
        for (const pair of pairs) {
          const addr = pair.baseToken?.address?.toLowerCase();
          if (!addr || !pair.priceUsd) continue;
          const existing = best.get(addr);
          if (
            !existing ||
            (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)
          ) {
            best.set(addr, pair);
          }
        }
        for (const [addr, pair] of best) {
          if (pair.priceUsd) {
            const logoUrl = pair.info?.imageUrl?.trim() || undefined;
            results.set(addr, { price: String(pair.priceUsd), logoUrl });
          }
        }
        logger.info(
          `[wallet] DexScreener: ${best.size} prices for chain ${chain}`,
        );
      } catch (err) {
        logger.warn(
          `[wallet] DexScreener fetch failed for chain ${chain}: ${String(err)}`,
        );
      }
    }),
  );

  return results;
}

export async function fetchDexPaprikaPrices(
  chainId: number,
  addresses: string[],
): Promise<Map<string, DexTokenMeta>> {
  const results = new Map<string, DexTokenMeta>();
  const network = DEXPAPRIKA_CHAIN_MAP[chainId];
  if (!network || addresses.length === 0) return results;

  await Promise.allSettled(
    addresses.slice(0, 20).map(async (addr) => {
      try {
        const res = await fetch(
          `https://api.dexpaprika.com/networks/${network}/tokens/${addr}`,
          { signal: AbortSignal.timeout(DEX_PRICE_TIMEOUT_MS) },
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!isRecord(data)) return;
        const price = Number(data.price_usd);
        if (Number.isFinite(price) && price > 0) {
          results.set(addr.toLowerCase(), { price: price.toString() });
        }
      } catch (err) {
        logger.warn(
          `[wallet] DexPaprika fetch failed for ${addr}: ${String(err)}`,
        );
      }
    }),
  );

  return results;
}

export async function fetchDexPrices(
  chainId: number,
  addresses: string[],
): Promise<Map<string, DexTokenMeta>> {
  if (addresses.length === 0) return new Map();

  const lowerAddresses = addresses.map((address) => address.toLowerCase());
  const results = await fetchDexScreenerPrices(chainId, lowerAddresses);
  const missing = lowerAddresses.filter((address) => !results.has(address));
  if (missing.length > 0) {
    const fallback = await fetchDexPaprikaPrices(chainId, missing);
    for (const [addr, meta] of fallback) {
      results.set(addr, meta);
    }
  }

  return results;
}

export function computeValueUsd(balance: string, priceUsd: string): string {
  const bal = Number.parseFloat(balance);
  const price = Number.parseFloat(priceUsd);
  if (
    !Number.isFinite(bal) ||
    !Number.isFinite(price) ||
    bal <= 0 ||
    price <= 0
  ) {
    return "0";
  }
  return (bal * price).toFixed(2);
}
