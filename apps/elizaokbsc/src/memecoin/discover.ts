import { GECKO_TERMINAL_API_BASE, GECKO_TERMINAL_NETWORK } from "./constants";
import type { DiscoveryConfig, DiscoverySource, PoolSnapshot } from "./types";

interface GeckoPoolRecord {
  id: string;
  attributes?: {
    address?: string;
    name?: string;
    pool_created_at?: string;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    reserve_in_usd?: string | null;
    volume_usd?: {
      m5?: string;
      h1?: string;
    };
    transactions?: {
      m5?: {
        buys?: number;
        sells?: number;
        buyers?: number;
        sellers?: number;
      };
    };
    price_change_percentage?: {
      h1?: string;
    };
  };
  relationships?: {
    base_token?: {
      data?: {
        id?: string;
      };
    };
    quote_token?: {
      data?: {
        id?: string;
      };
    };
    dex?: {
      data?: {
        id?: string;
      };
    };
  };
}

interface GeckoResponse {
  data?: GeckoPoolRecord[];
}

function parseNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTokenAddress(raw: string | undefined): string {
  return raw?.split("_")[1]?.toLowerCase() || "unknown";
}

function getTokenSymbol(poolName: string, index: number): string {
  const parts = poolName.split("/").map((part) => part.trim());
  return parts[index] || "UNKNOWN";
}

function toSnapshot(record: GeckoPoolRecord, source: DiscoverySource): PoolSnapshot | null {
  const attrs = record.attributes;
  const rel = record.relationships;
  if (!attrs?.address || !attrs?.name || !attrs.pool_created_at) {
    return null;
  }

  const now = Date.now();
  const createdAtMs = Date.parse(attrs.pool_created_at);
  const ageMinutes = Number.isFinite(createdAtMs)
    ? Math.max(0, Math.round((now - createdAtMs) / 60_000))
    : 0;

  return {
    source,
    poolAddress: attrs.address.toLowerCase(),
    dexId: rel?.dex?.data?.id || "unknown-dex",
    poolName: attrs.name,
    tokenAddress: parseTokenAddress(rel?.base_token?.data?.id),
    tokenSymbol: getTokenSymbol(attrs.name, 0),
    quoteTokenAddress: parseTokenAddress(rel?.quote_token?.data?.id),
    quoteTokenSymbol: getTokenSymbol(attrs.name, 1),
    fdvUsd: parseNumber(attrs.fdv_usd),
    marketCapUsd: parseNumber(attrs.market_cap_usd),
    reserveUsd: parseNumber(attrs.reserve_in_usd) || 0,
    volumeUsdM5: parseNumber(attrs.volume_usd?.m5) || 0,
    volumeUsdH1: parseNumber(attrs.volume_usd?.h1) || 0,
    buysM5: attrs.transactions?.m5?.buys || 0,
    sellsM5: attrs.transactions?.m5?.sells || 0,
    buyersM5: attrs.transactions?.m5?.buyers || 0,
    sellersM5: attrs.transactions?.m5?.sellers || 0,
    priceChangeH1: parseNumber(attrs.price_change_percentage?.h1) || 0,
    poolCreatedAt: attrs.pool_created_at,
    poolAgeMinutes: ageMinutes,
    fetchedAt: new Date(now).toISOString(),
  };
}

async function fetchPools(source: DiscoverySource, limit: number): Promise<PoolSnapshot[]> {
  if (limit <= 0) {
    return [];
  }

  const endpoint =
    source === "new_pools"
      ? `/networks/${GECKO_TERMINAL_NETWORK}/new_pools?page=1`
      : `/networks/${GECKO_TERMINAL_NETWORK}/trending_pools?page=1`;

  const response = await fetch(`${GECKO_TERMINAL_API_BASE}${endpoint}`, {
    headers: {
      Accept: "application/json;version=20230203",
    },
  });

  if (!response.ok) {
    throw new Error(`GeckoTerminal ${source} request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as GeckoResponse;
  const records = payload.data || [];

  return records
    .map((record) => toSnapshot(record, source))
    .filter((record): record is PoolSnapshot => Boolean(record))
    .slice(0, limit);
}

export async function discoverBnbPools(config: DiscoveryConfig): Promise<PoolSnapshot[]> {
  const [newPools, trendingPools] = await Promise.all([
    fetchPools("new_pools", config.newPoolsLimit),
    fetchPools("trending_pools", config.trendingPoolsLimit),
  ]);

  const deduped = new Map<string, PoolSnapshot>();
  for (const candidate of [...newPools, ...trendingPools]) {
    const existing = deduped.get(candidate.poolAddress);
    if (!existing) {
      deduped.set(candidate.poolAddress, candidate);
      continue;
    }

    if (existing.source === "new_pools" && candidate.source === "trending_pools") {
      deduped.set(candidate.poolAddress, candidate);
    }
  }

  return Array.from(deduped.values()).slice(0, config.maxCandidates);
}
