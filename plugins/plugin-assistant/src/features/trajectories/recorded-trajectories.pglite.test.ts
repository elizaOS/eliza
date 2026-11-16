/**
 * Real-PGlite coverage for recorded trajectories on the trajectory store: the
 * header, stages and derived metrics persist on the turn's row or on their own
 * row, the per-file export matches the stored projection, a later export from
 * the store reproduces the files, and a runtime without SQL still exports.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  type IAgentRuntime,
  type RecordedStage,
  type RecordedTrajectory,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrajectoryRecorder } from "./recorded-trajectories.ts";
import { TrajectoriesService } from "./TrajectoriesService.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000a1";

function plannerStage(id: string): RecordedStage {
  return {
    stageId: id,
    kind: "planner",
    iteration: 1,
    startedAt: 1_000,
    endedAt: 1_250,
    latencyMs: 250,
    model: {
      modelType: "TEXT_LARGE",
      modelName: "gpt-5.5-mini",
      provider: "openai",
      prompt: "plan the reply",
      response: '{"action":"REPLY"}',
      usage: { promptTokens: 120, completionTokens: 30 },
    },
  };
}

function toolStage(id: string): RecordedStage {
  return {
    stageId: id,
    kind: "tool",
    parentStageId: "planner-1",
    startedAt: 1_300,
    endedAt: 1_340,
    latencyMs: 40,
    tool: {
      name: "REPLY",
      args: { text: "hello" },
      result: { ok: true },
      success: false,
      durationMs: 40,
    },
  };
}

function evaluationStage(id: string): RecordedStage {
  return {
    stageId: id,
    kind: "evaluation",
    startedAt: 1_400,
    endedAt: 1_450,
    latencyMs: 50,
    evaluation: {
      success: true,
      decision: "FINISH",
      thought: "done",
    } as RecordedStage["evaluation"],
  };
}

async function createSqlRuntime(): Promise<{
  runtime: IAgentRuntime;
  service: TrajectoriesService;
  rows: (text: string) => Promise<Record<string, unknown>[]>;
}> {
  const db = drizzle(new PGlite());
  const sqlDb = {
    execute: (query: ReturnType<typeof sql.raw>) => db.execute(query),
    transaction: <T>(
      work: (executor: {
        execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
      }) => Promise<T>,
    ): Promise<T> =>
      db.transaction((tx) => work({ execute: (query) => tx.execute(query) })),
  };
  let service: TrajectoriesService | null = null;
  const runtime = {
    agentId: AGENT_ID,
    runtimeInstanceId: crypto.randomUUID(),
    adapter: { db: sqlDb },
    getService: (type: string) => (type === "trajectories" ? service : null),
    getServicesByType: (type: string) =>
      type === "trajectories" && service ? [service] : [],
    getSetting: () => undefined,
    reportError: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  service = (await TrajectoriesService.start(runtime)) as TrajectoriesService;
  return {
    runtime,
    service,
    rows: async (text) =>
      ((await db.execute(sql.raw(text))).rows as Record<string, unknown>[]) ??
      [],
  };
}

async function readExport(
  rootDir: string,
  trajectory: Pick<RecordedTrajectory, "agentId" | "trajectoryId">,
): Promise<RecordedTrajectory> {
  return JSON.parse(
    await fs.readFile(
      path.join(rootDir, trajectory.agentId, `${trajectory.trajectoryId}.json`),
      "utf8",
    ),
  ) as RecordedTrajectory;
}

describe("recorded trajectories on the trajectory store", () => {
  let rootDir: string;

  beforeEach(async () => {
    vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "1");
    vi.stubEnv("ELIZA_LIFEOPS_RUN_ID", "run-7");
    vi.stubEnv("ELIZA_LIFEOPS_SCENARIO_ID", "scenario-3");
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "recorded-store-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("stores a trajectory without a turn step on its own row and exports the same record", async () => {
    const { runtime, service, rows } = await createSqlRuntime();
    expect(service.isEnabled()).toBe(true);
    const recorder = createTrajectoryRecorder({ runtime, rootDir });

    const id = recorder.startTrajectory({
      agentId: AGENT_ID,
      roomId: "room-1",
      traceId: "trace-1",
      rootMessage: { id: "message-1", text: "say hello", sender: "user-1" },
    });
    await recorder.recordStage(id, plannerStage("planner-1"));
    await recorder.recordStage(id, toolStage("tool-1"));
    await recorder.recordStage(id, evaluationStage("evaluation-1"));
    await recorder.endTrajectory(id, "finished");

    const [row] = await rows(
      `SELECT source, status FROM trajectories WHERE id = '${id}'`,
    );
    expect(row).toMatchObject({ source: "recorder", status: "completed" });

    const stored = await service.getRecordedTrajectories(id);
    expect(stored).toHaveLength(1);
    const file = await readExport(rootDir, {
      agentId: AGENT_ID,
      trajectoryId: id,
    });
    expect(stored?.[0]).toEqual(file);
    expect(file).toMatchObject({
      trajectoryId: id,
      roomId: "room-1",
      runId: "run-7",
      scenarioId: "scenario-3",
      traceId: "trace-1",
      rootMessage: { id: "message-1", text: "say hello", sender: "user-1" },
      status: "finished",
      metrics: {
        totalLatencyMs: 340,
        totalPromptTokens: 120,
        totalCompletionTokens: 30,
        plannerIterations: 1,
        toolCallsExecuted: 1,
        toolCallFailures: 1,
        finalDecision: "FINISH",
      },
    });
    expect(file.metrics.totalCostUsd).toBeGreaterThan(0);
    expect(file.stages.map((stage) => stage.stageId)).toEqual([
      "planner-1",
      "tool-1",
      "evaluation-1",
    ]);
    expect(file.stages[0]?.model?.priceTableId).toBeTruthy();

    // A later export from the store reproduces the per-file record.
    const exportDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "recorded-export-"),
    );
    try {
      const written = await service.exportRecordedTrajectoryFiles({
        rootDir: exportDir,
        trajectoryIds: [id],
      });
      expect(written).toEqual([path.join(exportDir, AGENT_ID, `${id}.json`)]);
      expect(
        await readExport(exportDir, { agentId: AGENT_ID, trajectoryId: id }),
      ).toEqual(file);
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
    }
    await service.stop();
  });

  it("attaches to the open turn row instead of adding a second row", async () => {
    const { runtime, service, rows } = await createSqlRuntime();
    const turnId = await service.startTrajectory(AGENT_ID, {
      roomId: "room-2",
    });
    const recorder = createTrajectoryRecorder({ runtime, rootDir });

    const ids = await runWithTrajectoryContext(
      { trajectoryStepId: turnId },
      async () => {
        const first = recorder.startTrajectory({
          agentId: AGENT_ID,
          rootMessage: { id: "message-2", text: "first" },
        });
        const second = recorder.startTrajectory({
          agentId: AGENT_ID,
          rootMessage: { id: "message-3", text: "second" },
        });
        await recorder.recordStage(first, plannerStage("first-planner"));
        await recorder.recordStage(second, plannerStage("second-planner"));
        await recorder.recordStage(first, evaluationStage("first-evaluation"));
        await recorder.endTrajectory(first, "finished");
        await recorder.endTrajectory(second, "errored");
        return [first, second];
      },
    );
    await service.endTrajectory(turnId, "completed");

    expect(await rows("SELECT id FROM trajectories")).toEqual([{ id: turnId }]);
    const stored = await service.getRecordedTrajectories(turnId);
    expect(stored?.map((trajectory) => trajectory.trajectoryId).sort()).toEqual(
      [...ids].sort(),
    );
    for (const id of ids) {
      const file = await readExport(rootDir, {
        agentId: AGENT_ID,
        trajectoryId: id,
      });
      expect(
        stored?.find((trajectory) => trajectory.trajectoryId === id),
      ).toEqual(file);
    }
    const second = await readExport(rootDir, {
      agentId: AGENT_ID,
      trajectoryId: ids[1] as string,
    });
    expect(second.status).toBe("errored");
    expect(second.metrics.finalDecision).toBe("error");
    expect(second.stages.map((stage) => stage.stageId)).toEqual([
      "second-planner",
    ]);
    // The viewer reads the same stages on the turn's step.
    const detail = await service.getTrajectoryDetail(turnId);
    expect(
      detail?.steps
        ?.flatMap((step) => step.semanticStages ?? [])
        .map((stage) => stage.stageId),
    ).toEqual(["first-planner", "second-planner", "first-evaluation"]);
    await service.stop();
  });

  it("exports the complete record when the runtime has no SQL adapter", async () => {
    const runtime = {
      agentId: AGENT_ID,
      adapter: { db: {} },
      getService: () => null,
      getServicesByType: () => [],
      reportError: vi.fn(),
      logger: { warn: vi.fn() },
    } as unknown as IAgentRuntime;
    const service = (await TrajectoriesService.start(
      runtime,
    )) as TrajectoriesService;
    expect(service.isEnabled()).toBe(false);
    const withService = {
      ...runtime,
      getService: () => service,
      getServicesByType: () => [service],
    } as unknown as IAgentRuntime;
    const recorder = createTrajectoryRecorder({
      runtime: withService,
      rootDir,
    });

    const id = recorder.startTrajectory({
      agentId: AGENT_ID,
      rootMessage: { id: "message-4", text: "no database" },
    });
    await recorder.recordStage(id, plannerStage("planner-only"));
    await recorder.endTrajectory(id, "finished");

    const file = await readExport(rootDir, {
      agentId: AGENT_ID,
      trajectoryId: id,
    });
    expect(file).toMatchObject({
      rootMessage: { id: "message-4", text: "no database" },
      runId: "run-7",
      scenarioId: "scenario-3",
      status: "finished",
      metrics: { plannerIterations: 1, finalDecision: "FINISH" },
    });
    expect(await recorder.load(id)).toEqual(file);
    expect(runtime.reportError).not.toHaveBeenCalled();
  });
});
