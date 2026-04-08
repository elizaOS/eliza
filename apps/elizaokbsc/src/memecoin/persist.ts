import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Content,
  createUniqueUuid,
  type IAgentRuntime,
} from "@elizaos/core";
import {
  ELIZAOK_CANDIDATE_TABLE,
  ELIZAOK_GOO_TABLE,
  ELIZAOK_MEMO_TABLE,
  ELIZAOK_SCAN_RUNS_TABLE,
} from "./constants";
import { setLatestSnapshot } from "./store";
import type {
  CandidateDetail,
  DashboardSnapshot,
  DistributionExecutionLedger,
  DistributionExecutionState,
  DistributionPlan,
  ExecutionState,
  GooAgentCandidate,
  HistoryEntry,
  PersistedScanArtifacts,
  PortfolioLifecycle,
  ScanMemo,
  ScoredCandidate,
  TradeLedger,
  TreasurySimulation,
} from "./types";
import { buildWatchlist, mergeCandidateHistory } from "./watchlist";

function sanitizeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, currentValue) =>
      typeof currentValue === "bigint" ? currentValue.toString() : currentValue,
    2,
  );
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(safeJsonStringify(value)) as T;
}

export async function persistScanArtifacts(
  runtime: IAgentRuntime,
  runId: string,
  candidates: ScoredCandidate[],
  gooCandidates: GooAgentCandidate[],
  memo: ScanMemo,
  treasurySimulation: TreasurySimulation,
  portfolioLifecycle: PortfolioLifecycle,
  executionState: ExecutionState,
  tradeLedger: TradeLedger,
  distributionPlan: DistributionPlan,
  distributionExecution: DistributionExecutionState,
  distributionLedger: DistributionExecutionLedger,
  reportsDir: string,
  historyLimit: number,
): Promise<PersistedScanArtifacts> {
  const memoId = createUniqueUuid(runtime, `elizaok-memo-${runId}`);
  const runMemoryId = createUniqueUuid(runtime, `elizaok-run-${runId}`);
  const candidateMemoryIds: string[] = [];
  const gooMemoryIds: string[] = [];

  await runtime.createMemory(
    {
      id: runMemoryId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      entityId: runtime.agentId,
      content: {
        text: `ElizaOK scan run ${runId} completed with ${memo.summary.candidateCount} candidates and average score ${memo.summary.averageScore}.`,
        metadata: {
          type: "elizaok_scan_run",
          runId,
          summary: memo.summary,
        },
      } as unknown as Content,
    },
    ELIZAOK_SCAN_RUNS_TABLE,
  );

  for (const candidate of candidates) {
    const candidateMemoryId = createUniqueUuid(
      runtime,
      `elizaok-candidate-${runId}-${candidate.poolAddress}`,
    );
    candidateMemoryIds.push(candidateMemoryId);

    await runtime.createMemory(
      {
        id: candidateMemoryId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        entityId: runtime.agentId,
        content: {
          text: `Candidate ${candidate.tokenSymbol} scored ${candidate.score} with recommendation ${candidate.recommendation}.`,
          metadata: {
            type: "elizaok_candidate_snapshot",
            runId,
            candidate: toJsonSafe(candidate),
          },
        } as unknown as Content,
      },
      ELIZAOK_CANDIDATE_TABLE,
    );
  }

  for (const candidate of gooCandidates) {
    const gooMemoryId = createUniqueUuid(
      runtime,
      `elizaok-goo-${runId}-${candidate.agentId}`,
    );
    gooMemoryIds.push(gooMemoryId);

    await runtime.createMemory(
      {
        id: gooMemoryId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        entityId: runtime.agentId,
        content: {
          text: `Goo agent ${candidate.agentId} scored ${candidate.score} with recommendation ${candidate.recommendation}.`,
          metadata: {
            type: "elizaok_goo_candidate",
            runId,
            candidate: toJsonSafe(candidate),
          },
        } as unknown as Content,
      },
      ELIZAOK_GOO_TABLE,
    );
  }

  await runtime.createMemory(
    {
      id: memoId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      entityId: runtime.agentId,
      content: {
        text: memo.markdown,
        metadata: {
          type: "elizaok_scan_memo",
          runId,
          title: memo.title,
          summary: toJsonSafe(memo.summary),
        },
      } as unknown as Content,
    },
    ELIZAOK_MEMO_TABLE,
  );

  const absoluteReportsDir = path.isAbsolute(reportsDir)
    ? reportsDir
    : path.join(process.cwd(), reportsDir);
  await mkdir(absoluteReportsDir, { recursive: true });

  const reportPath = path.join(
    absoluteReportsDir,
    `scan-${sanitizeTimestamp(memo.summary.completedAt)}.md`,
  );
  await writeFile(reportPath, memo.markdown, "utf8");

  const historyPath = path.join(absoluteReportsDir, "history.json");
  let history: HistoryEntry[] = [];
  try {
    const content = await readFile(historyPath, "utf8");
    history = JSON.parse(content) as HistoryEntry[];
  } catch {
    history = [];
  }

  const historyEntry: HistoryEntry = {
    runId,
    generatedAt: memo.summary.completedAt,
    candidateCount: memo.summary.candidateCount,
    topRecommendationCount: memo.summary.topRecommendationCount,
    averageScore: memo.summary.averageScore,
    gooAgentCount: memo.summary.gooAgentCount,
    gooPriorityCount: memo.summary.gooPriorityCount,
    strongestCandidate: memo.summary.strongestCandidate,
    treasuryAllocatedUsd: treasurySimulation.allocatedUsd,
    treasuryDryPowderUsd: treasurySimulation.dryPowderUsd,
  };
  history = [
    historyEntry,
    ...history.filter((entry) => entry.runId !== runId),
  ].slice(0, historyLimit);
  await writeFile(historyPath, safeJsonStringify(history), "utf8");

  const candidateHistoryPath = path.join(
    absoluteReportsDir,
    "candidate-history.json",
  );
  let candidateHistory: CandidateDetail[] = [];
  try {
    const content = await readFile(candidateHistoryPath, "utf8");
    candidateHistory = JSON.parse(content) as CandidateDetail[];
  } catch {
    candidateHistory = [];
  }

  candidateHistory = mergeCandidateHistory(
    candidateHistory,
    runId,
    memo.summary.completedAt,
    candidates,
  );
  await writeFile(
    candidateHistoryPath,
    safeJsonStringify(candidateHistory),
    "utf8",
  );

  const watchlist = buildWatchlist(candidateHistory).slice(0, 24);
  const watchlistPath = path.join(absoluteReportsDir, "watchlist.json");
  await writeFile(watchlistPath, safeJsonStringify(watchlist), "utf8");

  const distributionPath = path.join(absoluteReportsDir, "distribution.json");
  await writeFile(
    distributionPath,
    safeJsonStringify(distributionPlan),
    "utf8",
  );

  const distributionExecutionPath = path.join(
    absoluteReportsDir,
    "distribution-execution.json",
  );
  await writeFile(
    distributionExecutionPath,
    safeJsonStringify(distributionExecution),
    "utf8",
  );

  const distributionLedgerPath = path.join(
    absoluteReportsDir,
    "distribution-ledger.json",
  );
  await writeFile(
    distributionLedgerPath,
    safeJsonStringify(distributionLedger),
    "utf8",
  );

  const executionPath = path.join(absoluteReportsDir, "execution.json");
  await writeFile(executionPath, safeJsonStringify(executionState), "utf8");

  const tradesPath = path.join(absoluteReportsDir, "trades.json");
  await writeFile(tradesPath, safeJsonStringify(tradeLedger), "utf8");

  const portfolioPath = path.join(absoluteReportsDir, "portfolio.json");
  await writeFile(portfolioPath, safeJsonStringify(portfolioLifecycle), "utf8");

  const timelinePath = path.join(absoluteReportsDir, "timeline.json");
  await writeFile(
    timelinePath,
    safeJsonStringify(portfolioLifecycle.timeline),
    "utf8",
  );

  const snapshotPath = path.join(absoluteReportsDir, "latest.json");
  const snapshot: DashboardSnapshot = {
    generatedAt: memo.summary.completedAt,
    summary: memo.summary,
    treasurySimulation,
    portfolioLifecycle,
    executionState,
    tradeLedger,
    distributionPlan,
    distributionExecution,
    distributionLedger,
    recentHistory: history,
    watchlist,
    topCandidates: candidates.slice(0, 10),
    topGooCandidates: gooCandidates.slice(0, 10),
    memoTitle: memo.title,
    reportPath,
    snapshotPath,
  };
  await writeFile(snapshotPath, safeJsonStringify(snapshot), "utf8");
  setLatestSnapshot(toJsonSafe(snapshot));

  return {
    reportPath,
    snapshotPath,
    historyPath,
    watchlistPath,
    candidateHistoryPath,
    distributionPath,
    distributionExecutionPath,
    distributionLedgerPath,
    executionPath,
    tradesPath,
    portfolioPath,
    timelinePath,
    memoId,
    runMemoryId,
    candidateMemoryIds,
    gooMemoryIds,
  };
}

export async function loadCandidateHistory(
  reportsDir: string,
): Promise<CandidateDetail[]> {
  const absoluteReportsDir = path.isAbsolute(reportsDir)
    ? reportsDir
    : path.join(process.cwd(), reportsDir);
  const candidateHistoryPath = path.join(
    absoluteReportsDir,
    "candidate-history.json",
  );

  try {
    const content = await readFile(candidateHistoryPath, "utf8");
    return JSON.parse(content) as CandidateDetail[];
  } catch {
    return [];
  }
}

export async function persistDistributionExecutionState(
  snapshot: DashboardSnapshot,
  reportsDir: string,
  distributionPlan: DistributionPlan,
  distributionExecution: DistributionExecutionState,
  distributionLedger: DistributionExecutionLedger,
): Promise<void> {
  const absoluteReportsDir = path.isAbsolute(reportsDir)
    ? reportsDir
    : path.join(process.cwd(), reportsDir);
  await mkdir(absoluteReportsDir, { recursive: true });

  const distributionPath = path.join(absoluteReportsDir, "distribution.json");
  await writeFile(
    distributionPath,
    safeJsonStringify(distributionPlan),
    "utf8",
  );

  const distributionExecutionPath = path.join(
    absoluteReportsDir,
    "distribution-execution.json",
  );
  await writeFile(
    distributionExecutionPath,
    safeJsonStringify(distributionExecution),
    "utf8",
  );

  const distributionLedgerPath = path.join(
    absoluteReportsDir,
    "distribution-ledger.json",
  );
  await writeFile(
    distributionLedgerPath,
    safeJsonStringify(distributionLedger),
    "utf8",
  );

  const updatedSnapshot: DashboardSnapshot = {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    distributionPlan,
    distributionExecution,
    distributionLedger,
  };
  const snapshotPath =
    snapshot.snapshotPath || path.join(absoluteReportsDir, "latest.json");
  await writeFile(snapshotPath, safeJsonStringify(updatedSnapshot), "utf8");
  setLatestSnapshot(toJsonSafe(updatedSnapshot));
}
