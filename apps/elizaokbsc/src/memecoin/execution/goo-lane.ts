import type {
  DiscoveryConfig,
  ExecutionGooLane,
  ExecutionGooProposal,
  GooAgentCandidate,
  TradeLedger,
} from "../types";

function buildProposal(
  candidate: GooAgentCandidate,
  config: DiscoveryConfig,
): ExecutionGooProposal {
  const reserveBnb = Math.min(
    candidate.minimumCtoBnb,
    config.execution.risk.maxDailyDeployBnb,
  );
  const affordable =
    candidate.minimumCtoBnb > 0 &&
    candidate.minimumCtoBnb <= config.execution.risk.maxDailyDeployBnb;

  if (candidate.recommendation === "cto_candidate" && affordable) {
    return {
      agentId: candidate.agentId,
      tokenAddress: candidate.tokenAddress,
      status: candidate.status,
      recommendation: candidate.recommendation,
      minimumCtoBnb: candidate.minimumCtoBnb,
      treasuryBnb: candidate.treasuryBnb,
      reserveBnb,
      action: "reserve_treasury",
      reason: `Reserve ${reserveBnb.toFixed(4)} BNB for Goo CTO research because agent ${candidate.agentId} is ${candidate.status} and within the current treasury budget.`,
    };
  }

  if (
    candidate.recommendation === "cto_candidate" ||
    candidate.recommendation === "priority_due_diligence"
  ) {
    return {
      agentId: candidate.agentId,
      tokenAddress: candidate.tokenAddress,
      status: candidate.status,
      recommendation: candidate.recommendation,
      minimumCtoBnb: candidate.minimumCtoBnb,
      treasuryBnb: candidate.treasuryBnb,
      reserveBnb: 0,
      action: "due_diligence",
      reason:
        candidate.minimumCtoBnb > config.execution.risk.maxDailyDeployBnb
          ? `Agent ${candidate.agentId} is interesting, but its CTO floor ${candidate.minimumCtoBnb.toFixed(4)} BNB is above the current daily treasury budget.`
          : `Agent ${candidate.agentId} stays in Goo due diligence because the turnaround signal is strong but not urgent enough to reserve treasury yet.`,
    };
  }

  return {
    agentId: candidate.agentId,
    tokenAddress: candidate.tokenAddress,
    status: candidate.status,
    recommendation: candidate.recommendation,
    minimumCtoBnb: candidate.minimumCtoBnb,
    treasuryBnb: candidate.treasuryBnb,
    reserveBnb: 0,
    action: candidate.recommendation === "monitor" ? "monitor" : "ignore",
    reason:
      candidate.recommendation === "monitor"
        ? `Agent ${candidate.agentId} remains on the monitor list but does not affect treasury deployment.`
        : `Agent ${candidate.agentId} is ignored for treasury execution purposes right now.`,
  };
}

export function buildExecutionGooLane(
  config: DiscoveryConfig,
  gooCandidates: GooAgentCandidate[],
  tradeLedger?: TradeLedger | null,
): ExecutionGooLane {
  if (!config.goo.enabled) {
    return {
      enabled: false,
      reviewedCount: 0,
      priorityCount: 0,
      reserveBnb: 0,
      blocksMemecoinBuys: false,
      note: "Goo lane is disabled.",
      proposals: [],
    };
  }

  const proposals = gooCandidates
    .slice(0, 5)
    .map((candidate) => buildProposal(candidate, config));
  const priorityCount = proposals.filter(
    (proposal) =>
      proposal.action === "reserve_treasury" ||
      proposal.action === "due_diligence",
  ).length;
  const reservedProposal =
    proposals.find((proposal) => proposal.action === "reserve_treasury") ??
    null;
  const reserveBnb = reservedProposal?.reserveBnb ?? 0;
  const executedTodayBnb =
    tradeLedger?.records
      .filter((record) => record.disposition === "executed")
      .reduce((sum, record) => sum + record.plannedBuyBnb, 0) ?? 0;
  const remainingDailyCapacity = Math.max(
    0,
    config.execution.risk.maxDailyDeployBnb - executedTodayBnb,
  );
  const blocksMemecoinBuys = Boolean(
    reservedProposal &&
      reserveBnb >= remainingDailyCapacity &&
      remainingDailyCapacity > 0,
  );

  return {
    enabled: true,
    reviewedCount: gooCandidates.length,
    priorityCount,
    reserveBnb,
    blocksMemecoinBuys,
    note: reservedProposal
      ? blocksMemecoinBuys
        ? `${reservedProposal.reason} Memecoin buys are paused until Goo treasury review clears or the daily cap resets.`
        : `${reservedProposal.reason} Remaining memecoin deployment is reduced by the reserved Goo amount.`
      : priorityCount > 0
        ? "Goo lane has due-diligence targets, but none are reserving treasury yet."
        : "No Goo targets currently affect treasury deployment.",
    proposals,
  };
}
