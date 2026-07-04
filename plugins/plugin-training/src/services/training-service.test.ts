/**
 * Coverage for TrainingService — asserts it reads trajectories from the runtime
 * and hands the right set plus metadata to the export-bundle builder, with the
 * bundle builder mocked so nothing is written to disk.
 */
import type { Trajectory } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the args passed into the export bundle so we can assert on the
// trajectory set + metadata without writing any dataset to disk.
const buildBundleMock = vi.fn(
  async (args: {
    trajectories: Trajectory[];
    source?: { metadata?: Record<string, unknown> };
  }) => ({
    outputDir: "/tmp/stub",
    manifestPath: "/tmp/stub/manifest.json",
    manifest: { trajectoryCount: args.trajectories.length },
  }),
);

vi.mock("../core/trajectory-export-bundle.js", () => ({
  buildTrajectoryExportBundle: (args: unknown) =>
    buildBundleMock(args as never),
}));

vi.mock("../core/privacy-filter.js", () => ({
  createHashAnonymizer: () => (value: string) => value,
}));

import { TrainingService } from "./training-service.js";

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
            systemPrompt: "s",
            userPrompt: "u",
            response: "r",
          },
        ],
      },
    ],
    metrics: { finalStatus: "completed" },
    metadata: { source: "test" },
  } as unknown as Trajectory;
}

/** Paging stub: each page caps at 500 rows; caller must offset-loop to drain. */
function makePagingRuntime(total: number) {
  const ids = Array.from({ length: total }, (_, i) => ({ id: `traj-${i}` }));
  const listTrajectories = vi.fn(
    async ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) => {
      const pageLimit = Math.min(500, Math.max(1, limit));
      const slice = ids.slice(offset, offset + pageLimit);
      return { trajectories: slice, total, offset, limit: pageLimit };
    },
  );
  const getTrajectoryDetail = vi.fn(async (id: string) => detailFor(id));
  const service = { listTrajectories, getTrajectoryDetail };
  const runtime = {
    getService: (name: string) => (name === "trajectories" ? service : null),
  } as unknown as AgentRuntime;
  return { runtime, service };
}

function makeService(runtime: AgentRuntime): TrainingService {
  return new TrainingService({
    getRuntime: () => runtime,
    getConfig: () => ({}),
    setConfig: () => {},
  });
}

describe("TrainingService.buildDataset paging", () => {
  beforeEach(() => {
    buildBundleMock.mockClear();
  });

  it("considers ALL trajectories beyond the 500-row cap when no limit is set", async () => {
    const TOTAL = 1_100; // 3 pages: 500 + 500 + 100
    const { runtime, service } = makePagingRuntime(TOTAL);
    const trainingService = makeService(runtime);

    const result = await trainingService.buildDataset({});

    const bundleArgs = buildBundleMock.mock.calls[0]?.[0];
    // every eligible trajectory reached the bundle — not capped at 500
    expect(bundleArgs?.trajectories).toHaveLength(TOTAL);
    expect(bundleArgs?.source?.metadata?.consideredTrajectories).toBe(TOTAL);
    // no cap requested → requestedLimit is null, not a silent 500
    expect(bundleArgs?.source?.metadata?.requestedLimit).toBeNull();
    expect(service.getTrajectoryDetail).toHaveBeenCalledTimes(TOTAL);
    expect(service.listTrajectories.mock.calls.length).toBeGreaterThan(1);
    expect(result).toHaveProperty("manifestPath");
  });

  it("honors an explicit limit as a hard cap", async () => {
    const { runtime } = makePagingRuntime(1_000);
    const trainingService = makeService(runtime);

    await trainingService.buildDataset({ limit: 300 });

    const bundleArgs = buildBundleMock.mock.calls[0]?.[0];
    expect(bundleArgs?.trajectories).toHaveLength(300);
    expect(bundleArgs?.source?.metadata?.requestedLimit).toBe(300);
  });
});
