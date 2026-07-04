/**
 * Covers the nightly trajectory-export cron's paging and per-task bucketization
 * with a stub trajectory service on a temp filesystem (deterministic).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNightlyTrajectoryExport } from "./trajectory-export-cron.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trajectory-export-cron-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function detailFor(id: string): Trajectory {
  return {
    trajectoryId: id,
    agentId: "agent-1",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_001_000,
    durationMs: 1_000,
    steps: [
      {
        stepId: `${id}-step`,
        timestamp: 1_700_000_000_100,
        llmCalls: [
          {
            callId: `${id}-call`,
            purpose: "response",
            systemPrompt: "Reply directly.",
            userPrompt: "hello",
            response: "hi",
          },
        ],
      },
    ],
    metrics: { finalStatus: "completed" },
    metadata: { source: "test" },
  } as unknown as Trajectory;
}

/**
 * Build a paging stub that emulates the SQL reader: each page is capped at
 * 500 rows and the caller must loop with offset to drain the full set.
 */
function makePagingService(total: number) {
  const ids = Array.from({ length: total }, (_, i) => ({ id: `traj-${i}` }));
  const listTrajectories = vi.fn(
    async ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) => {
      const pageLimit = Math.min(500, Math.max(1, limit));
      const slice = ids.slice(offset, offset + pageLimit);
      return { trajectories: slice, total };
    },
  );
  const getTrajectoryDetail = vi.fn(async (id: string) => detailFor(id));
  return { listTrajectories, getTrajectoryDetail };
}

describe("runNightlyTrajectoryExport paging", () => {
  it("pages through ALL trajectories beyond the 500-row cap by default", async () => {
    const TOTAL = 1_250; // spans 3 pages (500 + 500 + 250)
    const service = makePagingService(TOTAL);
    const runtime = {
      getService: (name: string) => (name === "trajectories" ? service : null),
    };

    const outputRoot = await makeTempDir();
    const report = await runNightlyTrajectoryExport(runtime as never, {
      outputRoot,
    });

    expect(report).not.toBeNull();
    // every eligible trajectory was pulled — not capped at the first 500
    expect(report?.pulledTrajectories).toBe(TOTAL);
    expect(report?.keptTrajectories).toBe(TOTAL);
    // each row's detail was fetched exactly once
    expect(service.getTrajectoryDetail).toHaveBeenCalledTimes(TOTAL);
    // the reader was paged (>1 call), each within the 500 cap
    expect(service.listTrajectories.mock.calls.length).toBeGreaterThan(1);
    for (const [opts] of service.listTrajectories.mock.calls) {
      expect((opts as { limit?: number }).limit ?? 0).toBeLessThanOrEqual(500);
    }
  });

  it("honors an explicit trajectoryLimit as a hard cap and warns on truncation", async () => {
    const TOTAL = 1_200;
    const service = makePagingService(TOTAL);
    const warn = vi.fn();
    const runtime = {
      getService: (name: string) => (name === "trajectories" ? service : null),
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    };

    const outputRoot = await makeTempDir();
    const report = await runNightlyTrajectoryExport(runtime as never, {
      outputRoot,
      trajectoryLimit: 700,
    });

    expect(report?.pulledTrajectories).toBe(700);
    // truncation is logged, not silent
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("truncated the export"),
    );
  });
});
