import {
  DEFAULT_QUOTE_TOKEN_ADDRESSES,
  TARGET_EARLY_MCAP_USD,
} from "./constants";
import type { ScoreWeightBoosts } from "./strategy-absorption";
import type { PoolSnapshot, ScoredCandidate } from "./types";

const DEFAULT_WEIGHTS: ScoreWeightBoosts = {
  kolWeight: 1.0,
  holderWeight: 1.0,
  liquidityWeight: 1.0,
  volumeWeight: 1.0,
  trendingWeight: 1.0,
};

let activeWeights: ScoreWeightBoosts = { ...DEFAULT_WEIGHTS };

export function setScoreWeights(weights: ScoreWeightBoosts): void {
  activeWeights = { ...weights };
}

export function getScoreWeights(): ScoreWeightBoosts {
  return { ...activeWeights };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
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

function w(base: number, weight: number): number {
  return Math.round(base * weight);
}

export function scoreCandidate(candidate: PoolSnapshot): ScoredCandidate {
  let score = 30;
  const thesis: string[] = [];
  const risks: string[] = [];
  const wt = activeWeights;

  const effectiveMcap = candidate.marketCapUsd ?? candidate.fdvUsd;
  if (effectiveMcap !== null && effectiveMcap <= TARGET_EARLY_MCAP_USD) {
    score += 24;
    thesis.push(
      `Early-stage valuation remains under the $${TARGET_EARLY_MCAP_USD.toLocaleString()} target.`,
    );
  } else if (effectiveMcap !== null && effectiveMcap <= 150_000) {
    score += 14;
    thesis.push(
      "Valuation is still relatively early for a first-pass watchlist.",
    );
  } else if (effectiveMcap !== null && effectiveMcap > 500_000) {
    score -= 12;
    risks.push(
      "Valuation is already stretched versus the early-entry mandate.",
    );
  } else {
    score -= 4;
    risks.push("Valuation is incomplete, so conviction is lower.");
  }

  if (candidate.reserveUsd >= 20_000) {
    score += w(18, wt.liquidityWeight);
    thesis.push(
      "Liquidity reserve is strong enough for a controlled simulated entry.",
    );
  } else if (candidate.reserveUsd >= 10_000) {
    score += w(12, wt.liquidityWeight);
    thesis.push(
      "Liquidity is adequate for monitoring and possible small-size entry.",
    );
  } else if (candidate.reserveUsd >= 5_000) {
    score += w(5, wt.liquidityWeight);
    thesis.push("Liquidity exists, but size should stay conservative.");
  } else {
    score -= 18;
    risks.push(
      "Liquidity reserve is very thin and could break under volatility.",
    );
  }

  if (candidate.volumeUsdM5 >= 5_000) {
    score += w(14, wt.volumeWeight);
    thesis.push(
      "Recent volume confirms live market interest instead of a dead launch.",
    );
  } else if (candidate.volumeUsdM5 >= 1_000) {
    score += w(9, wt.volumeWeight);
    thesis.push(
      "Short-term volume is healthy enough to justify a closer look.",
    );
  } else if (candidate.volumeUsdM5 > 0) {
    score += 3;
  } else {
    score -= 6;
    risks.push("No recent volume signal in the last 5 minutes.");
  }

  const orderFlowDelta = candidate.buysM5 - candidate.sellsM5;
  if (candidate.buyersM5 >= 4 && orderFlowDelta > 0) {
    score += 10;
    thesis.push("Buy-side order flow currently outweighs sell pressure.");
  } else if (candidate.buysM5 === 0) {
    score -= 6;
    risks.push("The launch has not yet shown enough buy-side participation.");
  } else if (orderFlowDelta < 0) {
    score -= 5;
    risks.push("Sell pressure is already leading the early order flow.");
  }

  if (candidate.poolAgeMinutes <= 120) {
    score += 12;
    thesis.push(
      "The pool is extremely fresh, which fits the early-discovery mandate.",
    );
  } else if (candidate.poolAgeMinutes <= 1_440) {
    score += 6;
    thesis.push("The pool is still recent enough for the watchlist.");
  } else {
    score -= 5;
    risks.push(
      "The pool is no longer especially fresh, reducing first-mover advantage.",
    );
  }

  if (DEFAULT_QUOTE_TOKEN_ADDRESSES.has(candidate.quoteTokenAddress)) {
    score += 8;
    thesis.push(
      `Quote pair ${candidate.quoteTokenSymbol} improves routing and execution confidence.`,
    );
  }

  if (candidate.source === "trending_pools") {
    score += w(8, wt.trendingWeight);
    thesis.push(
      "Trending-pool discovery suggests the market is already paying attention.",
    );
  } else {
    score += 4;
  }

  if (Math.abs(candidate.priceChangeH1) >= 35) {
    score -= 6;
    risks.push("1h price swing is elevated, which raises chase-risk.");
  }

  const finalScore = clampScore(score);
  const recommendation = getRecommendation(finalScore);

  if (recommendation === "simulate_buy") {
    thesis.push(
      "Candidate is strong enough to enter the simulated treasury queue.",
    );
  } else if (recommendation === "watch") {
    thesis.push("Candidate merits watchlist tracking before simulated entry.");
  } else if (recommendation === "reject") {
    risks.push("Current setup does not justify treasury attention.");
  }

  return {
    ...candidate,
    score: finalScore,
    recommendation,
    conviction: getConviction(finalScore),
    thesis,
    risks,
  };
}

export function scoreCandidates(candidates: PoolSnapshot[]): ScoredCandidate[] {
  return candidates.map(scoreCandidate).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.reserveUsd - a.reserveUsd;
  });
}
