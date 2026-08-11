import { TokenPrice, TokenPriceProvider } from "./types";

type JupiterPriceV3Response = Record<
  string,
  {
    usdPrice?: number;
    decimals?: number;
    liquidity?: number;
    priceChange24h?: number;
    createdAt?: string;
    blockId?: number;
  }
>;

function buildUnknownPrices(tokenIds: string[]): Record<string, TokenPrice> {
  return tokenIds.reduce<Record<string, TokenPrice>>((prices, tokenId) => {
    prices[tokenId] = {
      tokenId,
      priceUsd: null,
      source: "unknown",
    };

    return prices;
  }, {});
}

function buildRateLimitedPrices(tokenIds: string[]): Record<string, TokenPrice> {
  return tokenIds.reduce<Record<string, TokenPrice>>((prices, tokenId) => {
    prices[tokenId] = {
      tokenId,
      priceUsd: null,
      source: "rate_limited",
    };

    return prices;
  }, {});
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

// Matches the EVM price path's chunk size (moralis.ts's
// MAX_TOKENS_PER_PRICE_REQUEST) for consistency. Unlike that path, this
// isn't Jupiter enforcing a hard per-request cap (unconfirmed either way) -
// it's this codebase choosing a bounded request size rather than one comma-
// joined URL covering every held token. That "one giant URL" approach is
// what caused the real bug this chunking fixes: live-confirmed against a
// wallet with 1.4M token holdings (5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1,
// investigated 2026-08-11), the unchunked request built a 65.7-million-
// character URL and Jupiter's CDN returned 414 Request-URI Too Large -
// caught by the !response.ok branch below, which silently returned null
// prices for the entire token list. Chunking keeps each request's URL a
// reasonable size regardless of how many tokens a wallet holds.
const MAX_TOKENS_PER_PRICE_REQUEST = 100;

export class SolanaTokenPriceProvider implements TokenPriceProvider {
  readonly chainId = "solana";
  readonly providerName = "Jupiter";

  async getTokenPrices(
    tokenIds: string[],
  ): Promise<Record<string, TokenPrice>> {
    const uniqueTokenIds = Array.from(
      new Set(tokenIds.map((tokenId) => tokenId.trim()).filter(Boolean)),
    );

    if (uniqueTokenIds.length === 0) {
      return {};
    }

    const prices: Record<string, TokenPrice> = {};

    for (const tokenIdChunk of chunk(uniqueTokenIds, MAX_TOKENS_PER_PRICE_REQUEST)) {
      try {
        const response = await fetch(
          `https://api.jup.ag/price/v3?ids=${encodeURIComponent(
            tokenIdChunk.join(","),
          )}`,
        );

        if (response.status === 429) {
          Object.assign(prices, buildRateLimitedPrices(tokenIdChunk));
          continue;
        }

        if (!response.ok) {
          Object.assign(prices, buildUnknownPrices(tokenIdChunk));
          continue;
        }

        const data = (await response.json()) as JupiterPriceV3Response;

        for (const tokenId of tokenIdChunk) {
          const price = data[tokenId]?.usdPrice;

          prices[tokenId] = {
            tokenId,
            priceUsd: typeof price === "number" ? price : null,
            source: typeof price === "number" ? "jupiter" : "unknown",
          };
        }
      } catch {
        // This chunk's tokens stay unknown - other chunks still get a
        // chance to succeed, same tolerance as the EVM price path.
        Object.assign(prices, buildUnknownPrices(tokenIdChunk));
      }
    }

    return prices;
  }
}

export const solanaTokenPriceProvider = new SolanaTokenPriceProvider();
