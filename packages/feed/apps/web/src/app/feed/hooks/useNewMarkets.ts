import { logger } from '@feed/shared';
import { useEffect, useState } from 'react';
import type { NewMarketEntry } from '@/app/api/feed/new-markets/route';

interface UseNewMarketsResult {
  markets: NewMarketEntry[];
  loading: boolean;
}

/**
 * Fetches recently opened prediction market questions (last 24h).
 * Used to inject "New Market" trade cards into the Latest feed.
 *
 * Fetches once on mount. The endpoint is cached server-side (short TTL)
 * since odds can change; no SSE subscription needed here — users will
 * see updates on refresh / next tab visit.
 *
 * Note: New Market cards intentionally appear on both the Latest feed
 * (via this hook) and the For You tab (via the ranked feed endpoint).
 * The tabs are mutually exclusive so users never see both simultaneously.
 */
export function useNewMarkets(enabled = true): UseNewMarketsResult {
  const [markets, setMarkets] = useState<NewMarketEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    setLoading(true);

    fetch('/api/feed/new-markets', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { markets?: NewMarketEntry[] };
        setMarkets(data.markets ?? []);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        logger.warn(
          'Failed to fetch new markets',
          { error: err },
          'useNewMarkets'
        );
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [enabled]);

  return { markets, loading };
}
