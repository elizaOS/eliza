export interface PolymarketOrderbookLevel {
  price: string;
  size: string;
}

export interface PolymarketTopOfBook {
  bestBid: PolymarketOrderbookLevel | null;
  bestAsk: PolymarketOrderbookLevel | null;
  midpoint: string | null;
  spread: string | null;
}

function parsePositivePrice(value: string | number | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function formatPrice(value: number): string {
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function derivePolymarketTopOfBook(args: {
  bids?: readonly PolymarketOrderbookLevel[];
  asks?: readonly PolymarketOrderbookLevel[];
}): PolymarketTopOfBook {
  const bestBid =
    args.bids?.reduce<PolymarketOrderbookLevel | null>((best, level) => {
      const levelPrice = parsePositivePrice(level.price);
      if (levelPrice === null) return best;
      const bestPrice = best ? parsePositivePrice(best.price) : null;
      if (!best || bestPrice === null || levelPrice > bestPrice) {
        return level;
      }
      return best;
    }, null) ?? null;

  const bestAsk =
    args.asks?.reduce<PolymarketOrderbookLevel | null>((best, level) => {
      const levelPrice = parsePositivePrice(level.price);
      if (levelPrice === null) return best;
      const bestPrice = best ? parsePositivePrice(best.price) : null;
      if (!best || bestPrice === null || levelPrice < bestPrice) {
        return level;
      }
      return best;
    }, null) ?? null;

  const bidPrice = bestBid ? parsePositivePrice(bestBid.price) : null;
  const askPrice = bestAsk ? parsePositivePrice(bestAsk.price) : null;
  return {
    bestBid,
    bestAsk,
    midpoint:
      bidPrice !== null && askPrice !== null
        ? formatPrice((bidPrice + askPrice) / 2)
        : null,
    spread:
      bidPrice !== null && askPrice !== null
        ? formatPrice(askPrice - bidPrice)
        : null,
  };
}
