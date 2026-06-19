import { logger } from "@feed/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { useMarketPrices } from "@/hooks/useMarketPrices";
import {
  type PerpTradeSSE,
  usePerpMarketStream,
} from "@/hooks/usePerpMarketStream";
import type { MarketTimeRange } from "@/types/markets";
import { apiUrl } from "@/utils/api-url";

/**
 * Represents a single point in perpetual market price history.
 */
export interface PerpHistoryPoint {
  /** Timestamp in milliseconds */
  time: number;
  /** Price at this point */
  price: number;
  /** Price change from previous point */
  change?: number;
  /** Percentage change from previous point */
  changePercent?: number;
  /** Volume at this point */
  volume?: number;
}

/**
 * Seed data for initializing history when API data is unavailable.
 */
interface SeedSnapshot {
  /** Current price to seed with */
  currentPrice?: number;
}

/**
 * Options for configuring perp history loading.
 */
interface UsePerpHistoryOptions {
  /** Maximum number of history points to keep (default: 200) */
  limit?: number;
  /** Optional server-side time range filter/downsampling */
  range?: MarketTimeRange;
  /** Seed data to use if API fails or returns no data */
  seed?: SeedSnapshot;
}

const getSeedSignature = (seed?: SeedSnapshot) => `${seed?.currentPrice ?? ""}`;

/**
 * Hook for fetching and managing perpetual market price history.
 *
 * Loads historical price data from the API and maintains a rolling window
 * of price points. Automatically appends new points from real-time SSE
 * price updates. Falls back to seed data if API fails or returns no data.
 *
 * @param ticker - The ticker symbol of the perp market, or null to clear history
 * @param options - Configuration options including limit and seed data
 *
 * @returns An object containing:
 * - `history`: Array of price history points
 * - `loading`: Whether history is currently loading
 * - `error`: Any error that occurred while loading
 * - `refresh`: Function to manually reload history
 *
 * @example
 * ```tsx
 * const { history, loading } = usePerpHistory(ticker, { limit: 100 });
 *
 * // Use history for charting
 * const chartData = history.map(point => ({
 *   x: point.time,
 *   y: point.price
 * }));
 * ```
 */
export function usePerpHistory(
  ticker: string | null,
  options?: UsePerpHistoryOptions,
) {
  const limit = options?.limit ?? 200;
  const range = options?.range;
  const seedSignature = getSeedSignature(options?.seed);
  const seedRef = useRef<SeedSnapshot | undefined>(options?.seed);
  const [history, setHistory] = useState<PerpHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track live prices for real-time updates
  const livePrices = useMarketPrices(ticker ? [ticker] : []);
  const livePrice = ticker ? livePrices.get(ticker) : undefined;
  const lastAppendedPriceRef = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: seedSignature serializes seed content; avoids unstable `options.seed` identity
  useEffect(() => {
    seedRef.current = options?.seed;
  }, [seedSignature]);

  // If we previously loaded before the market seed was available (common in staging),
  // ensure we still render a minimal chart instead of staying empty forever.
  // Uses seed.currentPrice first, then falls back to livePrice from SSE.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seedSignature triggers re-seed when seed values change; seedRef is not a reactive dep
  useEffect(() => {
    if (!ticker) return;
    if (history.length > 0) return;

    // Try seed.currentPrice first, then fallback to livePrice
    // Note: Number.isFinite already returns false for null/undefined,
    // so the > 0 check is sufficient after the type guard.
    const seedPrice = seedRef.current?.currentPrice;
    const livePriceValue = livePrice?.price;
    const finiteSeedPrice =
      typeof seedPrice === "number" &&
      Number.isFinite(seedPrice) &&
      seedPrice > 0
        ? seedPrice
        : null;
    const finiteLivePrice =
      typeof livePriceValue === "number" &&
      Number.isFinite(livePriceValue) &&
      livePriceValue > 0
        ? livePriceValue
        : null;
    const priceToUse = finiteSeedPrice ?? finiteLivePrice;

    if (!priceToUse) return;

    const now = Date.now();
    const seeded: PerpHistoryPoint[] = [
      {
        time: now - 60_000,
        price: priceToUse,
        change: 0,
        changePercent: 0,
        volume: 0,
      },
      {
        time: now,
        price: priceToUse,
        change: 0,
        changePercent: 0,
        volume: 0,
      },
    ];

    setHistory(seeded);
    lastAppendedPriceRef.current = priceToUse;
  }, [ticker, seedSignature, livePrice?.price, history.length]);

  const formatHistory = useCallback(
    (
      points: Array<{
        price: number | string;
        change?: number | string;
        changePercent?: number | string;
        volume?: number | string | null;
        timestamp: string;
      }>,
    ): PerpHistoryPoint[] => {
      const parsed = points
        .map((point) => {
          const price = Number(point.price);
          const change =
            point.change === undefined ? undefined : Number(point.change);
          const changePercent =
            point.changePercent === undefined
              ? undefined
              : Number(point.changePercent);
          const volume =
            point.volume === null || point.volume === undefined
              ? undefined
              : Number(point.volume);

          return {
            time: new Date(point.timestamp).getTime(),
            price,
            change: Number.isFinite(change ?? Number.NaN) ? change : undefined,
            changePercent: Number.isFinite(changePercent ?? Number.NaN)
              ? changePercent
              : undefined,
            volume: Number.isFinite(volume ?? Number.NaN) ? volume : undefined,
          } satisfies PerpHistoryPoint;
        })
        .filter(
          (point) =>
            Number.isFinite(point.time) &&
            Number.isFinite(point.price) &&
            point.price > 0,
        );

      const seed = seedRef.current?.currentPrice;
      if (!seed || !Number.isFinite(seed) || seed <= 0 || parsed.length < 2) {
        return parsed;
      }

      const sortedPrices = [...parsed]
        .map((p) => p.price)
        .sort((a, b) => a - b);
      const medianPrice =
        sortedPrices[Math.floor(sortedPrices.length / 2)] ?? null;

      if (!medianPrice || !Number.isFinite(medianPrice) || medianPrice <= 0) {
        return parsed;
      }

      // Heuristic: some environments persist prices in a different unit than
      // the market snapshot (e.g., ~x1000). Choose a power-of-10 scale that
      // brings the median history price close to the seed/current price.
      const relDiff = (a: number, b: number) => Math.abs(a - b) / b;
      const candidates = [
        1e-6, 1e-3, 1e-2, 1e-1, 1, 10, 100, 1000, 1e4, 1e5, 1e6,
      ];

      const baseline = relDiff(medianPrice, seed);
      let bestScale = 1;
      let bestDiff = baseline;

      for (const candidate of candidates) {
        const scaled = medianPrice * candidate;
        if (!Number.isFinite(scaled) || scaled <= 0) continue;
        const diff = relDiff(scaled, seed);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestScale = candidate;
        }
      }

      // Only apply scaling if it materially improves alignment and is not wild.
      if (bestScale === 1) return parsed;
      if (!(bestDiff < baseline * 0.2 && bestDiff < 0.5)) return parsed;

      return parsed.map((point) => ({
        ...point,
        price: point.price * bestScale,
        change:
          typeof point.change === "number"
            ? point.change * bestScale
            : undefined,
        volume:
          typeof point.volume === "number"
            ? point.volume * bestScale
            : undefined,
      }));
    },
    [],
  );

  const fallbackFromSeed = useCallback(() => {
    const seed = seedRef.current;
    if (!seed?.currentPrice) return [];
    const now = Date.now();
    // Seed with at least 2 points so the area series always renders visibly.
    return [
      {
        time: now - 60_000,
        price: seed.currentPrice,
        change: 0,
        changePercent: 0,
        volume: 0,
      },
      {
        time: now,
        price: seed.currentPrice,
        change: 0,
        changePercent: 0,
        volume: 0,
      },
    ];
  }, []);

  const fetchHistory = useCallback(async () => {
    if (!ticker) {
      setHistory([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (range) {
        params.set("range", range);
      }
      const response = await fetch(
        apiUrl(
          `/api/markets/perps/${encodeURIComponent(ticker)}/history?${params.toString()}`,
        ),
      );

      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      const record = (data ?? {}) as Record<string, unknown>;
      const historyArray = record.history;

      if (
        response.ok &&
        Array.isArray(historyArray) &&
        historyArray.length > 0
      ) {
        const formatted = formatHistory(
          historyArray as Array<{
            price: number;
            change?: number;
            changePercent?: number;
            volume?: number | null;
            timestamp: string;
          }>,
        );
        setHistory(formatted);
        const latest = formatted.at(-1);
        if (latest) {
          lastAppendedPriceRef.current = latest.price;
        }
      } else {
        if (!response.ok) {
          const message =
            typeof record.error === "string"
              ? record.error
              : `Failed to fetch history: ${response.status}`;
          setError(message);
        }
        // Only seed if we don't already have SSE-accumulated history.
        // fetchHistory can resolve after SSE has already built a real chart;
        // overwriting with the 2-point seed would flatten it.
        setHistory((prev) => (prev.length > 2 ? prev : fallbackFromSeed()));
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch history";
      logger.error(
        "Failed to fetch perp history",
        { ticker, error: err },
        "usePerpHistory",
      );
      setError(message);
      setHistory((prev) => (prev.length > 2 ? prev : fallbackFromSeed()));
    } finally {
      setLoading(false);
    }
  }, [ticker, limit, range, formatHistory, fallbackFromSeed]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  /**
   * Append a new price point to history.
   * Used by both live price updates and trade events.
   */
  const appendPricePoint = useCallback(
    (price: number, volume?: number) => {
      // Only append if price has changed significantly (0.01% threshold)
      const lastPrice = lastAppendedPriceRef.current;
      if (lastPrice) {
        const priceDiff = Math.abs(price - lastPrice) / lastPrice;
        if (priceDiff < 0.0001) return; // Skip tiny changes
      }

      // Update ref BEFORE state setter to avoid mutation inside callback
      // This is safe because we already passed the threshold check above
      lastAppendedPriceRef.current = price;

      setHistory((prev) => {
        const lastPoint = prev.length > 0 ? prev[prev.length - 1] : null;
        const change = lastPoint ? price - lastPoint.price : 0;
        const changePercent = lastPoint?.price
          ? (change / lastPoint.price) * 100
          : 0;

        const point: PerpHistoryPoint = {
          time: Date.now(),
          price,
          change,
          changePercent,
          volume: volume ?? 0,
        };

        const next = [...prev, point];
        if (next.length > limit) {
          next.shift();
        }

        return next;
      });
    },
    [limit],
  );

  // Append live price updates from SSE price_update events
  useEffect(() => {
    if (!livePrice?.price || !ticker) return;
    appendPricePoint(livePrice.price);
  }, [livePrice?.price, ticker, appendPricePoint]);

  // Subscribe to perp trade events for real-time chart updates
  // This ensures the chart updates even when price_update events are not sent
  // (e.g., when price change is too small to trigger a broadcast)
  usePerpMarketStream(ticker, {
    onTrade: useCallback(
      (event: PerpTradeSSE) => {
        // Use exitPrice for close events, entryPrice for open events
        const tradePrice = event.exitPrice ?? event.entryPrice;
        if (tradePrice && Number.isFinite(tradePrice) && tradePrice > 0) {
          appendPricePoint(tradePrice, event.size);
        }
      },
      [appendPricePoint],
    ),
  });

  return {
    history,
    loading,
    error,
    refresh: fetchHistory,
  };
}
