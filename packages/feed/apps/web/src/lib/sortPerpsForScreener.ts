import type { PerpMarket } from "@/types/markets";

export type PerpScreenerSortKey =
  | "asset"
  | "volume24h"
  | "change24h"
  | "trending"
  | "price"
  | "openInterest"
  | "funding";

export type PerpScreenerSort = {
  key: PerpScreenerSortKey;
  dir: "asc" | "desc";
};

const TRENDING_WEIGHTS = {
  volume: 70,
  change: 30,
} as const;

function compareTickers(a: PerpMarket, b: PerpMarket): number {
  return a.ticker.localeCompare(b.ticker);
}

function getTrendingScore(
  market: PerpMarket,
  maxVolume: number,
  maxAbsChange: number,
): number {
  const volumeScore =
    ((market.volume24h ?? 0) / Math.max(maxVolume, 1)) *
    TRENDING_WEIGHTS.volume;
  const changeScore =
    (Math.abs(market.changePercent24h ?? 0) / Math.max(maxAbsChange, 1)) *
    TRENDING_WEIGHTS.change;

  return volumeScore + changeScore;
}

export function sortPerpsForScreener(
  markets: PerpMarket[],
  sort: PerpScreenerSort,
  maxRows: number,
): PerpMarket[] {
  if (markets.length === 0 || maxRows <= 0) {
    return [];
  }

  const maxVolume = Math.max(
    ...markets.map((market) => market.volume24h ?? 0),
    1,
  );
  const maxAbsChange = Math.max(
    ...markets.map((market) => Math.abs(market.changePercent24h ?? 0)),
    1,
  );
  const direction = sort.dir === "asc" ? 1 : -1;

  return [...markets]
    .sort((a, b) => {
      switch (sort.key) {
        case "asset":
          return direction * compareTickers(a, b);
        case "volume24h": {
          const delta = (a.volume24h ?? 0) - (b.volume24h ?? 0);
          return delta === 0 ? compareTickers(a, b) : direction * delta;
        }
        case "change24h": {
          const delta = (a.changePercent24h ?? 0) - (b.changePercent24h ?? 0);
          return delta === 0 ? compareTickers(a, b) : direction * delta;
        }
        case "trending": {
          const delta =
            getTrendingScore(a, maxVolume, maxAbsChange) -
            getTrendingScore(b, maxVolume, maxAbsChange);
          return delta === 0 ? compareTickers(a, b) : direction * delta;
        }
        case "price": {
          const delta = (a.currentPrice ?? 0) - (b.currentPrice ?? 0);
          return delta === 0 ? compareTickers(a, b) : direction * delta;
        }
        case "openInterest": {
          const delta = (a.openInterest ?? 0) - (b.openInterest ?? 0);
          return delta === 0 ? compareTickers(a, b) : direction * delta;
        }
        case "funding": {
          const delta = (a.fundingRate?.rate ?? 0) - (b.fundingRate?.rate ?? 0);
          return delta === 0 ? compareTickers(a, b) : direction * delta;
        }
        default:
          return compareTickers(a, b);
      }
    })
    .slice(0, maxRows);
}
