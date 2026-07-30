import { SupportedChain } from "../types";

export const WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

// The token ID the native asset is priced under on each chain, since the
// native balance is quoted the same way as any other token holding (e.g.
// Solana prices native SOL under its wrapped-SOL mint).
export const WRAPPED_NATIVE_ASSET_ID: Partial<Record<SupportedChain, string>> =
  {
    solana: WRAPPED_SOL_MINT,
  };

export type TokenPrice = {
  mint: string;
  priceUsd: number | null;
  source: "jupiter" | "unknown" | "rate_limited";
};

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

export async function getSolanaTokenPrices(
  mints: string[],
): Promise<Record<string, TokenPrice>> {
  const uniqueMints = Array.from(
    new Set(mints.map((mint) => mint.trim()).filter(Boolean)),
  );

  if (uniqueMints.length === 0) {
    return {};
  }

  try {
    const response = await fetch(
      `https://api.jup.ag/price/v3?ids=${encodeURIComponent(
        uniqueMints.join(","),
      )}`,
    );

    if (response.status === 429) {
      return buildRateLimitedPrices(uniqueMints);
    }

    if (!response.ok) {
      return buildUnknownPrices(uniqueMints);
    }

    const data = (await response.json()) as JupiterPriceV3Response;

    return uniqueMints.reduce<Record<string, TokenPrice>>((prices, mint) => {
      const price = data[mint]?.usdPrice;

      prices[mint] = {
        mint,
        priceUsd: typeof price === "number" ? price : null,
        source: typeof price === "number" ? "jupiter" : "unknown",
      };

      return prices;
    }, {});
  } catch {
    return buildUnknownPrices(uniqueMints);
  }
}

function buildUnknownPrices(mints: string[]): Record<string, TokenPrice> {
  return mints.reduce<Record<string, TokenPrice>>((prices, mint) => {
    prices[mint] = {
      mint,
      priceUsd: null,
      source: "unknown",
    };

    return prices;
  }, {});
}

function buildRateLimitedPrices(mints: string[]): Record<string, TokenPrice> {
  return mints.reduce<Record<string, TokenPrice>>((prices, mint) => {
    prices[mint] = {
      mint,
      priceUsd: null,
      source: "rate_limited",
    };

    return prices;
  }, {});
}
