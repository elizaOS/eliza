/**
 * Real Price Service
 *
 * Fetches real-world cryptocurrency prices from CoinGecko (free API, no key needed)
 * and maps them to parody organization tickers for simulation grounding.
 *
 * Stock-based parody orgs use hardcoded reference prices (CoinGecko free tier
 * doesn't cover equities). These are updated manually as approximations.
 *
 * Falls back to hardcoded defaults on network failure — never throws.
 */

import { logger } from '@babylon/shared';

interface CachedPrices {
  prices: Map<string, number>;
  changes: Map<string, number>;
  fetchedAt: number;
}

interface PriceMapping {
  /** Parody org file ID (matches the filename in data/organizations/) */
  orgFileId: string;
  /** Source: 'coingecko' for live fetch, 'static' for hardcoded reference */
  source: 'coingecko' | 'static';
  /** CoinGecko ID (only used if source='coingecko') */
  coinGeckoId?: string;
  /** Static reference price (used for stocks or as fallback) */
  staticPrice: number;
}

/**
 * Maps parody orgs to real-world price sources.
 *
 * Crypto assets: fetched live from CoinGecko (free, no API key).
 * Stock-based orgs: static reference prices (CoinGecko free tier doesn't cover equities).
 */
const PRICE_MAPPINGS: PriceMapping[] = [
  // === CRYPTO (live from CoinGecko) ===
  {
    orgFileId: 'ethereum-foundaition',
    source: 'coingecko',
    coinGeckoId: 'ethereum',
    staticPrice: 2100,
  },
  {
    orgFileId: 'zcaish',
    source: 'coingecko',
    coinGeckoId: 'zcash',
    staticPrice: 240,
  },

  // === STOCKS (static reference prices — CoinGecko doesn't cover equities) ===
  { orgFileId: 'nvidai', source: 'static', staticPrice: 950 },
  { orgFileId: 'teslai', source: 'static', staticPrice: 250 },
  { orgFileId: 'aipple', source: 'static', staticPrice: 225 },
  { orgFileId: 'maicrosoft', source: 'static', staticPrice: 420 },
  { orgFileId: 'aimazon', source: 'static', staticPrice: 195 },
  { orgFileId: 'aiphabet', source: 'static', staticPrice: 165 },
  { orgFileId: 'palaintir', source: 'static', staticPrice: 80 },
  { orgFileId: 'netflaix', source: 'static', staticPrice: 900 },
  { orgFileId: 'straitegy', source: 'static', staticPrice: 330 },
  { orgFileId: 'spaicex', source: 'static', staticPrice: 180 },
  { orgFileId: 'neurailink', source: 'static', staticPrice: 22 },
  { orgFileId: 'aitropic', source: 'static', staticPrice: 45 },
  { orgFileId: 'airk-invest', source: 'static', staticPrice: 55 },
];

/** Core crypto always fetched for market context */
const CORE_CRYPTO_IDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'chainlink',
  'dogecoin',
];

const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000;

class RealPriceService {
  private cache: CachedPrices | null = null;

  /**
   * Fetch latest crypto prices from CoinGecko. Caches for 5 minutes.
   * Never throws — returns fallback data on failure.
   */
  async fetchPrices(): Promise<Map<string, number>> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.prices;
    }

    // Only fetch crypto IDs that we actually map to
    const cryptoMappings = PRICE_MAPPINGS.filter(
      (m) => m.source === 'coingecko' && m.coinGeckoId
    );
    const allIds = [
      ...CORE_CRYPTO_IDS,
      ...cryptoMappings.map((m) => m.coinGeckoId!),
    ];
    const uniqueIds = [...new Set(allIds)];

    const prices = new Map<string, number>();
    const changes = new Map<string, number>();

    try {
      const url = `${COINGECKO_API}?ids=${uniqueIds.join(',')}&vs_currencies=usd&include_24hr_change=true`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`CoinGecko returned ${response.status}`);
      }

      const data = (await response.json()) as Record<
        string,
        { usd?: number; usd_24h_change?: number }
      >;

      for (const id of uniqueIds) {
        const entry = data[id];
        if (entry?.usd) {
          prices.set(id, entry.usd);
          if (entry.usd_24h_change != null) {
            changes.set(id, entry.usd_24h_change);
          }
        }
      }

      logger.info(
        `Fetched ${prices.size} crypto prices from CoinGecko`,
        {
          btc: prices.get('bitcoin'),
          eth: prices.get('ethereum'),
          sol: prices.get('solana'),
        },
        'RealPriceService'
      );
    } catch (err) {
      logger.warn(
        'CoinGecko fetch failed, using static prices only',
        err instanceof Error ? err : undefined,
        'RealPriceService'
      );
    }

    // Always add static prices for stock-based orgs
    // (these don't come from CoinGecko)
    for (const mapping of PRICE_MAPPINGS) {
      if (mapping.source === 'static') {
        // Use a synthetic key for static prices
        prices.set(`static:${mapping.orgFileId}`, mapping.staticPrice);
      }
    }

    this.cache = { prices, changes, fetchedAt: Date.now() };
    return prices;
  }

  /**
   * Get the real-world base price for a parody organization.
   * Returns null if no mapping exists.
   */
  getBasePriceForOrg(orgFileId: string): number | null {
    const mapping = PRICE_MAPPINGS.find((m) => m.orgFileId === orgFileId);
    if (!mapping) return null;

    if (mapping.source === 'coingecko' && mapping.coinGeckoId) {
      const livePrice = this.cache?.prices.get(mapping.coinGeckoId);
      return livePrice ?? mapping.staticPrice;
    }

    return mapping.staticPrice;
  }

  /**
   * Get real-world market context string for prompt injection.
   * Shows actual BTC, ETH, SOL prices + 24h changes.
   */
  getMarketContextForPrompt(): string {
    if (!this.cache) return '';

    const lines: string[] = [];

    const format = (id: string, label: string) => {
      const price = this.cache!.prices.get(id);
      const change = this.cache!.changes.get(id);
      if (!price) return;
      const changeStr =
        change != null
          ? ` (${change >= 0 ? '+' : ''}${change.toFixed(1)}% 24h)`
          : '';
      if (price >= 1000) {
        lines.push(`${label}: $${price.toLocaleString()}${changeStr}`);
      } else if (price >= 1) {
        lines.push(`${label}: $${price.toFixed(2)}${changeStr}`);
      } else {
        lines.push(`${label}: $${price.toFixed(4)}${changeStr}`);
      }
    };

    format('bitcoin', 'Bitcoin');
    format('ethereum', 'Ethereum');
    format('solana', 'Solana');
    format('chainlink', 'Chainlink');
    format('dogecoin', 'Dogecoin');

    if (lines.length === 0) return '';

    // Add overall sentiment
    const btcChange = this.cache.changes.get('bitcoin') ?? 0;
    const ethChange = this.cache.changes.get('ethereum') ?? 0;
    const avgChange = (btcChange + ethChange) / 2;
    const sentiment =
      avgChange > 2
        ? 'strongly bullish'
        : avgChange > 0
          ? 'slightly bullish'
          : avgChange > -2
            ? 'slightly bearish'
            : 'strongly bearish';

    return `REAL-WORLD CRYPTO MARKETS (use these to ground in-world prices):\n${lines.join('\n')}\nOverall sentiment: ${sentiment}`;
  }
}

export const realPriceService = new RealPriceService();
