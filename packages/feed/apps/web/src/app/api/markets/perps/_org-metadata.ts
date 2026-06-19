import type { PerpMarketRecord } from "@feed/core/markets/perps";
import { db, organizations } from "@feed/db";
import { inArray } from "drizzle-orm";

/**
 * Merge Organization display name + logo for perp rows by ticker.
 * On-chain snapshots use `${symbol} Perpetual` as name; this replaces with org data.
 */
export async function mergeOrganizationMetadataForPerpMarkets(
  markets: PerpMarketRecord[],
): Promise<PerpMarketRecord[]> {
  if (markets.length === 0) return markets;

  const tickers = [...new Set(markets.map((m) => m.ticker.toUpperCase()))];
  const orgRows = await db
    .select({
      ticker: organizations.ticker,
      name: organizations.name,
      imageUrl: organizations.imageUrl,
    })
    .from(organizations)
    .where(inArray(organizations.ticker, tickers));

  const byTicker = new Map(
    orgRows
      .filter((r): r is typeof r & { ticker: string } =>
        Boolean(r.ticker?.trim()),
      )
      .map((r) => [r.ticker.toUpperCase(), r]),
  );

  return markets.map((m) => {
    const org = byTicker.get(m.ticker.toUpperCase());
    if (!org) return m;
    return {
      ...m,
      name: org.name,
      imageUrl: org.imageUrl ?? m.imageUrl ?? null,
    };
  });
}
