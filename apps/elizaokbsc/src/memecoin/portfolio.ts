import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  PortfolioLifecycle,
  PortfolioPosition,
  PortfolioPositionState,
  ScoredCandidate,
  TradeLedger,
  TreasuryConfig,
  TreasurySimulation,
  TreasuryTimelineEvent,
} from "./types";

export interface GmgnExitSignal {
  holderDropPct?: number;
  kolExited?: boolean;
  kolExitCount?: number;
  topHolderDumpPct?: number;
}

export interface KolTpSignal {
  recommendedTpPct: number;
  kolCount: number;
  confidence: "high" | "medium" | "low";
}

function referenceUsd(candidate: {
  fdvUsd: number | null;
  reserveUsd: number;
}): number | null {
  if (candidate.fdvUsd && candidate.fdvUsd > 0) return candidate.fdvUsd;
  if (candidate.reserveUsd > 0) return candidate.reserveUsd;
  return null;
}

function pnlPct(entry: number | null, current: number | null): number {
  if (!entry || entry <= 0 || !current) return 0;
  return Math.round(((current - entry) / entry) * 100 * 10) / 10;
}

function positionValue(
  allocationUsd: number,
  entryReferenceUsd: number | null,
  currentReferenceUsd: number | null,
) {
  if (allocationUsd <= 0) return 0;
  if (
    !entryReferenceUsd ||
    entryReferenceUsd <= 0 ||
    !currentReferenceUsd ||
    currentReferenceUsd <= 0
  ) {
    return allocationUsd;
  }

  const ratio = currentReferenceUsd / entryReferenceUsd;
  const cappedRatio = Math.min(ratio, 20);
  return Math.round(allocationUsd * cappedRatio);
}

function buildPositionBase(params: {
  candidate: ScoredCandidate;
  existing?: PortfolioPosition;
  generatedAt: string;
  allocationUsd: number;
  entryReferenceUsd: number | null;
}): PortfolioPosition {
  const { candidate, existing, generatedAt, allocationUsd, entryReferenceUsd } =
    params;
  const currentReferenceUsd = referenceUsd(candidate);
  const currentValueUsd = positionValue(
    allocationUsd,
    entryReferenceUsd,
    currentReferenceUsd,
  );

  return {
    tokenAddress: candidate.tokenAddress,
    tokenSymbol: candidate.tokenSymbol,
    executionSource: existing?.executionSource ?? "paper",
    walletVerification: existing?.walletVerification ?? "unverified",
    walletTokenBalance: existing?.walletTokenBalance ?? null,
    walletTokenDecimals: existing?.walletTokenDecimals ?? null,
    walletCheckedAt: existing?.walletCheckedAt ?? null,
    walletQuoteRoute: existing?.walletQuoteRoute ?? null,
    walletQuoteBnb: existing?.walletQuoteBnb ?? null,
    walletQuoteUsd: existing?.walletQuoteUsd ?? null,
    firstSeenAt: existing?.firstSeenAt ?? generatedAt,
    lastUpdatedAt: generatedAt,
    state: allocationUsd > 0 ? "active" : "watch",
    source: candidate.source,
    thesis: candidate.thesis.slice(0, 2),
    costBasisBnb: existing?.costBasisBnb ?? null,
    initialAllocationUsd: existing?.initialAllocationUsd ?? allocationUsd,
    entryScore: existing?.entryScore ?? candidate.score,
    currentScore: candidate.score,
    allocationUsd,
    currentValueUsd,
    totalProceedsUsd: existing?.totalProceedsUsd ?? 0,
    realizedPnlUsd: existing?.realizedPnlUsd ?? 0,
    unrealizedPnlUsd: currentValueUsd - allocationUsd,
    unrealizedPnlPct: pnlPct(entryReferenceUsd, currentReferenceUsd),
    entryReferenceUsd,
    currentReferenceUsd,
    lastRecommendation: candidate.recommendation,
    lastConviction: candidate.conviction,
    appearanceCount: (existing?.appearanceCount ?? 0) + 1,
    takeProfitCount: existing?.takeProfitCount ?? 0,
    takeProfitStagesHit: [...(existing?.takeProfitStagesHit ?? [])],
    exitReason: undefined,
    peakValueUsd: Math.max(existing?.peakValueUsd ?? 0, currentValueUsd),
    peakPnlPct: Math.max(
      existing?.peakPnlPct ?? 0,
      pnlPct(entryReferenceUsd, currentReferenceUsd),
    ),
    trailingStopTriggered: false,
    gmgnExitReason: undefined,
  };
}

function applyTakeProfit(
  position: PortfolioPosition,
  treasury: TreasuryConfig,
  cashBalanceUsd: number,
  runId: string,
  generatedAt: string,
  timeline: TreasuryTimelineEvent[],
  kolTpSignals?: Record<string, KolTpSignal>,
): number {
  const currentGainPct = pnlPct(
    position.entryReferenceUsd,
    position.currentReferenceUsd,
  );

  // KOL-adaptive take profit: if KOLs typically sell at X%, and we're past X%, trigger early TP
  const kolSignal = kolTpSignals?.[position.tokenAddress];
  if (kolSignal && kolSignal.confidence !== "low" && currentGainPct >= kolSignal.recommendedTpPct) {
    const kolLabel = `kol_adaptive_${kolSignal.recommendedTpPct.toFixed(0)}`;
    if (!position.takeProfitStagesHit.includes(kolLabel)) {
      const sellFraction = kolSignal.confidence === "high" ? 0.30 : 0.20;
      const soldCostBasisUsd = Math.round(position.allocationUsd * sellFraction);
      const soldValueUsd = Math.round(position.currentValueUsd * sellFraction);
      if (soldCostBasisUsd > 0 && soldValueUsd > 0) {
        position.allocationUsd = Math.max(0, position.allocationUsd - soldCostBasisUsd);
        position.currentValueUsd = Math.max(0, position.currentValueUsd - soldValueUsd);
        position.totalProceedsUsd += soldValueUsd;
        position.realizedPnlUsd += soldValueUsd - soldCostBasisUsd;
        position.takeProfitCount += 1;
        position.takeProfitStagesHit.push(kolLabel);
        position.unrealizedPnlUsd = position.currentValueUsd - position.allocationUsd;
        position.unrealizedPnlPct = position.allocationUsd > 0
          ? Math.round((position.unrealizedPnlUsd / position.allocationUsd) * 100 * 10) / 10 : 0;
        timeline.push({
          runId, generatedAt, type: "take_profit",
          tokenAddress: position.tokenAddress, tokenSymbol: position.tokenSymbol,
          detail: `KOL-adaptive TP: ${kolSignal.kolCount} KOLs avg sell at +${kolSignal.recommendedTpPct.toFixed(0)}%, sold ${(sellFraction*100).toFixed(0)}% (${kolSignal.confidence} confidence).`,
          stateAfter: position.allocationUsd > 0 ? "active" : "exited",
        });
        cashBalanceUsd += soldValueUsd;
      }
    }
  }

  for (const rule of treasury.takeProfitRules) {
    if (position.takeProfitStagesHit.includes(rule.label)) continue;
    if (currentGainPct < rule.gainPct) continue;
    if (position.allocationUsd <= 0 || position.currentValueUsd <= 0) break;

    const sellFraction = Math.max(0, Math.min(1, rule.sellPct / 100));
    const soldCostBasisUsd = Math.round(position.allocationUsd * sellFraction);
    const soldValueUsd = Math.round(position.currentValueUsd * sellFraction);
    if (soldCostBasisUsd <= 0 || soldValueUsd <= 0) continue;

    position.allocationUsd = Math.max(
      0,
      position.allocationUsd - soldCostBasisUsd,
    );
    position.currentValueUsd = Math.max(
      0,
      position.currentValueUsd - soldValueUsd,
    );
    position.totalProceedsUsd += soldValueUsd;
    position.realizedPnlUsd += soldValueUsd - soldCostBasisUsd;
    position.takeProfitCount += 1;
    position.takeProfitStagesHit.push(rule.label);
    position.unrealizedPnlUsd =
      position.currentValueUsd - position.allocationUsd;
    position.unrealizedPnlPct =
      position.allocationUsd > 0
        ? Math.round(
            (position.unrealizedPnlUsd / position.allocationUsd) * 100 * 10,
          ) / 10
        : 0;

    timeline.push({
      runId,
      generatedAt,
      type: "take_profit",
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      detail: `${rule.label} triggered at +${rule.gainPct}% and sold ${rule.sellPct}% of the remaining paper position.`,
      stateAfter: position.allocationUsd > 0 ? "active" : "exited",
    });

    cashBalanceUsd += soldValueUsd;
  }

  return cashBalanceUsd;
}

function checkTrailingStop(
  position: PortfolioPosition,
  treasury: TreasuryConfig,
): string | null {
  if (treasury.trailingStopPct <= 0) return null;
  const peakPct = position.peakPnlPct ?? 0;
  if (peakPct < treasury.trailingStopActivatePct) return null;

  const currentPct = position.unrealizedPnlPct;
  const drawdown = peakPct - currentPct;
  if (drawdown >= treasury.trailingStopPct) {
    return `Trailing stop triggered: peak was +${peakPct.toFixed(1)}%, current +${currentPct.toFixed(1)}%, drawdown ${drawdown.toFixed(1)}% exceeds ${treasury.trailingStopPct}% threshold.`;
  }
  return null;
}

function checkGmgnExit(
  position: PortfolioPosition,
  treasury: TreasuryConfig,
  gmgnSignals?: Record<string, GmgnExitSignal>,
): string | null {
  if (!treasury.gmgnExitEnabled || !gmgnSignals) return null;
  const signal = gmgnSignals[position.tokenAddress];
  if (!signal) return null;

  if (signal.holderDropPct && Math.abs(signal.holderDropPct) >= treasury.holderDropExitThreshold) {
    return `Holder exodus: ${signal.holderDropPct.toFixed(1)}% holder drop detected (threshold: ${treasury.holderDropExitThreshold}%).`;
  }
  if (treasury.kolExitEnabled && signal.kolExited) {
    return `KOL exit detected: ${signal.kolExitCount ?? 1} KOL(s) sold their positions.`;
  }
  if (signal.topHolderDumpPct && Math.abs(signal.topHolderDumpPct) >= treasury.topHolderDumpPct) {
    return `Top holder dump: top holders reduced ${Math.abs(signal.topHolderDumpPct).toFixed(1)}% (threshold: ${treasury.topHolderDumpPct}%).`;
  }
  return null;
}

function exitReasonForPosition(
  candidate: ScoredCandidate,
  position: PortfolioPosition,
  treasury: TreasuryConfig,
  gmgnSignals?: Record<string, GmgnExitSignal>,
): string | null {
  if (position.allocationUsd <= 0)
    return "Position fully harvested by take-profit rules.";

  // Smart exit (highest priority — real-time market intelligence)
  const gmgnReason = checkGmgnExit(position, treasury, gmgnSignals);
  if (gmgnReason) {
    position.gmgnExitReason = gmgnReason;
    return gmgnReason;
  }

  // Trailing stop (protects gains)
  const trailingReason = checkTrailingStop(position, treasury);
  if (trailingReason) {
    position.trailingStopTriggered = true;
    return trailingReason;
  }

  // Hard stop loss
  if (position.unrealizedPnlPct <= treasury.stopLossPct) {
    return `Stop loss triggered at ${position.unrealizedPnlPct}% versus the ${treasury.stopLossPct}% threshold.`;
  }

  // Score degradation
  if (candidate.score <= treasury.exitScoreThreshold) {
    return `Signal score fell to ${candidate.score}, below the treasury exit floor of ${treasury.exitScoreThreshold}.`;
  }
  if (
    candidate.recommendation === "observe" ||
    candidate.recommendation === "reject"
  ) {
    return `Signal downgraded to ${candidate.recommendation}, so the paper treasury exited the position.`;
  }

  return null;
}

function finalizePositionState(
  position: PortfolioPosition,
  preferredState: PortfolioPositionState = "watch",
) {
  if (position.allocationUsd > 0) {
    position.state = "active";
    position.exitReason = undefined;
    position.unrealizedPnlUsd =
      position.currentValueUsd - position.allocationUsd;
    position.unrealizedPnlPct =
      position.allocationUsd > 0
        ? Math.round(
            (position.unrealizedPnlUsd / position.allocationUsd) * 100 * 10,
          ) / 10
        : 0;
    return;
  }

  position.currentValueUsd = 0;
  position.unrealizedPnlUsd = 0;
  position.unrealizedPnlPct = 0;
  position.state = preferredState;
}

function parseTokenAmount(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeLiveExecutedTrades(params: {
  portfolio: PortfolioLifecycle;
  tradeLedger: TradeLedger;
  candidates: ScoredCandidate[];
  generatedAt: string;
  runId: string;
}): PortfolioLifecycle {
  const { portfolio, tradeLedger, candidates, generatedAt, runId } = params;
  const executedRecords = tradeLedger.records.filter(
    (record) =>
      record.disposition === "executed" &&
      ((record.plannedBuyUsd ?? 0) > 0 ||
        (record.quoteUsd ?? 0) > 0 ||
        record.side === "sell"),
  );

  if (executedRecords.length === 0) {
    return portfolio;
  }

  const candidateMap = new Map(
    candidates.map((candidate) => [candidate.tokenAddress, candidate]),
  );
  const allPositions = [
    ...portfolio.activePositions,
    ...portfolio.watchPositions,
    ...portfolio.exitedPositions,
  ];
  const nextPositions = new Map(
    allPositions.map((position) => [position.tokenAddress, position]),
  );
  const liveTimeline: TreasuryTimelineEvent[] = [];

  for (const [tokenAddress, trades] of executedRecords.reduce((map, record) => {
    const list = map.get(record.tokenAddress) ?? [];
    list.push(record);
    map.set(record.tokenAddress, list);
    return map;
  }, new Map<string, typeof executedRecords>())) {
    const existing = nextPositions.get(tokenAddress);
    const candidate = candidateMap.get(tokenAddress);
    const buyTrades = trades.filter((trade) => trade.side !== "sell");
    const sellTrades = trades.filter((trade) => trade.side === "sell");
    const plannedBuyUsd = buyTrades.reduce(
      (sum, trade) => sum + (trade.plannedBuyUsd ?? 0),
      0,
    );
    const plannedBuyBnb = buyTrades.reduce(
      (sum, trade) => sum + trade.plannedBuyBnb,
      0,
    );
    const boughtTokenAmount = buyTrades.reduce(
      (sum, trade) => sum + parseTokenAmount(trade.tokenAmount),
      0,
    );
    const soldTokenAmount = sellTrades.reduce(
      (sum, trade) => sum + parseTokenAmount(trade.tokenAmount),
      0,
    );
    const quotedSellUsd = sellTrades.reduce(
      (sum, trade) => sum + (trade.quoteUsd ?? trade.plannedBuyUsd ?? 0),
      0,
    );
    const costPerTokenUsd =
      boughtTokenAmount > 0 ? plannedBuyUsd / boughtTokenAmount : 0;
    const costPerTokenBnb =
      boughtTokenAmount > 0 ? plannedBuyBnb / boughtTokenAmount : 0;
    const soldCostBasisUsd =
      costPerTokenUsd *
      Math.min(soldTokenAmount, boughtTokenAmount || soldTokenAmount);
    const soldCostBasisBnb =
      costPerTokenBnb *
      Math.min(soldTokenAmount, boughtTokenAmount || soldTokenAmount);
    const remainingAllocationUsd = Math.max(
      0,
      plannedBuyUsd - soldCostBasisUsd,
    );
    const remainingCostBasisBnb = Math.max(0, plannedBuyBnb - soldCostBasisBnb);
    if (plannedBuyUsd <= 0 && quotedSellUsd <= 0) continue;

    const weightedEntryReferenceUsd =
      plannedBuyUsd > 0
        ? buyTrades.reduce(
            (sum, trade) =>
              sum + (trade.entryReferenceUsd ?? 0) * (trade.plannedBuyUsd ?? 0),
            0,
          ) / plannedBuyUsd
        : null;
    const currentReferenceUsd = candidate
      ? referenceUsd(candidate)
      : (existing?.currentReferenceUsd ?? null);
    const currentValueUsd = positionValue(
      remainingAllocationUsd,
      weightedEntryReferenceUsd,
      currentReferenceUsd,
    );
    const base: PortfolioPosition = {
      tokenAddress,
      tokenSymbol:
        candidate?.tokenSymbol ??
        existing?.tokenSymbol ??
        trades[0]?.tokenSymbol ??
        tokenAddress,
      executionSource: existing
        ? existing.executionSource === "paper"
          ? "hybrid"
          : existing.executionSource
        : "live",
      walletVerification: existing?.walletVerification ?? "unverified",
      walletTokenBalance: existing?.walletTokenBalance ?? null,
      walletTokenDecimals: existing?.walletTokenDecimals ?? null,
      walletCheckedAt: existing?.walletCheckedAt ?? null,
      walletQuoteRoute: existing?.walletQuoteRoute ?? null,
      walletQuoteBnb: existing?.walletQuoteBnb ?? null,
      walletQuoteUsd: existing?.walletQuoteUsd ?? null,
      firstSeenAt:
        existing?.firstSeenAt ?? trades[0]?.generatedAt ?? generatedAt,
      lastUpdatedAt: generatedAt,
      state: remainingAllocationUsd > 0 ? "active" : "exited",
      source: candidate?.source ?? existing?.source ?? "new_pools",
      thesis: candidate?.thesis.slice(0, 2) ??
        existing?.thesis ?? ["Live execution imported from trade ledger."],
      costBasisBnb: remainingCostBasisBnb,
      initialAllocationUsd: plannedBuyUsd,
      entryScore: existing?.entryScore ?? candidate?.score ?? 0,
      currentScore: candidate?.score ?? existing?.currentScore ?? 0,
      allocationUsd: remainingAllocationUsd,
      currentValueUsd,
      totalProceedsUsd: quotedSellUsd,
      realizedPnlUsd: quotedSellUsd - soldCostBasisUsd,
      unrealizedPnlUsd: currentValueUsd - remainingAllocationUsd,
      unrealizedPnlPct: pnlPct(weightedEntryReferenceUsd, currentReferenceUsd),
      entryReferenceUsd: weightedEntryReferenceUsd,
      currentReferenceUsd,
      lastRecommendation:
        candidate?.recommendation ?? existing?.lastRecommendation ?? "watch",
      lastConviction:
        candidate?.conviction ?? existing?.lastConviction ?? "low",
      appearanceCount: existing?.appearanceCount ?? trades.length,
      takeProfitCount: existing?.takeProfitCount ?? 0,
      takeProfitStagesHit: existing?.takeProfitStagesHit ?? [],
      exitReason:
        existing?.state === "exited" ? undefined : existing?.exitReason,
    };

    if (existing && existing.executionSource === "paper") {
      base.initialAllocationUsd = existing.initialAllocationUsd + plannedBuyUsd;
      base.allocationUsd = existing.allocationUsd + remainingAllocationUsd;
      base.currentValueUsd = existing.currentValueUsd + currentValueUsd;
      base.costBasisBnb = (existing.costBasisBnb ?? 0) + remainingCostBasisBnb;
      base.realizedPnlUsd =
        existing.realizedPnlUsd + (quotedSellUsd - soldCostBasisUsd);
      base.totalProceedsUsd = existing.totalProceedsUsd + quotedSellUsd;
      base.unrealizedPnlUsd = base.currentValueUsd - base.allocationUsd;
      base.unrealizedPnlPct =
        base.allocationUsd > 0
          ? Math.round(
              (base.unrealizedPnlUsd / base.allocationUsd) * 100 * 10,
            ) / 10
          : 0;
    }

    if (base.allocationUsd <= 0 && sellTrades.length > 0) {
      base.state = "exited";
      base.exitReason = "Live position fully exited.";
    }

    nextPositions.set(tokenAddress, base);

    for (const trade of trades.filter((record) => record.runId === runId)) {
      liveTimeline.push({
        runId,
        generatedAt,
        type: trade.side === "sell" ? "exited" : "entered",
        tokenAddress,
        tokenSymbol: base.tokenSymbol,
        detail:
          trade.side === "sell"
            ? `Live sell recorded for ${trade.tokenAmount || "unknown"} tokens with ${trade.quoteUsd ? `$${trade.quoteUsd}` : "unknown"} proceeds.`
            : `Live buy recorded for ${trade.plannedBuyBnb} BNB.`,
        stateAfter: base.state,
      });
    }
  }

  const allMergedPositions = Array.from(nextPositions.values());
  const activePositions = allMergedPositions
    .filter((position) => position.state === "active")
    .sort((a, b) => b.currentScore - a.currentScore);
  const watchPositions = allMergedPositions
    .filter((position) => position.state === "watch")
    .sort((a, b) => b.currentScore - a.currentScore);
  const MAX_EXITED = 50;
  const exitedPositions = allMergedPositions
    .filter((position) => position.state === "exited")
    .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt))
    .slice(0, MAX_EXITED);
  const totalAllocatedUsd = activePositions.reduce(
    (sum, position) => sum + position.allocationUsd,
    0,
  );
  const totalCurrentValueUsd = activePositions.reduce(
    (sum, position) => sum + position.currentValueUsd,
    0,
  );
  const keptPositions = [...activePositions, ...watchPositions, ...exitedPositions];
  const totalRealizedPnlUsd = keptPositions.reduce(
    (sum, position) => sum + position.realizedPnlUsd,
    0,
  );
  const totalUnrealizedPnlUsd = activePositions.reduce(
    (sum, position) => sum + position.unrealizedPnlUsd,
    0,
  );
  const totalUnrealizedPnlPct =
    totalAllocatedUsd > 0
      ? Math.round((totalUnrealizedPnlUsd / totalAllocatedUsd) * 100 * 10) / 10
      : 0;

  return {
    ...portfolio,
    activePositions,
    watchPositions,
    exitedPositions,
    timeline: [...liveTimeline, ...portfolio.timeline].slice(0, 80),
    totalAllocatedUsd,
    totalCurrentValueUsd,
    totalRealizedPnlUsd,
    totalUnrealizedPnlUsd,
    totalUnrealizedPnlPct,
    grossPortfolioValueUsd:
      portfolio.cashBalanceUsd + totalCurrentValueUsd + portfolio.reservedUsd,
    healthNote:
      executedRecords.length > 0
        ? `Hybrid portfolio view is active. Executed live trades are overlaid on top of the paper treasury using recorded trade cost basis.`
        : portfolio.healthNote,
  };
}

export async function loadPortfolioLifecycle(
  reportsDir: string,
): Promise<PortfolioLifecycle | null> {
  const absoluteReportsDir = path.isAbsolute(reportsDir)
    ? reportsDir
    : path.join(process.cwd(), reportsDir);
  const portfolioPath = path.join(absoluteReportsDir, "portfolio.json");

  try {
    const content = await readFile(portfolioPath, "utf8");
    return JSON.parse(content) as PortfolioLifecycle;
  } catch {
    return null;
  }
}

export function buildPortfolioLifecycle(params: {
  previous?: PortfolioLifecycle | null;
  runId: string;
  generatedAt: string;
  candidates: ScoredCandidate[];
  treasurySimulation: TreasurySimulation;
  treasury: TreasuryConfig;
  tradeLedger?: TradeLedger | null;
  gmgnSignals?: Record<string, GmgnExitSignal>;
  kolTpSignals?: Record<string, KolTpSignal>;
}): PortfolioLifecycle {
  const {
    previous,
    runId,
    generatedAt,
    candidates,
    treasurySimulation,
    treasury,
    tradeLedger,
    gmgnSignals,
    kolTpSignals,
  } = params;
  const previousPositions = [
    ...(previous?.activePositions ?? []),
    ...(previous?.watchPositions ?? []),
    ...(previous?.exitedPositions ?? []),
  ];
  const previousMap = new Map(
    previousPositions.map((position) => [position.tokenAddress, position]),
  );
  const targetMap = new Map(
    treasurySimulation.positions.map((position) => [
      position.tokenAddress,
      position.allocationUsd,
    ]),
  );

  const nextPositions = new Map<string, PortfolioPosition>();
  const timeline: TreasuryTimelineEvent[] = [];
  let cashBalanceUsd =
    previous?.cashBalanceUsd ?? treasurySimulation.deployableCapitalUsd;

  for (const candidate of candidates) {
    const existing = previousMap.get(candidate.tokenAddress);
    const targetAllocationUsd = targetMap.get(candidate.tokenAddress) ?? 0;
    const wantsEntry =
      candidate.recommendation === "simulate_buy" && targetAllocationUsd > 0;
    const isFreshEntry =
      wantsEntry &&
      (!existing || existing.state === "exited" || existing.allocationUsd <= 0);

    if (isFreshEntry) {
      const entryAllocationUsd = Math.min(targetAllocationUsd, cashBalanceUsd);
      const position = buildPositionBase({
        candidate,
        existing,
        generatedAt,
        allocationUsd: entryAllocationUsd,
        entryReferenceUsd: referenceUsd(candidate),
      });
      position.initialAllocationUsd = entryAllocationUsd;
      position.takeProfitCount = 0;
      position.takeProfitStagesHit = [];
      finalizePositionState(
        position,
        entryAllocationUsd > 0 ? "active" : "watch",
      );
      nextPositions.set(candidate.tokenAddress, position);

      if (entryAllocationUsd > 0) {
        cashBalanceUsd -= entryAllocationUsd;
        timeline.push({
          runId,
          generatedAt,
          type: existing ? "promoted" : "entered",
          tokenAddress: candidate.tokenAddress,
          tokenSymbol: candidate.tokenSymbol,
          detail:
            existing?.state === "exited"
              ? "Re-entered the paper treasury after a fresh buy signal."
              : "Entered the paper treasury as a new active position.",
          stateAfter: "active",
        });
      } else {
        timeline.push({
          runId,
          generatedAt,
          type: "watched",
          tokenAddress: candidate.tokenAddress,
          tokenSymbol: candidate.tokenSymbol,
          detail:
            "Signal qualified for entry, but there was no free paper cash to deploy this cycle.",
          stateAfter: "watch",
        });
      }
      continue;
    }

    if (!existing) {
      const watchPosition = buildPositionBase({
        candidate,
        generatedAt,
        allocationUsd: 0,
        entryReferenceUsd: referenceUsd(candidate),
      });
      finalizePositionState(watchPosition, "watch");
      nextPositions.set(candidate.tokenAddress, watchPosition);
      timeline.push({
        runId,
        generatedAt,
        type: "watched",
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.tokenSymbol,
        detail: "Added to the treasury watchlist for follow-up monitoring.",
        stateAfter: "watch",
      });
      continue;
    }

    const position = buildPositionBase({
      candidate,
      existing,
      generatedAt,
      allocationUsd: existing.allocationUsd,
      entryReferenceUsd: existing.entryReferenceUsd ?? referenceUsd(candidate),
    });

    cashBalanceUsd = applyTakeProfit(
      position,
      treasury,
      cashBalanceUsd,
      runId,
      generatedAt,
      timeline,
      kolTpSignals,
    );
    const exitReason = exitReasonForPosition(candidate, position, treasury, gmgnSignals);

    if (exitReason) {
      if (position.currentValueUsd > 0) {
        cashBalanceUsd += position.currentValueUsd;
        position.totalProceedsUsd += position.currentValueUsd;
        position.realizedPnlUsd +=
          position.currentValueUsd - position.allocationUsd;
      }
      position.allocationUsd = 0;
      position.exitReason = exitReason;
      finalizePositionState(position, "exited");
      timeline.push({
        runId,
        generatedAt,
        type: "exited",
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.tokenSymbol,
        detail: exitReason,
        stateAfter: "exited",
      });
    } else if (existing.state !== position.state) {
      timeline.push({
        runId,
        generatedAt,
        type: position.state === "active" ? "promoted" : "watched",
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.tokenSymbol,
        detail:
          position.state === "active"
            ? "Promoted from watch into the active paper treasury basket."
            : "Moved out of active deployment and into watch mode.",
        stateAfter: position.state,
      });
    }

    nextPositions.set(candidate.tokenAddress, position);
  }

  for (const existing of previousPositions) {
    if (nextPositions.has(existing.tokenAddress)) continue;
    if (existing.state === "exited") {
      nextPositions.set(existing.tokenAddress, existing);
      continue;
    }

    // Apply take-profit rules before closing, so TP count stays consistent
    if (existing.allocationUsd > 0 && existing.currentValueUsd > 0) {
      cashBalanceUsd = applyTakeProfit(
        existing, treasury, cashBalanceUsd,
        runId, generatedAt, timeline, kolTpSignals,
      );
    }

    const exitValueUsd = existing.currentValueUsd || existing.allocationUsd;
    const exitedPosition: PortfolioPosition = {
      ...existing,
      lastUpdatedAt: generatedAt,
      allocationUsd: 0,
      currentValueUsd: 0,
      totalProceedsUsd: existing.totalProceedsUsd + exitValueUsd,
      realizedPnlUsd:
        existing.realizedPnlUsd + (exitValueUsd - existing.allocationUsd),
      unrealizedPnlUsd: 0,
      unrealizedPnlPct: 0,
      state: "exited",
      exitReason:
        "Position vanished from the scan universe and was closed from the paper treasury.",
    };
    nextPositions.set(existing.tokenAddress, exitedPosition);
    cashBalanceUsd += exitValueUsd;
    timeline.push({
      runId,
      generatedAt,
      type: "exited",
      tokenAddress: existing.tokenAddress,
      tokenSymbol: existing.tokenSymbol,
      detail: exitedPosition.exitReason || "Position exited.",
      stateAfter: "exited",
    });
  }

  const allPositions = Array.from(nextPositions.values());
  const activePositions = allPositions
    .filter((position) => position.state === "active")
    .sort((a, b) => b.currentScore - a.currentScore);
  const watchPositions = allPositions
    .filter((position) => position.state === "watch")
    .sort((a, b) => b.currentScore - a.currentScore);
  const MAX_EXITED = 50;
  const exitedPositions = allPositions
    .filter((position) => position.state === "exited")
    .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt))
    .slice(0, MAX_EXITED);

  const totalAllocatedUsd = activePositions.reduce(
    (sum, position) => sum + position.allocationUsd,
    0,
  );
  const totalCurrentValueUsd = activePositions.reduce(
    (sum, position) => sum + position.currentValueUsd,
    0,
  );
  const keptPositions = [...activePositions, ...watchPositions, ...exitedPositions];
  const totalRealizedPnlUsd = keptPositions.reduce(
    (sum, position) => sum + position.realizedPnlUsd,
    0,
  );
  const totalUnrealizedPnlUsd = activePositions.reduce(
    (sum, position) => sum + position.unrealizedPnlUsd,
    0,
  );
  const totalUnrealizedPnlPct =
    totalAllocatedUsd > 0
      ? Math.round((totalUnrealizedPnlUsd / totalAllocatedUsd) * 100 * 10) / 10
      : 0;
  const grossPortfolioValueUsd =
    cashBalanceUsd + totalCurrentValueUsd + treasurySimulation.reserveUsd;

  // Compute win/loss from exited positions
  const exitedWithTrades = exitedPositions.filter(p => p.initialAllocationUsd > 0);
  const wins = exitedWithTrades.filter(p => p.realizedPnlUsd > 0).length;
  const losses = exitedWithTrades.filter(p => p.realizedPnlUsd <= 0).length;
  const prevWins = previous?.winCount ?? 0;
  const prevLosses = previous?.lossCount ?? 0;

  // Flywheel: distribute realized profits
  const prevFw = previous?.flywheel ?? {
    totalProfitUsd: 0, cumulativeDistributedUsd: 0, reinvestedUsd: 0, elizaOKBuybackUsd: 0,
    airdropReserveUsd: 0, cycleCount: 0, lastCycleAt: null,
    trailingStopSaves: 0, gmgnExitSaves: 0,
  };
  const currentProfit = Math.max(0, totalRealizedPnlUsd);
  const prevDistributed = prevFw.cumulativeDistributedUsd ?? prevFw.totalProfitUsd ?? 0;
  const newProfit = Math.max(0, currentProfit - prevDistributed);
  const cumulativeDistributed = prevDistributed + newProfit;
  const trailingStopSaves = exitedPositions.filter(p => p.trailingStopTriggered).length;
  const gmgnExitSaves = exitedPositions.filter(p => p.gmgnExitReason).length;

  const flywheel = {
    totalProfitUsd: currentProfit,
    cumulativeDistributedUsd: cumulativeDistributed,
    reinvestedUsd: currentProfit * 0.70,
    elizaOKBuybackUsd: currentProfit * 0.15,
    airdropReserveUsd: currentProfit * 0.15,
    cycleCount: prevFw.cycleCount + (newProfit > 0 ? 1 : 0),
    lastCycleAt: newProfit > 0 ? generatedAt : prevFw.lastCycleAt,
    trailingStopSaves: Math.max(prevFw.trailingStopSaves, trailingStopSaves),
    gmgnExitSaves: Math.max(prevFw.gmgnExitSaves, gmgnExitSaves),
  };

  if (newProfit > 0) {
    cashBalanceUsd += newProfit * 0.70;
  }

  const trailingLabel = treasury.trailingStopPct > 0
    ? `, ${treasury.trailingStopPct}% trailing stop (activates at +${treasury.trailingStopActivatePct}%)`
    : "";
  const gmgnLabel = treasury.gmgnExitEnabled ? ", smart exit" : "";

  const lifecycle: PortfolioLifecycle = {
    activePositions,
    watchPositions,
    exitedPositions,
    timeline: [...timeline, ...(previous?.timeline ?? [])].slice(0, 60),
    cashBalanceUsd,
    grossPortfolioValueUsd,
    reservedUsd: treasurySimulation.reserveUsd,
    totalAllocatedUsd,
    totalCurrentValueUsd,
    totalRealizedPnlUsd,
    totalUnrealizedPnlUsd,
    totalUnrealizedPnlPct,
    healthNote:
      activePositions.length > 0
        ? `Portfolio enforcing ${treasury.takeProfitRules.length} TP stages, ${treasury.stopLossPct}% stop loss${trailingLabel}${gmgnLabel}.`
        : "No active paper positions. Treasury waiting for high-conviction setups.",
    flywheel,
    winCount: Math.max(wins, prevWins),
    lossCount: Math.max(losses, prevLosses),
  };

  return tradeLedger
    ? mergeLiveExecutedTrades({
        portfolio: lifecycle,
        tradeLedger,
        candidates,
        generatedAt,
        runId,
      })
    : lifecycle;
}
