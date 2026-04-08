import type {
  ScoredCandidate,
  TreasuryConfig,
  TreasurySimulation,
} from "./types";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function buildTreasurySimulation(
  candidates: ScoredCandidate[],
  treasury: TreasuryConfig,
): TreasurySimulation {
  const reservePct = clampPercent(treasury.reservePct);
  const paperCapitalUsd = treasury.paperCapitalUsd;
  const reserveUsd = Math.round((paperCapitalUsd * reservePct) / 100);
  const deployableCapitalUsd = Math.max(0, paperCapitalUsd - reserveUsd);

  const selected = candidates
    .filter((candidate) => candidate.recommendation === "simulate_buy")
    .slice(0, treasury.maxActivePositions);

  const weightBase = selected.reduce(
    (sum, candidate) => sum + candidate.score,
    0,
  );
  const positions = selected.map((candidate) => {
    const weight = weightBase > 0 ? candidate.score / weightBase : 0;
    const allocationUsd = Math.round(deployableCapitalUsd * weight);
    const allocationPct =
      paperCapitalUsd > 0
        ? Math.round((allocationUsd / paperCapitalUsd) * 1000) / 10
        : 0;

    return {
      tokenSymbol: candidate.tokenSymbol,
      tokenAddress: candidate.tokenAddress,
      recommendation: candidate.recommendation,
      score: candidate.score,
      allocationUsd,
      allocationPct,
      fdvUsd: candidate.fdvUsd,
      reserveUsd: candidate.reserveUsd,
      source: candidate.source,
      thesis: candidate.thesis.slice(0, 2),
    };
  });

  const allocatedUsd = positions.reduce(
    (sum, position) => sum + position.allocationUsd,
    0,
  );
  const dryPowderUsd = Math.max(0, paperCapitalUsd - reserveUsd - allocatedUsd);
  const averagePositionUsd =
    positions.length > 0 ? Math.round(allocatedUsd / positions.length) : 0;

  return {
    paperCapitalUsd,
    deployableCapitalUsd,
    allocatedUsd,
    dryPowderUsd,
    reserveUsd,
    reservePct,
    positionCount: positions.length,
    averagePositionUsd,
    highestConvictionSymbol: positions[0]?.tokenSymbol,
    strategyNote:
      positions.length > 0
        ? "Paper treasury allocates into the top simulated-buy names while preserving a reserve buffer for future scans."
        : "No capital is deployed until candidates clear the simulate-buy threshold.",
    positions,
  };
}
