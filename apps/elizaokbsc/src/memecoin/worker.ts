import { createUniqueUuid, type IAgentRuntime, type Task, type TaskWorker } from "@elizaos/core";
import { getDiscoveryConfig } from "./config";
import { ELIZAOK_DISCOVERY_TASK } from "./constants";
import { discoverBnbPools } from "./discover";
import { executeDistributionLane } from "./distribution-execution";
import { buildDistributionPlan } from "./distribution";
import { buildFourMemeAdapterPreview } from "./execution/fourmeme";
import { buildExecutionGooLane } from "./execution/goo-lane";
import { reconcilePortfolioWithWallet } from "./execution/reconcile";
import { buildExecutionState } from "./execution/state";
import { executeTradeLane } from "./execution/trades";
import { discoverGooCandidates } from "./goo";
import { buildScanMemo } from "./memo";
import { buildPortfolioLifecycle, loadPortfolioLifecycle } from "./portfolio";
import { loadCandidateHistory, persistScanArtifacts } from "./persist";
import { scoreCandidates } from "./score";
import { buildTreasurySimulation } from "./simulation";

function cycleErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export const elizaOkDiscoveryWorker: TaskWorker = {
  name: ELIZAOK_DISCOVERY_TASK,
  execute: async (runtime) => {
    await runElizaOkDiscoveryCycle(runtime, "scheduled");
    return undefined;
  },
};

export async function runElizaOkDiscoveryCycle(
  runtime: IAgentRuntime,
  trigger: "startup" | "scheduled"
): Promise<void> {
  const config = getDiscoveryConfig();
  if (!config.enabled) {
    runtime.logger.info("ElizaOK discovery is disabled; skipping cycle");
    return;
  }

  const startedAt = new Date().toISOString();
  const runId = createUniqueUuid(runtime, `elizaok-scan-${startedAt}-${trigger}`);

  runtime.logger.info(
    {
      trigger,
      newPoolsLimit: config.newPoolsLimit,
      trendingPoolsLimit: config.trendingPoolsLimit,
    },
    "ElizaOK: Starting treasury discovery cycle"
  );

  try {
    const [rawCandidates, gooCandidates] = await Promise.all([
      discoverBnbPools(config),
      discoverGooCandidates(config.goo),
    ]);
    const candidates = scoreCandidates(rawCandidates);
    const previousCandidateHistory = await loadCandidateHistory(config.reportsDir);
    const treasurySimulation = buildTreasurySimulation(candidates, config.treasury);
    const gooLane = buildExecutionGooLane(config, gooCandidates);
    const baseExecutionState = buildExecutionState(
      config.execution,
      candidates,
      previousCandidateHistory,
      gooLane
    );
    const fourMemePreview = buildFourMemeAdapterPreview(config.execution, baseExecutionState, candidates);
    const previousPortfolio = await loadPortfolioLifecycle(config.reportsDir);
    const paperPortfolioLifecycle = buildPortfolioLifecycle({
      previous: previousPortfolio,
      runId,
      generatedAt: startedAt,
      candidates,
      treasurySimulation,
      treasury: config.treasury,
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
      portfolioLifecycle
    );
    const { distributionExecution, distributionLedger } = await executeDistributionLane({
      config: config.distribution,
      distributionPlan,
      reportsDir: config.reportsDir,
      rpcUrl: config.execution.rpcUrl,
    });
    const completedAt = new Date().toISOString();
    const memo = buildScanMemo(
      runId,
      startedAt,
      completedAt,
      candidates,
      config.memoTopCount,
      gooCandidates,
      config.goo.memoTopCount,
      config.goo.enabled
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
      config.historyLimit
    );

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
        distributionExecutionAttemptedCount: distributionExecution.cycleSummary.attemptedCount,
        distributionExecutionExecutedCount: distributionExecution.cycleSummary.executedCount,
        reportPath: persisted.reportPath,
      },
      "ElizaOK: Treasury discovery cycle completed"
    );
  } catch (error) {
    runtime.logger.error({ error: cycleErrorMessage(error), trigger, runId }, "ElizaOK: Treasury discovery cycle failed");
  }
}

export async function ensureDiscoveryTask(runtime: IAgentRuntime): Promise<void> {
  const config = getDiscoveryConfig();
  if (!config.enabled) {
    runtime.logger.info("ElizaOK discovery is disabled; task will not be created");
    return;
  }

  await runtime.getServiceLoadPromise("task" as never);
  runtime.registerTaskWorker(elizaOkDiscoveryWorker);

  const existingTasks = await runtime.getTasksByName(ELIZAOK_DISCOVERY_TASK);
  const agentTasks = existingTasks.filter((task) => task.worldId === runtime.agentId);
  if (agentTasks.length > 0) {
    runtime.logger.debug(
      { taskCount: agentTasks.length },
      "ElizaOK discovery task already exists"
    );
    return;
  }

  await runtime.createTask({
    id: createUniqueUuid(runtime, `task-${ELIZAOK_DISCOVERY_TASK}`),
    name: ELIZAOK_DISCOVERY_TASK,
    description: "Periodic ElizaOK BNB Chain discovery and treasury memo cycle",
    worldId: runtime.agentId,
    metadata: {
      createdAt: Date.now() as any,
      updatedAt: Date.now() as any,
      updateInterval: config.intervalMs as any,
    },
    tags: ["queue", "repeat", "elizaok", "discovery", "treasury"],
  } satisfies Task);

  runtime.logger.info(
    { intervalMinutes: Math.round(config.intervalMs / 60_000) },
    "ElizaOK discovery task created"
  );
}
