import { DEFAULT_QUOTE_TOKEN_ADDRESSES } from "../constants";
import type {
  CandidateDetail,
  CandidateRunRecord,
  ExecutionCandidatePlan,
  ExecutionConfig,
  ExecutionGooLane,
  ExecutionReadinessCheck,
  ExecutionState,
  ScoredCandidate,
} from "../types";

function buildReadinessChecks(
  config: ExecutionConfig,
): ExecutionReadinessCheck[] {
  const checks: ExecutionReadinessCheck[] = [
    {
      label: "Execution enabled",
      ready: config.enabled,
      detail: config.enabled
        ? "Execution lane is enabled."
        : "Enable ELIZAOK_EXECUTION_ENABLED to arm live execution modes.",
    },
    {
      label: "Mode selected",
      ready: config.mode === "live_buy_only" || config.mode === "live_full",
      detail:
        config.mode === "paper"
          ? "Execution mode is still paper; switch to live_buy_only or live_full later."
          : `Execution mode ${config.mode} is selected.`,
    },
    {
      label: "BNB RPC configured",
      ready: Boolean(config.rpcUrl),
      detail: config.rpcUrl
        ? "BNB Chain RPC is configured."
        : "Add ELIZAOK_BSC_RPC_URL.",
    },
  ];

  if (!config.dryRun) {
    checks.push(
      {
        label: "Manual live confirm armed",
        ready: config.liveConfirmArmed,
        detail: config.liveConfirmArmed
          ? "Manual live trading confirmation is armed."
          : `Set ELIZAOK_EXECUTION_LIVE_CONFIRM to ${config.liveConfirmPhrase} before any live order is allowed.`,
      },
      {
        label: "Wallet address configured",
        ready: Boolean(config.walletAddress),
        detail: config.walletAddress
          ? "Execution wallet address is configured."
          : "Add ELIZAOK_EXECUTION_WALLET_ADDRESS.",
      },
      {
        label: "Private key configured",
        ready: config.privateKeyConfigured,
        detail: config.privateKeyConfigured
          ? "Execution private key is configured."
          : "Add ELIZAOK_EXECUTION_PRIVATE_KEY on the execution host.",
      },
    );
  }

  if (config.router === "fourmeme") {
    checks.push({
      label: "Four.meme SDK adapter ready",
      ready: true,
      detail: "Four.meme execution is wired through the installed SDK adapter.",
    });
  }

  return checks;
}

function qualifiesForSustainedHeat(
  candidate: Pick<
    ScoredCandidate | CandidateRunRecord,
    | "recommendation"
    | "reserveUsd"
    | "volumeUsdM5"
    | "volumeUsdH1"
    | "buyersM5"
    | "buysM5"
    | "sellersM5"
    | "fdvUsd"
    | "marketCapUsd"
    | "poolAgeMinutes"
    | "priceChangeH1"
  >,
  config: ExecutionConfig,
): boolean {
  const effectiveMcap = candidate.marketCapUsd ?? candidate.fdvUsd;
  const netBuysM5 = (candidate.buysM5 ?? 0) - (candidate.sellersM5 ?? 0);
  return (
    candidate.recommendation === "simulate_buy" &&
    effectiveMcap !== null &&
    effectiveMcap >= config.risk.minEntryMcapUsd &&
    effectiveMcap <= config.risk.maxEntryMcapUsd &&
    candidate.reserveUsd >= config.risk.minLiquidityUsd &&
    candidate.volumeUsdM5 >= config.risk.minVolumeUsdM5 &&
    candidate.volumeUsdH1 >= config.risk.minVolumeUsdH1 &&
    candidate.buyersM5 >= config.risk.minBuyersM5 &&
    netBuysM5 >= config.risk.minNetBuysM5 &&
    candidate.poolAgeMinutes >= config.risk.minPoolAgeMinutes &&
    candidate.poolAgeMinutes <= config.risk.maxPoolAgeMinutes &&
    Math.abs(candidate.priceChangeH1) <= config.risk.maxPriceChangeH1Pct
  );
}

function buildCandidatePlan(
  candidate: ScoredCandidate,
  config: ExecutionConfig,
  previousDetail?: CandidateDetail,
): ExecutionCandidatePlan {
  const reasons: string[] = [];
  const effectiveMcap = candidate.marketCapUsd ?? candidate.fdvUsd;
  const netBuysM5 = candidate.buysM5 - candidate.sellsM5;
  const previousRun =
    previousDetail?.history.find(
      (entry) => entry.runId !== previousDetail.latest.runId,
    ) ?? previousDetail?.history[1];
  const previousHeatConfirmed = previousRun
    ? qualifiesForSustainedHeat(previousRun, config)
    : false;
  const eligible =
    candidate.recommendation === "simulate_buy" &&
    effectiveMcap !== null &&
    effectiveMcap >= config.risk.minEntryMcapUsd &&
    effectiveMcap <= config.risk.maxEntryMcapUsd &&
    candidate.reserveUsd >= config.risk.minLiquidityUsd &&
    candidate.volumeUsdM5 >= config.risk.minVolumeUsdM5 &&
    candidate.volumeUsdH1 >= config.risk.minVolumeUsdH1 &&
    candidate.buyersM5 >= config.risk.minBuyersM5 &&
    netBuysM5 >= config.risk.minNetBuysM5 &&
    candidate.poolAgeMinutes >= config.risk.minPoolAgeMinutes &&
    candidate.poolAgeMinutes <= config.risk.maxPoolAgeMinutes &&
    Math.abs(candidate.priceChangeH1) <= config.risk.maxPriceChangeH1Pct &&
    previousHeatConfirmed &&
    (!config.risk.allowedQuoteOnly ||
      DEFAULT_QUOTE_TOKEN_ADDRESSES.has(
        candidate.quoteTokenAddress.toLowerCase(),
      ));

  if (candidate.recommendation !== "simulate_buy") {
    reasons.push("Candidate is not in simulate_buy state.");
  }
  if (effectiveMcap === null) {
    reasons.push(
      "Market cap / FDV is unavailable, so early-entry range cannot be verified.",
    );
  } else {
    if (effectiveMcap < config.risk.minEntryMcapUsd) {
      reasons.push(
        `Valuation ${Math.round(effectiveMcap)} is below the minimum sustainable-entry floor.`,
      );
    }
    if (effectiveMcap > config.risk.maxEntryMcapUsd) {
      reasons.push(
        `Valuation ${Math.round(effectiveMcap)} is above the early-entry ceiling.`,
      );
    }
  }
  if (candidate.reserveUsd < config.risk.minLiquidityUsd) {
    reasons.push(
      `Liquidity ${Math.round(candidate.reserveUsd)} is below the minimum liquidity gate.`,
    );
  }
  if (candidate.volumeUsdM5 < config.risk.minVolumeUsdM5) {
    reasons.push(
      `5m volume ${Math.round(candidate.volumeUsdM5)} is below the minimum volume gate.`,
    );
  }
  if (candidate.volumeUsdH1 < config.risk.minVolumeUsdH1) {
    reasons.push(
      `1h volume ${Math.round(candidate.volumeUsdH1)} is below the sustained-heat gate.`,
    );
  }
  if (candidate.buyersM5 < config.risk.minBuyersM5) {
    reasons.push(
      `5m buyers ${candidate.buyersM5} is below the holder-quality gate.`,
    );
  }
  if (netBuysM5 < config.risk.minNetBuysM5) {
    reasons.push(`Net buys ${netBuysM5} is below the momentum floor.`);
  }
  if (candidate.poolAgeMinutes < config.risk.minPoolAgeMinutes) {
    reasons.push(
      `Pool age ${candidate.poolAgeMinutes}m is too fresh for stable entry.`,
    );
  }
  if (candidate.poolAgeMinutes > config.risk.maxPoolAgeMinutes) {
    reasons.push(
      `Pool age ${candidate.poolAgeMinutes}m is beyond the early-entry window.`,
    );
  }
  if (Math.abs(candidate.priceChangeH1) > config.risk.maxPriceChangeH1Pct) {
    reasons.push(
      `1h price change ${Math.round(candidate.priceChangeH1)}% is too unstable for entry.`,
    );
  }
  if (!previousRun) {
    reasons.push(
      "Candidate has not yet shown sustained heat across two scans.",
    );
  } else if (!previousHeatConfirmed) {
    reasons.push(
      "Candidate failed the sustained-heat gate in the previous scan.",
    );
  }
  if (
    config.risk.allowedQuoteOnly &&
    !DEFAULT_QUOTE_TOKEN_ADDRESSES.has(
      candidate.quoteTokenAddress.toLowerCase(),
    )
  ) {
    reasons.push(
      `Quote token ${candidate.quoteTokenSymbol} is outside the allowed quote set.`,
    );
  }
  if (eligible) {
    reasons.push(
      "Candidate passes the phase-1 readiness gates for a live buy lane.",
    );
  }

  return {
    tokenAddress: candidate.tokenAddress,
    tokenSymbol: candidate.tokenSymbol,
    recommendation: candidate.recommendation,
    score: candidate.score,
    plannedBuyBnb: Math.min(
      config.risk.maxBuyBnb,
      config.risk.maxDailyDeployBnb,
    ),
    route: config.router,
    eligible,
    routeTradable: "unchecked",
    routeReason: eligible
      ? "Awaiting route preflight."
      : reasons[0] || undefined,
    resolvedRoute: null,
    reasons,
  };
}

export function buildExecutionState(
  config: ExecutionConfig,
  candidates: ScoredCandidate[],
  previousCandidateDetails: CandidateDetail[] = [],
  gooLane?: ExecutionGooLane,
): ExecutionState {
  const previousMap = new Map(
    previousCandidateDetails.map((detail) => [detail.tokenAddress, detail]),
  );
  const readinessChecks = buildReadinessChecks(config);
  const readinessScore = readinessChecks.filter((check) => check.ready).length;
  const readinessTotal = readinessChecks.length;
  const configured = readinessChecks.every((check) => check.ready);
  const liveTradingArmed =
    config.enabled &&
    configured &&
    (config.mode === "live_buy_only" || config.mode === "live_full");
  const plans = candidates
    .slice(0, 10)
    .map((candidate) =>
      buildCandidatePlan(
        candidate,
        config,
        previousMap.get(candidate.tokenAddress),
      ),
    )
    .filter((plan) => plan.recommendation !== "reject");

  return {
    enabled: config.enabled,
    dryRun: config.dryRun,
    mode: config.mode,
    router: config.router,
    configured,
    liveTradingArmed,
    readinessScore,
    readinessTotal,
    readinessChecks,
    nextAction: configured
      ? config.mode === "paper"
        ? "Infrastructure is configured. Switch execution mode out of paper when you want to arm live trading."
        : config.dryRun
          ? "Execution lane is armed in dry-run mode. Dry-run previews no longer require wallet secrets, but live execution still will."
          : config.liveConfirmArmed
            ? "Infrastructure is configured and manually armed for live trading."
            : `Live mode selected, but manual confirmation is not armed. Set ELIZAOK_EXECUTION_LIVE_CONFIRM to ${config.liveConfirmPhrase}.`
      : readinessChecks.find((check) => !check.ready)?.detail ||
        "Complete remaining execution checks.",
    risk: config.risk,
    gooLane,
    plans,
    cycleSummary: {
      consideredCount: plans.length,
      eligibleCount: plans.filter((plan) => plan.eligible).length,
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Execution cycle has not run yet for this snapshot.",
    },
  };
}
