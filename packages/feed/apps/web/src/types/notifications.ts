/**
 * Shared types and type guards for market-resolution notification payloads.
 * Used by both the SSE listener (useMarketOutcomeListener) and the queued
 * offline delivery hook (useQueuedOutcomes).
 */

export interface MarketResolvedData {
  marketId: string;
  marketName: string;
  outcome: 'win' | 'loss';
  points: number;
  agentName?: string;
  deepLink: string;
}

export function isMarketResolvedData(d: unknown): d is MarketResolvedData {
  if (typeof d !== 'object' || d === null) return false;
  const rec = d as Record<string, unknown>;
  return (
    typeof rec.marketId === 'string' &&
    typeof rec.marketName === 'string' &&
    (rec.outcome === 'win' || rec.outcome === 'loss') &&
    typeof rec.points === 'number' &&
    typeof rec.deepLink === 'string'
  );
}
