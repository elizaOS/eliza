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

    try {
      const response = await fetch(
        `https://api.jup.ag/price/v3?ids=${encodeURIComponent(
          uniqueTokenIds.join(","),
        )}`,
      );

      if (response.status === 429) {
        return buildRateLimitedPrices(uniqueTokenIds);
      }

      if (!response.ok) {
        return buildUnknownPrices(uniqueTokenIds);
      }

      const data = (await response.json()) as JupiterPriceV3Response;

      return uniqueTokenIds.reduce<Record<string, TokenPrice>>(
        (prices, tokenId) => {
          const price = data[tokenId]?.usdPrice;

          prices[tokenId] = {
            tokenId,
            priceUsd: typeof price === "number" ? price : null,
            source: typeof price === "number" ? "jupiter" : "unknown",
          };

          return prices;
        },
        {},
      );
    } catch {
      return buildUnknownPrices(uniqueTokenIds);
    }
  }
}

export const solanaTokenPriceProvider = new SolanaTokenPriceProvider();
