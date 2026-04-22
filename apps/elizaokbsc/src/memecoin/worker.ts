import { createUniqueUuid, type IAgentRuntime } from "@elizaos/core";
import { getDiscoveryConfig } from "./config";
import { discoverBnbPools } from "./discover";
import { buildDistributionPlan } from "./distribution";
import { executeDistributionLane } from "./distribution-execution";
import { buildFourMemeAdapterPreview } from "./execution/fourmeme";
import { buildExecutionGooLane } from "./execution/goo-lane";
import { reconcilePortfolioWithWallet } from "./execution/reconcile";
import { buildExecutionState } from "./execution/state";
import { executeTradeLane } from "./execution/trades";
import {
  type EnrichedCandidate,
  enrichCandidatesWithGmgn,
} from "./gmgn-enrich";
import { type SmartExitSignal, scanPortfolioForExits } from "./gmgn-service";
import { discoverGooCandidates } from "./goo";
import {
  autoRespawnIfNeeded,
  buildGooPaperSummary,
  loadPaperAgents,
  pruneDeadAgents,
  runPaperAgentCycle,
  savePaperAgents,
  spawnDefaultAgentFleet,
} from "./goo-paper-engine";
import { buildScanMemo } from "./memo";
import { loadCandidateHistory, persistScanArtifacts } from "./persist";
import {
  buildPortfolioLifecycle,
  type GmgnExitSignal,
  loadPortfolioLifecycle,
} from "./portfolio";
import { scoreCandidates, setScoreWeights } from "./score";
import { buildTreasurySimulation } from "./simulation";
import type { GmgnSignalSnapshot } from "./store";
import {
  getBnbPriceUsd,
  pushNotification,
  setGmgnSignals,
  setPaperAgents,
  setPaperSummary,
} from "./store";
import {
  applyAbsorptionOverrides,
  loadAbsorptionState,
} from "./strategy-absorption";

function candidateGmgnBoost(
  candidate: import("./types").ScoredCandidate,
): number {
  const c = candidate as EnrichedCandidate;
  return typeof c.gmgnScoreBoost === "number" ? c.gmgnScoreBoost : 0;
}

function smartExitToPortfolioGmgn(sig: SmartExitSignal): GmgnExitSignal {
  const hd = sig.details.holderDelta;
  const ks = sig.details.kolSignal;
  const th = sig.details.topHolderDelta;
  return {
    holderDropPct: hd?.holderChangePct,
    kolExited: sig.signalType === "kol_exit" && sig.shouldExit,
    kolExitCount: sig.signalType === "kol_exit" ? (ks?.kolCount ?? 0) : 0,
    topHolderDumpPct: th?.totalPctChange,
  };
}

function smartExitToDashboardRow(
  sig: SmartExitSignal,
): GmgnSignalSnapshot["signals"][number] {
  const hd = sig.details.holderDelta;
  const ks = sig.details.kolSignal;
  const th = sig.details.topHolderDelta;
  return {
    tokenAddress: sig.tokenAddress,
    tokenSymbol: sig.tokenSymbol,
    holderCount: hd?.current.holderCount ?? 0,
    holderDelta: hd?.holderChange ?? 0,
    holderDeltaPct: hd?.holderChangePct ?? 0,
    kolCount: ks?.kolCount ?? 0,
    topHolderDumpPct: th?.totalPctChange ?? 0,
    severity: sig.shouldExit
      ? "critical"
      : hd?.alert === "warning" || th?.alert === "warning"
        ? "warning"
        : "ok",
    reasons: sig.reason ? [sig.reason] : [],
  };
}

function cycleErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export async function runElizaOkDiscoveryCycle(
  runtime: IAgentRuntime,
  trigger: "startup" | "scheduled",
): Promise<void> {
  const config = getDiscoveryConfig();
  if (!config.enabled) {
    runtime.logger.info("ElizaOK discovery is disabled; skipping cycle");
    return;
  }

  const startedAt = new Date().toISOString();
  const runId = createUniqueUuid(
    runtime,
    `elizaok-scan-${startedAt}-${trigger}`,
  );

  runtime.logger.info(
    {
      trigger,
      newPoolsLimit: config.newPoolsLimit,
      trendingPoolsLimit: config.trendingPoolsLimit,
    },
    "ElizaOK: Starting treasury discovery cycle",
  );

  let discoveredCandidates: import("./types").ScoredCandidate[] | null = null;
  let discoveredBnbPrice = 0;

  try {
    // Apply any absorbed Goo agent strategy overrides
    const absState = await loadAbsorptionState(config.reportsDir);
    if (absState.totalAbsorbed > 0) {
      const upgraded = applyAbsorptionOverrides(config.treasury, absState);
      Object.assign(config.treasury, upgraded);
      setScoreWeights(absState.scoreWeightBoosts);
      runtime.logger.info(
        {
          absorbed: absState.totalAbsorbed,
          lastAt: absState.lastAbsorbedAt,
          boosts: absState.scoreWeightBoosts,
        },
        "ElizaOK: Applied absorbed Goo agent strategy overrides",
      );
    }

    const [rawCandidates, gooCandidates] = await Promise.all([
      discoverBnbPools(config),
      discoverGooCandidates(config.goo),
    ]);
    const scoredCandidates = scoreCandidates(rawCandidates);

    // Enrich top candidates with market intelligence (KOL, holders, smart money)
    let candidates = scoredCandidates;
    try {
      candidates = await enrichCandidatesWithGmgn(scoredCandidates, 15);
      const boosted = candidates.filter(
        (c) => candidateGmgnBoost(c) > 0,
      ).length;
      const demoted = candidates.filter(
        (c) => candidateGmgnBoost(c) < 0,
      ).length;
      runtime.logger.info(
        { enriched: Math.min(15, candidates.length), boosted, demoted },
        "ElizaOK: Market intelligence enrichment completed",
      );
    } catch {
      runtime.logger.warn(
        "ElizaOK: Market enrichment failed, using base scores",
      );
    }

    const previousCandidateHistory = await loadCandidateHistory(
      config.reportsDir,
    );
    const bnbPriceEstimate = await getBnbPriceUsd();
    const treasurySimulation = buildTreasurySimulation(
      candidates,
      config.treasury,
      bnbPriceEstimate,
    );
    const gooLane = buildExecutionGooLane(config, gooCandidates);
    const baseExecutionState = buildExecutionState(
      config.execution,
      candidates,
      previousCandidateHistory,
      gooLane,
    );
    const fourMemePreview = buildFourMemeAdapterPreview(
      config.execution,
      baseExecutionState,
      candidates,
    );
    const previousPortfolio = await loadPortfolioLifecycle(config.reportsDir);

    // Scan smart exit signals for elizaOK's active positions
    let portfolioGmgnSignals: Record<string, GmgnExitSignal> | undefined;
    const prevActivePositions = previousPortfolio?.activePositions ?? [];
    if (prevActivePositions.length > 0) {
      try {
        const posList = prevActivePositions.map((p) => ({
          tokenAddress: p.tokenAddress,
          tokenSymbol: p.tokenSymbol,
        }));
        const scan = await scanPortfolioForExits(posList);
        portfolioGmgnSignals = {};
        for (const sig of scan.exitSignals) {
          portfolioGmgnSignals[sig.tokenAddress] =
            smartExitToPortfolioGmgn(sig);
        }
        runtime.logger.info(
          {
            positions: prevActivePositions.length,
            signals: Object.keys(portfolioGmgnSignals).length,
          },
          "ElizaOK: Smart exit scan for portfolio positions",
        );
      } catch {
        runtime.logger.warn("ElizaOK: Smart exit portfolio scan failed");
      }
    }

    // Scan KOL take-profit patterns for active positions
    let kolTpSignals:
      | Record<string, import("./portfolio").KolTpSignal>
      | undefined;
    if (prevActivePositions.length > 0) {
      try {
        const { scanPortfolioForKolTp, saveKolTpCache } = await import(
          "./kol-tp-engine"
        );
        const kolResults = await scanPortfolioForKolTp(
          prevActivePositions.map((p) => ({
            tokenAddress: p.tokenAddress,
            tokenSymbol: p.tokenSymbol,
          })),
          6,
        );
        if (Object.keys(kolResults).length > 0) {
          kolTpSignals = {};
          for (const [addr, sig] of Object.entries(kolResults)) {
            kolTpSignals[addr] = {
              recommendedTpPct: sig.recommendedTpPct,
              kolCount: sig.kolCount,
              confidence: sig.confidence,
            };
          }
          runtime.logger.info(
            { tokens: Object.keys(kolTpSignals).length },
            "ElizaOK: KOL take-profit analysis completed",
          );
        }
        await saveKolTpCache(config.reportsDir);
      } catch {
        runtime.logger.warn("ElizaOK: KOL TP analysis failed");
      }
    }

    const paperPortfolioLifecycle = buildPortfolioLifecycle({
      previous: previousPortfolio,
      runId,
      generatedAt: startedAt,
      candidates,
      treasurySimulation,
      treasury: config.treasury,
      gmgnSignals: portfolioGmgnSignals,
      kolTpSignals,
    });
    const { executionState, tradeLedger } = await executeTradeLane({
      runId,
      generatedAt: startedAt,
      config,
      candidates,
      portfolioLifecycle: previousPortfolio ?? paperPortfolioLifecycle,
      executionState: baseExecutionState,
      reportsDir: config.reportsDir,
    });
    const provisionalPortfolioLifecycle = buildPortfolioLifecycle({
      previous: previousPortfolio,
      runId,
      generatedAt: startedAt,
      candidates,
      treasurySimulation,
      treasury: config.treasury,
      tradeLedger,
      gmgnSignals: portfolioGmgnSignals,
      kolTpSignals,
    });
    const portfolioLifecycle = await reconcilePortfolioWithWallet({
      portfolio: provisionalPortfolioLifecycle,
      execution: config.execution,
      generatedAt: startedAt,
    });
    const distributionPlan = await buildDistributionPlan(
      config.distribution,
      treasurySimulation,
      config.execution.rpcUrl,
      portfolioLifecycle,
    );
    const { distributionExecution, distributionLedger } =
      await executeDistributionLane({
        config: config.distribution,
        distributionPlan,
        reportsDir: config.reportsDir,
        rpcUrl: config.execution.rpcUrl,
      });
    // Push notifications for new portfolio events
    const prevTimestamps = new Set(
      (previousPortfolio?.timeline ?? []).map(
        (t) => `${t.runId}-${t.tokenAddress}-${t.type}`,
      ),
    );
    for (const ev of portfolioLifecycle.timeline) {
      const key = `${ev.runId}-${ev.tokenAddress}-${ev.type}`;
      if (prevTimestamps.has(key)) continue;
      if (ev.type === "promoted" || ev.type === "entered") {
        pushNotification({
          type: "trade_buy",
          severity: "info",
          title: `BSC BUY: ${ev.tokenSymbol}`,
          detail: ev.detail,
        });
      } else if (ev.type === "exited") {
        const isSmartExit =
          (ev.detail || "").includes("Holder") ||
          (ev.detail || "").includes("KOL") ||
          (ev.detail || "").includes("Top holder") ||
          (ev.detail || "").includes("Smart exit");
        pushNotification({
          type: isSmartExit ? "smart_exit" : "trade_sell",
          severity: isSmartExit ? "warning" : "info",
          title: `BSC EXIT: ${ev.tokenSymbol}`,
          detail: ev.detail,
        });
      } else if (ev.type === "watched") {
        pushNotification({
          type: "trade_buy",
          severity: "info",
          title: `WATCH: ${ev.tokenSymbol}`,
          detail: ev.detail,
        });
      }
    }

    const completedAt = new Date().toISOString();
    const memo = buildScanMemo(
      runId,
      startedAt,
      completedAt,
      candidates,
      config.memoTopCount,
      gooCandidates,
      config.goo.memoTopCount,
      config.goo.enabled,
    );
    const persisted = await persistScanArtifacts(
      runtime,
      runId,
      candidates,
      gooCandidates,
      memo,
      treasurySimulation,
      portfolioLifecycle,
      executionState,
      tradeLedger,
      distributionPlan,
      distributionExecution,
      distributionLedger,
      config.reportsDir,
      config.historyLimit,
    );

    // Store candidates/bnbPrice for the Goo cycle (runs after this try/catch)
    discoveredCandidates = candidates;
    discoveredBnbPrice = bnbPriceEstimate;

    runtime.logger.info(
      {
        trigger,
        runId,
        candidateCount: candidates.length,
        topRecommendationCount: memo.summary.topRecommendationCount,
        gooAgentCount: gooCandidates.length,
        gooPriorityCount: memo.summary.gooPriorityCount,
        treasuryAllocatedUsd: treasurySimulation.allocatedUsd,
        executionMode: executionState.mode,
        executionRouter: executionState.router,
        executionReady: `${executionState.readinessScore}/${executionState.readinessTotal}`,
        executionLiveTradingArmed: executionState.liveTradingArmed,
        executionDryRun: executionState.dryRun,
        executionAttemptedCount: executionState.cycleSummary.attemptedCount,
        executionExecutedCount: executionState.cycleSummary.executedCount,
        executionDryRunCount: executionState.cycleSummary.dryRunCount,
        executionFailedCount: executionState.cycleSummary.failedCount,
        fourMemeCommands: fourMemePreview.commands.length,
        tradeLedgerRecords: tradeLedger.records.length,
        portfolioActiveCount: portfolioLifecycle.activePositions.length,
        portfolioUnrealizedPnlUsd: portfolioLifecycle.totalUnrealizedPnlUsd,
        distributionPoolUsd: distributionPlan.distributionPoolUsd,
        distributionExecutionAttemptedCount:
          distributionExecution.cycleSummary.attemptedCount,
        distributionExecutionExecutedCount:
          distributionExecution.cycleSummary.executedCount,
        reportPath: persisted.reportPath,
      },
      "ElizaOK: Treasury discovery cycle completed",
    );
  } catch (error) {
    runtime.logger.error(
      { error: cycleErrorMessage(error), trigger, runId },
      "ElizaOK: Treasury discovery cycle failed",
    );
  }

  // ── Goo Paper Agent cycle (runs independently of main discovery) ──
  try {
    let gooAgents = await loadPaperAgents(config.reportsDir);
    if (gooAgents.length === 0) {
      gooAgents = spawnDefaultAgentFleet(1.0);
      runtime.logger.info(
        { agentCount: gooAgents.length },
        "ElizaOK: Spawned default Goo paper agent fleet",
      );
    }

    const gooRunBnbPrice = discoveredBnbPrice || (await getBnbPriceUsd());

    // Collect active positions across all agents for smart exit scan
    const allActivePositions = gooAgents.flatMap((a) =>
      a.positions
        .filter((p) => p.state === "active")
        .map((p) => ({
          tokenAddress: p.tokenAddress,
          tokenSymbol: p.tokenSymbol,
        })),
    );
    const uniquePositions = Array.from(
      new Map(allActivePositions.map((p) => [p.tokenAddress, p])).values(),
    );

    let exitSignals: Awaited<ReturnType<typeof scanPortfolioForExits>> | null =
      null;
    if (uniquePositions.length > 0) {
      try {
        exitSignals = await scanPortfolioForExits(uniquePositions);
        runtime.logger.info(
          {
            scanned: exitSignals.scannedCount,
            critical: exitSignals.criticalCount,
            warning: exitSignals.warningCount,
          },
          "ElizaOK: Smart exit scan completed",
        );
        const gmgnSnap: GmgnSignalSnapshot = {
          scannedAt: new Date().toISOString(),
          signals: exitSignals.exitSignals.map((sig) =>
            smartExitToDashboardRow(sig),
          ),
          totalScanned: exitSignals.scannedCount,
          critical: exitSignals.criticalCount,
          warning: exitSignals.warningCount,
        };
        setGmgnSignals(gmgnSnap);
      } catch {
        runtime.logger.warn(
          "ElizaOK: Smart exit scan failed, continuing without signals",
        );
      }
    }

    // Only run paper trading cycle if we have candidates from main discovery
    if (discoveredCandidates && discoveredCandidates.length > 0) {
      const paperCandidates = discoveredCandidates;
      gooAgents = gooAgents.map((agent) =>
        runPaperAgentCycle(
          agent,
          paperCandidates,
          gooRunBnbPrice,
          exitSignals?.exitSignals,
        ),
      );
    }

    // Auto-acquire high-performing Goo agents
    const AUTO_ACQUIRE_SCORE = 70;
    const AUTO_ACQUIRE_MIN_TRADES = 5;
    const autoAcquireCandidates = gooAgents.filter(
      (a) =>
        !a.acquiredByElizaOK &&
        a.chainState !== "dead" &&
        a.acquisitionScore >= AUTO_ACQUIRE_SCORE &&
        a.totalTradesCount >= AUTO_ACQUIRE_MIN_TRADES &&
        a.winRate > 15,
    );
    if (autoAcquireCandidates.length > 0) {
      const {
        absorbAgentStrategy,
        loadAbsorptionState: loadAbs,
        saveAbsorptionState: saveAbs,
      } = await import("./strategy-absorption");
      const { acquireAgent } = await import("./goo-paper-engine");
      let absState = await loadAbs(config.reportsDir);
      for (const candidate of autoAcquireCandidates) {
        absState = absorbAgentStrategy(candidate, config.treasury, absState);
        const idx = gooAgents.findIndex((a) => a.id === candidate.id);
        if (idx >= 0) gooAgents[idx] = acquireAgent(gooAgents[idx]);
        pushNotification({
          type: "acquisition",
          severity: "success",
          title: `Acquired ${candidate.agentName}`,
          detail: `Strategy: ${candidate.strategy.label} | Win rate: ${candidate.winRate.toFixed(1)}% | Score: ${candidate.acquisitionScore}`,
        });
        runtime.logger.info(
          {
            agent: candidate.agentName,
            strategy: candidate.strategy.label,
            winRate: candidate.winRate,
            score: candidate.acquisitionScore,
          },
          "ElizaOK: Auto-acquired Goo agent",
        );
      }
      await saveAbs(config.reportsDir, absState);
      const upgraded = (
        await import("./strategy-absorption")
      ).applyAbsorptionOverrides(config.treasury, absState);
      Object.assign(config.treasury, upgraded);
      setScoreWeights(absState.scoreWeightBoosts);
    }

    // Prune old dead agents to prevent unbounded growth
    gooAgents = pruneDeadAgents(gooAgents);

    // Auto-respawn: keep at least 4 alive agents in the arena
    const respawn = autoRespawnIfNeeded(gooAgents, 1.0);
    if (respawn.spawned.length > 0) {
      gooAgents = [...gooAgents, ...respawn.spawned];
      for (const newA of respawn.spawned) {
        pushNotification({
          type: "respawn",
          severity: "info",
          title: `New agent: ${newA.agentName}`,
          detail: `Strategy: ${newA.strategy.label} | Treasury: ${newA.treasuryBnb.toFixed(2)} BNB`,
        });
      }
      runtime.logger.info(
        {
          spawned: respawn.spawned.length,
          names: respawn.spawned.map((a) => a.agentName),
        },
        `ElizaOK: ${respawn.reason}`,
      );
    }

    const gooSummary = buildGooPaperSummary(gooAgents);
    setPaperAgents(gooAgents);
    setPaperSummary(gooSummary);
    await savePaperAgents(config.reportsDir, gooAgents);

    runtime.logger.info(
      {
        agentCount: gooAgents.length,
        activeCount: gooSummary.activeAgents,
        totalPnl: gooSummary.totalPnlUsd,
        avgWinRate: gooSummary.averageWinRate,
      },
      "ElizaOK: Goo paper agent cycle completed",
    );
  } catch (gooError) {
    runtime.logger.error(
      { error: cycleErrorMessage(gooError), trigger, runId },
      "ElizaOK: Goo paper agent cycle failed",
    );
  }
}
