import { useCallback, useMemo, useRef } from "react";

import { useSSEChannel } from "@/hooks/useSSE";
import type { TradeSide } from "@/types/markets";

/**
 * SSE event for perpetual market trades.
 *
 * Actions include:
 * - 'open': New position opened
 * - 'close': Position fully closed
 * - 'partial_close': Position partially closed
 * - 'add_to_position': Added to existing position (same side)
 * - 'flip_position': Closed existing and opened inverse position
 */
export interface PerpTradeSSE {
  type: "perp_trade";
  action:
    | "open"
    | "close"
    | "partial_close"
    | "add_to_position"
    | "flip_position";
  ticker: string;
  side: TradeSide;
  size: number;
  leverage: number;
  entryPrice: number;
  exitPrice?: number;
  positionId: string;
  realizedPnL?: number;
  openInterest: number;
  volume24h: number;
  timestamp: string;
}

/**
 * Type guard to check if data is a valid perp trade SSE payload.
 */
const isPerpTradePayload = (data: unknown): data is PerpTradeSSE => {
  if (!data || typeof data !== "object" || data === null) return false;
  const payload = data as { type?: string; ticker?: string };
  return payload.type === "perp_trade" && typeof payload.ticker === "string";
};

/**
 * Options for configuring perp market stream subscriptions.
 */
interface UsePerpMarketStreamOptions {
  /** Callback invoked when a trade event is received */
  onTrade?: (event: PerpTradeSSE) => void;
}

/**
 * Hook for subscribing to real-time perp market trades for a specific ticker.
 *
 * Subscribes to the 'markets' SSE channel and filters events for the specified
 * ticker. Automatically handles subscription lifecycle and ensures callbacks
 * receive the latest version.
 *
 * @param ticker - The ticker symbol to subscribe to, or null to unsubscribe
 * @param options - Callback functions for trade events
 *
 * @example
 * ```tsx
 * usePerpMarketStream('AAPL', {
 *   onTrade: (event) => {
 *     console.log('Trade:', event.action, event.size);
 *     // Update local state or trigger refetch
 *   },
 * });
 * ```
 */
export function usePerpMarketStream(
  ticker: string | null,
  { onTrade }: UsePerpMarketStreamOptions = {},
) {
  const normalizedTicker = useMemo(
    () => (ticker ? ticker.toUpperCase() : null),
    [ticker],
  );

  // Use ref to avoid stale closure issues with callbacks
  const onTradeRef = useRef(onTrade);
  onTradeRef.current = onTrade;

  const handleMessage = useCallback(
    (payload: Record<string, unknown>) => {
      if (!isPerpTradePayload(payload)) return;
      if (
        normalizedTicker &&
        payload.ticker.toUpperCase() !== normalizedTicker
      ) {
        return;
      }

      onTradeRef.current?.(payload);
    },
    [normalizedTicker],
  );

  useSSEChannel("markets", handleMessage);
}

/**
 * Options for subscribing to all perp market trades (not filtered by ticker).
 */
interface UsePerpMarketsSubscriptionOptions {
  /** Callback invoked when any perp trade event is received */
  onTrade?: (event: PerpTradeSSE) => void;
}

/**
 * Hook for subscribing to ALL perp market trade events.
 *
 * Unlike usePerpMarketStream which filters by ticker, this hook receives
 * all perp trade events. Useful for:
 * - Updating market list stats (OI, volume) in real-time
 * - Global trade feeds
 * - Store synchronization
 *
 * @param options - Callback functions for trade events
 *
 * @example
 * ```tsx
 * usePerpMarketsSubscription({
 *   onTrade: (event) => {
 *     // Update store with new OI/volume
 *     updateMarketStats(event.ticker, {
 *       openInterest: event.openInterest,
 *       volume24h: event.volume24h,
 *     });
 *   },
 * });
 * ```
 */
export function usePerpMarketsSubscription({
  onTrade,
}: UsePerpMarketsSubscriptionOptions = {}) {
  // Use ref to avoid stale closure issues with callbacks
  const onTradeRef = useRef(onTrade);
  onTradeRef.current = onTrade;

  const handleMessage = useCallback((payload: Record<string, unknown>) => {
    if (!isPerpTradePayload(payload)) return;
    onTradeRef.current?.(payload);
  }, []);

  useSSEChannel("markets", handleMessage);
}

/**
 * SSE event for perpetual market price updates.
 */
export interface PerpPriceUpdateSSE {
  type: "perp_price_update";
  ticker: string;
  organizationId?: string;
  newPrice?: number;
  price?: number;
  change?: number;
  changePercent?: number;
}

/**
 * Type guard to check if data is a valid perp price update SSE payload.
 */
const isPerpPriceUpdatePayload = (
  data: unknown,
): data is { updates: PerpPriceUpdateSSE[] } => {
  if (!data || typeof data !== "object" || data === null) return false;
  const payload = data as { type?: string; updates?: unknown[] };
  return payload.type === "perp_price_update" && Array.isArray(payload.updates);
};

/**
 * Options for subscribing to perp price updates.
 */
interface UsePerpPriceSubscriptionOptions {
  /** Callback invoked when a price update event is received */
  onPriceUpdate?: (update: PerpPriceUpdateSSE) => void;
}

/**
 * Hook for subscribing to perp market price update events.
 *
 * Listens for `perp_price_update` events on the 'markets' SSE channel.
 * These events are triggered when user trades cause price impact.
 *
 * @param options - Callback functions for price update events
 */
export function usePerpPriceSubscription({
  onPriceUpdate,
}: UsePerpPriceSubscriptionOptions = {}) {
  const onPriceUpdateRef = useRef(onPriceUpdate);
  onPriceUpdateRef.current = onPriceUpdate;

  const handleMessage = useCallback((payload: Record<string, unknown>) => {
    if (!isPerpPriceUpdatePayload(payload)) return;

    for (const update of payload.updates) {
      if (update && typeof update === "object" && update.ticker) {
        onPriceUpdateRef.current?.(update);
      }
    }
  }, []);

  useSSEChannel("markets", handleMessage);
}
