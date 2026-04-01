import { createUniqueUuid, type IAgentRuntime, type Task, type TaskWorker } from "@elizaos/core";
import { getDiscoveryConfig } from "./config";
import { ELIZAOK_DISCOVERY_TASK } from "./constants";
import { discoverBnbPools } from "./discover";
import { discoverGooCandidates } from "./goo";
import { buildScanMemo } from "./memo";
import { persistScanArtifacts } from "./persist";
import { scoreCandidates } from "./score";

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
      config.reportsDir
    );

    runtime.logger.info(
      {
        trigger,
        runId,
        candidateCount: candidates.length,
        topRecommendationCount: memo.summary.topRecommendationCount,
        gooAgentCount: gooCandidates.length,
        gooPriorityCount: memo.summary.gooPriorityCount,
        reportPath: persisted.reportPath,
      },
      "ElizaOK: Treasury discovery cycle completed"
    );
  } catch (error) {
    runtime.logger.error({ error, trigger, runId }, "ElizaOK: Treasury discovery cycle failed");
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
