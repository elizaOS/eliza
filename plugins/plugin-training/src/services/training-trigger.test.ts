/**
 * TrainingTriggerService LifeOps coverage (#8795). Asserts that
 * `tasksForTrajectory` routes a LifeOps-tagged trajectory (purpose
 * calendar_extract, inbox_triage, …) to its own per-task bucket rather than the
 * generic `response` bucket, so per-task thresholds can fire:
 *
 *   - a LifeOps-purpose trajectory increments its own per-task counter,
 *   - a LifeOps per-task threshold fires `triggerTraining`,
 *   - the bootstrap task set includes the LifeOps capabilities from
 *     `LIFEOPS_OPTIMIZED_PROMPT_TASKS` in `@elizaos/core`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type IAgentRuntime,
  LIFEOPS_OPTIMIZED_PROMPT_TASKS,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRAINING_CONFIG,
  type TrainingConfig,
} from "../core/training-config.js";
import type {
  TrainingRunRecord,
  TriggerTrainingOptions,
} from "../core/training-orchestrator.js";
import {
  LIFEOPS_TRAINING_TASKS,
  type TrajectoryTrainingTask,
} from "../core/trajectory-task-datasets.js";
import {
  BOOTSTRAP_TASKS,
  bootstrapOptimizationFromAccumulatedTrajectories,
  TrainingTriggerService,
} from "./training-trigger.js";

const lifeOpsDetail = (task: TrajectoryTrainingTask, id: string) => ({
  trajectoryId: id,
  agentId: "agent-1",
  startTime: 1,
  steps: [
    {
      llmCalls: [
        {
          purpose: task,
          response: JSON.stringify({ ok: true, task }),
        },
      ],
    },
  ],
});

function makeConfig(overrides: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    ...DEFAULT_TRAINING_CONFIG,
    backends: [...DEFAULT_TRAINING_CONFIG.backends],
    ...overrides,
  };
}

function makeRunRecord(task: TrajectoryTrainingTask): TrainingRunRecord {
  return {
    runId: `run-${task}`,
    status: "succeeded",
    task,
    backend: "native",
    source: "threshold",
    datasetSize: 1,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    pulledTrajectories: 1,
    filteredTrajectories: 1,
    redactionCount: 0,
    anonymizationCount: 0,
    dryRun: false,
  };
}

describe("TrainingTriggerService LifeOps counting", () => {
  let stateDir: string;
  let statePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "training-trigger-lifeops-"));
    statePath = join(stateDir, "trigger-state.json");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeService(input: {
    config: TrainingConfig;
    details: Map<string, unknown>;
    firedTask?: TrajectoryTrainingTask;
  }) {
    const triggerImpl = vi.fn(
      async (
        _runtime: unknown,
        options: TriggerTrainingOptions,
      ): Promise<TrainingRunRecord> =>
        makeRunRecord(options.task ?? input.firedTask ?? "calendar_extract"),
    );
    const runtime = {
      getService: (name: string) =>
        name === "trajectories"
          ? {
              getTrajectoryDetail: async (id: string) =>
                input.details.get(id) ?? null,
            }
          : null,
    };
    const service = new TrainingTriggerService(runtime, {
      statePath,
      configLoader: () => input.config,
      triggerImpl,
    });
    return { service, triggerImpl };
  }

  it("increments the per-task counter for every LifeOps purpose", async () => {
    for (const task of LIFEOPS_TRAINING_TASKS) {
      const details = new Map<string, unknown>([
        [`tj-${task}`, lifeOpsDetail(task, `tj-${task}`)],
      ]);
      const { service } = makeService({
        config: makeConfig({ triggerThreshold: 1000 }),
        details,
      });
      await service.notifyTrajectoryCompleted(`tj-${task}`);
      const status = service.getStatus();
      expect(status.counters[task], `counter for ${task}`).toBe(1);
      // The LifeOps tag classified the call — it must not fall through to the
      // generic `response` bucket (the pre-fix behavior).
      expect(status.counters.response).toBe(0);
      service.resetCounters();
    }
  });

  it("fires triggerTraining when a LifeOps per-task threshold is reached", async () => {
    const details = new Map<string, unknown>([
      ["tj-1", lifeOpsDetail("inbox_triage", "tj-1")],
      ["tj-2", lifeOpsDetail("inbox_triage", "tj-2")],
    ]);
    const { service, triggerImpl } = makeService({
      config: makeConfig({
        triggerThreshold: 1000,
        perTaskOverrides: { inbox_triage: { threshold: 2 } },
      }),
      details,
      firedTask: "inbox_triage",
    });

    await service.notifyTrajectoryCompleted("tj-1");
    expect(triggerImpl).not.toHaveBeenCalled();

    await service.notifyTrajectoryCompleted("tj-2");
    expect(triggerImpl).toHaveBeenCalledTimes(1);
    expect(triggerImpl.mock.calls[0]?.[1]).toMatchObject({
      task: "inbox_triage",
      source: "threshold",
    });
    // Counter resets after the fired run completes.
    expect(service.getStatus().counters.inbox_triage).toBe(0);
  });

  it("does not increment LifeOps counters for a generic trajectory", async () => {
    const details = new Map<string, unknown>([
      [
        "tj-generic",
        {
          trajectoryId: "tj-generic",
          agentId: "agent-1",
          startTime: 1,
          steps: [
            {
              llmCalls: [{ purpose: "message_response", response: "hi" }],
            },
          ],
        },
      ],
    ]);
    const { service } = makeService({
      config: makeConfig({ triggerThreshold: 1000 }),
      details,
    });
    await service.notifyTrajectoryCompleted("tj-generic");
    const status = service.getStatus();
    expect(status.counters.response).toBe(1);
    for (const task of LIFEOPS_TRAINING_TASKS) {
      expect(status.counters[task], `counter for ${task}`).toBe(0);
    }
  });
});

describe("bootstrap task set", () => {
  it("includes every LifeOps capability from @elizaos/core", () => {
    for (const task of LIFEOPS_OPTIMIZED_PROMPT_TASKS) {
      expect(BOOTSTRAP_TASKS).toContain(task);
    }
    expect(BOOTSTRAP_TASKS).toContain("should_respond");
    expect(BOOTSTRAP_TASKS).toContain("action_planner");
  });

  it("fires the bootstrap pass for a LifeOps task whose counter is at threshold", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "training-trigger-boot-"));
    try {
      const statePath = join(stateDir, "trigger-state.json");
      const config = makeConfig({
        triggerThreshold: 1000,
        perTaskOverrides: { morning_brief: { threshold: 1 } },
      });
      const details = new Map<string, unknown>([
        ["tj-brief", lifeOpsDetail("morning_brief", "tj-brief")],
      ]);
      const runtime = {
        getService: (name: string) =>
          name === "trajectories"
            ? {
                getTrajectoryDetail: async (id: string) =>
                  details.get(id) ?? null,
              }
            : null,
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        services: new Map(),
      };
      // Threshold 1 but autoTrain-off config for accumulation, so the counter
      // ticks without threshold-firing; bootstrap then observes the counter.
      const accumulateConfig = makeConfig({
        triggerThreshold: 1000,
        perTaskOverrides: { morning_brief: { threshold: 1000 } },
      });
      const service = new TrainingTriggerService(runtime, {
        statePath,
        configLoader: () => accumulateConfig,
      });
      await service.notifyTrajectoryCompleted("tj-brief");
      expect(service.getStatus().counters.morning_brief).toBe(1);

      const bootService = new TrainingTriggerService(runtime, {
        statePath,
        configLoader: () => config,
      });
      const fired: Array<{ task: TrajectoryTrainingTask }> = [];
      const result = await bootstrapOptimizationFromAccumulatedTrajectories(
        runtime as unknown as IAgentRuntime,
        bootService,
        {
          configLoader: () => config,
          triggerOverride: async (input) => {
            fired.push({ task: input.task });
            return makeRunRecord(input.task);
          },
        },
      );
      expect(result).toContain("morning_brief");
      expect(fired.map((f) => f.task)).toContain("morning_brief");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
