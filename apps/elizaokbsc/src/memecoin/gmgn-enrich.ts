/**
 * Market Intelligence Candidate Enrichment
 *
 * Enhances scored candidates with real-time market intelligence data (KOL presence,
 * holder growth, smart money activity) to produce better buy signals.
 */

import { fetchHolderCount, fetchKolHolders, fetchTopHolders } from "./gmgn-service";
import type { ScoredCandidate } from "./types";

export interface GmgnEnrichment {
  kolCount: number;
  kolTotalUsd: number;
  holderCount: number;
  top10HoldPct: number;
  smartMoneyPresent: boolean;
  enrichedAt: string;
}

export interface EnrichedCandidate extends ScoredCandidate {
  gmgn?: GmgnEnrichment;
  gmgnScoreBoost: number;
  originalScore: number;
}

async function enrichSingle(candidate: ScoredCandidate): Promise<EnrichedCandidate> {
  const [holderSnap, kolSignal, topSnap] = await Promise.all([
    fetchHolderCount(candidate.tokenAddress).catch(() => null),
    fetchKolHolders(candidate.tokenAddress).catch(() => null),
    fetchTopHolders(candidate.tokenAddress).catch(() => null),
  ]);

  let boost = 0;
  const thesis = [...candidate.thesis];
  const risks = [...candidate.risks];

  const kolCount = kolSignal?.kolCount ?? 0;
  const kolUsd = kolSignal?.totalKolUsd ?? 0;
  const holderCount = holderSnap?.holderCount ?? 0;
  const top10Pct = topSnap?.totalTopHoldPct ?? holderSnap?.top10HoldPct ?? 0;
  const smartMoney = kolCount >= 2 || kolUsd > 5000;

  // KOL presence boosts confidence
  if (kolCount >= 3) {
    boost += 12;
    thesis.push(`${kolCount} KOLs holding — strong smart money signal.`);
  } else if (kolCount >= 2) {
    boost += 8;
    thesis.push(`${kolCount} KOLs detected — moderate smart money signal.`);
  } else if (kolCount === 1) {
    boost += 3;
    thesis.push("1 KOL detected — early smart money interest.");
  }

  // Holder count signals organic interest
  if (holderCount >= 200) {
    boost += 8;
    thesis.push(`Strong holder base (${holderCount}) indicates organic demand.`);
  } else if (holderCount >= 100) {
    boost += 5;
    thesis.push(`Decent holder count (${holderCount}).`);
  } else if (holderCount >= 50) {
    boost += 2;
  } else if (holderCount > 0 && holderCount < 20) {
    boost -= 5;
    risks.push(`Very few holders (${holderCount}) — possible insider-only token.`);
  }

  // Top holder concentration risk
  if (top10Pct > 80) {
    boost -= 10;
    risks.push(`Top 10 hold ${top10Pct.toFixed(0)}% — extreme concentration risk.`);
  } else if (top10Pct > 60) {
    boost -= 5;
    risks.push(`Top 10 hold ${top10Pct.toFixed(0)}% — high concentration.`);
  } else if (top10Pct > 0 && top10Pct < 40) {
    boost += 4;
    thesis.push(`Healthy distribution: top 10 hold only ${top10Pct.toFixed(0)}%.`);
  }

  // Smart money KOL USD value
  if (kolUsd > 10000) {
    boost += 6;
    thesis.push(`KOLs have $${(kolUsd / 1000).toFixed(1)}k invested — high conviction.`);
  } else if (kolUsd > 5000) {
    boost += 3;
  }

  const boostedScore = Math.max(0, Math.min(100, candidate.score + boost));

  return {
    ...candidate,
    score: boostedScore,
    originalScore: candidate.score,
    gmgnScoreBoost: boost,
    thesis,
    risks,
    recommendation: getRecommendation(boostedScore),
    conviction: getConviction(boostedScore),
    gmgn: {
      kolCount,
      kolTotalUsd: kolUsd,
      holderCount,
      top10HoldPct: top10Pct,
      smartMoneyPresent: smartMoney,
      enrichedAt: new Date().toISOString(),
    },
  };
}

function getRecommendation(score: number): ScoredCandidate["recommendation"] {
  if (score >= 72) return "simulate_buy";
  if (score >= 58) return "watch";
  if (score >= 40) return "observe";
  return "reject";
}

function getConviction(score: number): ScoredCandidate["conviction"] {
  if (score >= 72) return "high";
  if (score >= 50) return "medium";
  return "low";
}

/**
 * Enrich top candidates with market intelligence data. Only enriches the top N
 * to stay within API rate limits.
 */
export async function enrichCandidatesWithGmgn(
  candidates: ScoredCandidate[],
  maxToEnrich: number = 15,
): Promise<EnrichedCandidate[]> {
  const topCandidates = candidates.slice(0, maxToEnrich);
  const rest = candidates.slice(maxToEnrich);

  const enriched: EnrichedCandidate[] = [];
  for (const c of topCandidates) {
    try {
      const e = await enrichSingle(c);
      enriched.push(e);
      await new Promise(r => setTimeout(r, 250));
    } catch {
      enriched.push({
        ...c,
        originalScore: c.score,
        gmgnScoreBoost: 0,
      });
    }
  }

  const passThrough: EnrichedCandidate[] = rest.map(c => ({
    ...c,
    originalScore: c.score,
    gmgnScoreBoost: 0,
  }));

  const all = [...enriched, ...passThrough];
  all.sort((a, b) => b.score - a.score || b.reserveUsd - a.reserveUsd);
  return all;
}
