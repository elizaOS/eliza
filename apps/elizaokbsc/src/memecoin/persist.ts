import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createUniqueUuid, type IAgentRuntime } from "@elizaos/core";
import {
  ELIZAOK_CANDIDATE_TABLE,
  ELIZAOK_GOO_TABLE,
  ELIZAOK_MEMO_TABLE,
  ELIZAOK_SCAN_RUNS_TABLE,
} from "./constants";
import type {
  DashboardSnapshot,
  GooAgentCandidate,
  PersistedScanArtifacts,
  ScanMemo,
  ScoredCandidate,
} from "./types";
import { setLatestSnapshot } from "./store";

function sanitizeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

export async function persistScanArtifacts(
  runtime: IAgentRuntime,
  runId: string,
  candidates: ScoredCandidate[],
  gooCandidates: GooAgentCandidate[],
  memo: ScanMemo,
  reportsDir: string
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
        } as any,
      },
    },
    ELIZAOK_SCAN_RUNS_TABLE
  );

  for (const candidate of candidates) {
    const candidateMemoryId = createUniqueUuid(runtime, `elizaok-candidate-${runId}-${candidate.poolAddress}`);
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
            candidate,
          } as any,
        },
      },
      ELIZAOK_CANDIDATE_TABLE
    );
  }

  for (const candidate of gooCandidates) {
    const gooMemoryId = createUniqueUuid(runtime, `elizaok-goo-${runId}-${candidate.agentId}`);
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
            candidate,
          } as any,
        },
      },
      ELIZAOK_GOO_TABLE
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
          summary: memo.summary,
        } as any,
      },
    },
    ELIZAOK_MEMO_TABLE
  );

  const absoluteReportsDir = path.isAbsolute(reportsDir)
    ? reportsDir
    : path.join(process.cwd(), reportsDir);
  await mkdir(absoluteReportsDir, { recursive: true });

  const reportPath = path.join(
    absoluteReportsDir,
    `scan-${sanitizeTimestamp(memo.summary.completedAt)}.md`
  );
  await writeFile(reportPath, memo.markdown, "utf8");

  const snapshotPath = path.join(absoluteReportsDir, "latest.json");
  const snapshot: DashboardSnapshot = {
    generatedAt: memo.summary.completedAt,
    summary: memo.summary,
    topCandidates: candidates.slice(0, 10),
    topGooCandidates: gooCandidates.slice(0, 10),
    memoTitle: memo.title,
    reportPath,
    snapshotPath,
  };
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  setLatestSnapshot(snapshot);

  return {
    reportPath,
    snapshotPath,
    memoId,
    runMemoryId,
    candidateMemoryIds,
    gooMemoryIds,
  };
}
