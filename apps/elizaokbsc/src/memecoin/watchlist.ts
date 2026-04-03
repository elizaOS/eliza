import type {
  CandidateDetail,
  CandidateRunRecord,
  CandidateWatchlistEntry,
  ScoredCandidate,
} from "./types";

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function recordCandidateRun(
  runId: string,
  generatedAt: string,
  candidate: ScoredCandidate
): CandidateRunRecord {
  return {
    runId,
    generatedAt,
    tokenSymbol: candidate.tokenSymbol,
    tokenAddress: candidate.tokenAddress,
    poolAddress: candidate.poolAddress,
    dexId: candidate.dexId,
    score: candidate.score,
    recommendation: candidate.recommendation,
    conviction: candidate.conviction,
    reserveUsd: candidate.reserveUsd,
    volumeUsdM5: candidate.volumeUsdM5,
    volumeUsdH1: candidate.volumeUsdH1,
    buysM5: candidate.buysM5,
    sellersM5: candidate.sellersM5,
    buyersM5: candidate.buyersM5,
    poolAgeMinutes: candidate.poolAgeMinutes,
    priceChangeH1: candidate.priceChangeH1,
    fdvUsd: candidate.fdvUsd,
    marketCapUsd: candidate.marketCapUsd,
    thesis: candidate.thesis,
    risks: candidate.risks,
  };
}

export function mergeCandidateHistory(
  existingHistory: CandidateDetail[],
  runId: string,
  generatedAt: string,
  candidates: ScoredCandidate[],
  historyLimitPerCandidate = 12
): CandidateDetail[] {
  const byToken = new Map(existingHistory.map((detail) => [detail.tokenAddress, detail]));

  for (const candidate of candidates) {
    const record = recordCandidateRun(runId, generatedAt, candidate);
    const existing = byToken.get(candidate.tokenAddress);

    if (!existing) {
      byToken.set(candidate.tokenAddress, {
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.tokenSymbol,
        latest: record,
        history: [record],
      });
      continue;
    }

    const mergedHistory = [record, ...existing.history.filter((entry) => entry.runId !== runId)].slice(
      0,
      historyLimitPerCandidate
    );
    byToken.set(candidate.tokenAddress, {
      tokenAddress: candidate.tokenAddress,
      tokenSymbol: candidate.tokenSymbol,
      latest: record,
      history: mergedHistory,
    });
  }

  return Array.from(byToken.values()).sort(
    (a, b) => Date.parse(b.latest.generatedAt) - Date.parse(a.latest.generatedAt)
  );
}

export function buildWatchlist(candidateDetails: CandidateDetail[]): CandidateWatchlistEntry[] {
  return candidateDetails
    .map((detail) => {
      const scores = detail.history.map((entry) => entry.score);
      const latest = detail.latest;
      const previousScore = detail.history[1]?.score ?? latest.score;

      return {
        tokenAddress: detail.tokenAddress,
        tokenSymbol: detail.tokenSymbol,
        currentScore: latest.score,
        currentRecommendation: latest.recommendation,
        currentConviction: latest.conviction,
        appearances: detail.history.length,
        firstSeenAt: detail.history[detail.history.length - 1]?.generatedAt || latest.generatedAt,
        lastSeenAt: latest.generatedAt,
        bestScore: Math.max(...scores),
        averageScore: average(scores),
        scoreChange: latest.score - previousScore,
        reserveUsd: latest.reserveUsd,
        volumeUsdM5: latest.volumeUsdM5,
        thesis: latest.thesis.slice(0, 2),
        risks: latest.risks.slice(0, 2),
      };
    })
    .sort((a, b) => {
      if (b.currentScore !== a.currentScore) return b.currentScore - a.currentScore;
      if (b.appearances !== a.appearances) return b.appearances - a.appearances;
      return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    });
}
