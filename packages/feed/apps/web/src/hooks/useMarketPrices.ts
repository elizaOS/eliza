import { useMemo, useState } from "react";

import { useSSEChannel } from "@/hooks/useSSE";

/**
 * Represents a live market price update.
 */
export interface LivePrice {
  /** The ticker symbol (e.g., 'AAPL', 'TSLA') */
  ticker: string;
  /** Current price */
  price: number;
  /** Optional percentage change from previous price */
  changePercent?: number;
}

const normalizeTicker = (ticker?: string | null) =>
  ticker ? ticker.toUpperCase() : null;

const deriveTicker = (update: Record<string, unknown>): string | null => {
  const direct = normalizeTicker(update.ticker as string | undefined);
  if (direct) return direct;

  if (update.metadata && typeof update.metadata === "object") {
    const metaTicker = normalizeTicker(
      (update.metadata as Record<string, unknown>).ticker as string | undefined,
    );
    if (metaTicker) return metaTicker;
  }

  const organizationId =
    typeof update.organizationId === "string"
      ? update.organizationId
      : undefined;
  return organizationId ? organizationId.toUpperCase().replace(/-/g, "") : null;
};

const derivePrice = (update: Record<string, unknown>): number | null => {
  const candidate = update.price ?? update.newPrice;
  const price = typeof candidate === "number" ? candidate : Number(candidate);
  return Number.isFinite(price) ? Number(price) : null;
};

/**
 * Hook for subscribing to live market price updates via SSE.
 *
 * Automatically subscribes to the 'markets' SSE channel and filters price
 * updates for the specified tickers. Supports both prediction markets and
 * perpetual markets. Prices are normalized and deduplicated automatically.
 *
 * @param targetTickers - Array of ticker symbols to subscribe to (e.g., ['AAPL', 'TSLA']).
 * If empty, subscribes to all market updates. Tickers are case-insensitive.
 *
 * @returns A Map of ticker symbols to LivePrice objects, updated in real-time
 * as price updates are received via SSE.
 *
 * @example
 * ```tsx
 * const prices = useMarketPrices(['AAPL', 'TSLA']);
 *
 * const aaplPrice = prices.get('AAPL');
 * if (aaplPrice) {
 *   console.log(`AAPL: $${aaplPrice.price} (${aaplPrice.changePercent}%)`);
 * }
 * ```
 */
export function useMarketPrices(targetTickers: string[]) {
  const [prices, setPrices] = useState<Map<string, LivePrice>>(new Map());

  const normalizedTargets = useMemo(
    () => targetTickers.filter(Boolean).map((ticker) => ticker.toUpperCase()),
    [targetTickers],
  );

  useSSEChannel("markets", (payload) => {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type !== "price_update" && type !== "perp_price_update") return;

    const updates = Array.isArray(payload.updates) ? payload.updates : [];
    if (updates.length === 0) return;

    setPrices((prev) => {
      const next = new Map(prev);

      for (const raw of updates) {
        if (!raw || typeof raw !== "object") continue;
        const update = raw as Record<string, unknown>;

        const ticker = deriveTicker(update);
        if (!ticker) continue;
        if (
          normalizedTargets.length > 0 &&
          !normalizedTargets.includes(ticker)
        ) {
          continue;
        }

        const price = derivePrice(update);
        if (price === null) continue;

        next.set(ticker, {
          ticker,
          price,
          changePercent:
            typeof update.changePercent === "number"
              ? update.changePercent
              : undefined,
        });
      }

      return next;
    });
  });

  return prices;
}
