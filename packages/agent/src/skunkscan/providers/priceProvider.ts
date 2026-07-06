export type TokenPrice = {
  mint: string;
  priceUsd: number | null;
  source: "jupiter" | "unknown";
};

type JupiterPriceResponse = {
  data?: Record<
    string,
    {
      id?: string;
      price?: number;
    }
  >;
};

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
      `https://price.jup.ag/v6/price?ids=${encodeURIComponent(
        uniqueMints.join(","),
      )}`,
    );

    if (!response.ok) {
      return buildUnknownPrices(uniqueMints);
    }

    const data = (await response.json()) as JupiterPriceResponse;

    return uniqueMints.reduce<Record<string, TokenPrice>>((prices, mint) => {
      const price = data.data?.[mint]?.price;

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
