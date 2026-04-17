import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTrainingConfig,
  normalizeTrainingConfig,
  saveTrainingConfig,
  trainingConfigPath,
} from "../src/core/training-config.js";
import {
  type BackendDispatcher,
  type TrainingRunRecord,
  triggerTraining,
} from "../src/core/training-orchestrator.js";
import {
  registerTrainingTriggerService,
  TRAINING_TRIGGER_SERVICE,
  TrainingTriggerService,
} from "../src/services/training-trigger.js";

let stateDir: string;
let prevState: string | undefined;
let prevElizaState: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "training-trigger-"));
  prevState = process.env.MILADY_STATE_DIR;
  prevElizaState = process.env.ELIZA_STATE_DIR;
  process.env.MILADY_STATE_DIR = stateDir;
  delete process.env.ELIZA_STATE_DIR;
});

afterEach(() => {
  if (prevState === undefined) delete process.env.MILADY_STATE_DIR;
  else process.env.MILADY_STATE_DIR = prevState;
  if (prevElizaState !== undefined)
    process.env.ELIZA_STATE_DIR = prevElizaState;
  rmSync(stateDir, { recursive: true, force: true });
});

interface FakeTrajectory {
  trajectoryId: string;
  steps: Array<{
    llmCalls: Array<{
      systemPrompt?: string;
      userPrompt?: string;
      response?: string;
      purpose?: string;
      metadata?: Record<string, unknown>;
    }>;
  }>;
  metadata: Record<string, unknown>;
}

function makeRuntime(trajectories: FakeTrajectory[]) {
  const services = new Map<string, unknown[]>();
  const runtime = {
    services,
    getService: (name: string) => {
      if (name === "trajectories") {
        return {
          listTrajectories: async () => ({
            trajectories: trajectories.map((t) => ({ id: t.trajectoryId })),
          }),
          getTrajectoryDetail: async (id: string) =>
            trajectories.find((t) => t.trajectoryId === id) ?? null,
        };
      }
      return null;
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { runtime, services };
}

function shouldRespondTrajectory(id: string): FakeTrajectory {
  return {
    trajectoryId: id,
    steps: [
      {
        llmCalls: [
          {
            systemPrompt: "system",
            userPrompt: "user",
            response: "RESPOND",
            purpose: "should_respond",
            metadata: { callKind: "should_respond" },
          },
        ],
      },
    ],
    metadata: {},
  };
}

describe("TrainingConfig persistence", () => {
  it("returns defaults when no file exists", () => {
    const config = loadTrainingConfig();
    expect(config.autoTrain).toBe(true);
    expect(config.triggerThreshold).toBe(100);
    expect(config.triggerCooldownHours).toBe(12);
    // Hermes-parity default: native backend is enabled out of the box.
    expect(config.backends).toEqual(["native"]);
  });

  it("normalizes invalid input to defaults", () => {
    const config = normalizeTrainingConfig({
      autoTrain: "yes",
      triggerThreshold: -5,
      triggerCooldownHours: "x",
      backends: ["bogus", "vertex", "vertex"],
    });
    expect(config.autoTrain).toBe(true);
    expect(config.triggerThreshold).toBe(100);
    expect(config.triggerCooldownHours).toBe(12);
    // Caller's explicit backend list is honored — defaults only fill in
    // missing fields, not supplied ones.
    expect(config.backends).toEqual(["vertex"]);
  });

  it("persists and reloads a custom config", () => {
    saveTrainingConfig({
      autoTrain: false,
      triggerThreshold: 25,
      triggerCooldownHours: 1,
      backends: ["atropos"],
    });
    expect(existsSync(trainingConfigPath())).toBe(true);
    const reloaded = loadTrainingConfig();
    expect(reloaded.autoTrain).toBe(false);
    expect(reloaded.triggerThreshold).toBe(25);
    expect(reloaded.triggerCooldownHours).toBe(1);
    expect(reloaded.backends).toEqual(["atropos"]);
  });
});

describe("triggerTraining orchestrator", () => {
  it("skips when trajectories service is unavailable", async () => {
    const runtime = {
      services: new Map<string, unknown[]>(),
      getService: () => null,
      logger: { info() {}, warn() {}, error() {} },
    };
    const record = await triggerTraining(runtime, { source: "manual" });
    expect(record.status).toBe("skipped");
    expect(record.reason).toMatch(/trajectories service unavailable/);
  });

  it("runs the privacy filter and exports per-task datasets before dispatch", async () => {
    const trajectories = [
      shouldRespondTrajectory("t-1"),
      shouldRespondTrajectory("t-2"),
    ];
    const { runtime } = makeRuntime(trajectories);

    const dispatchCalls: Array<{ task: string; backend: string }> = [];
    const dispatcher: BackendDispatcher = async (input) => {
      dispatchCalls.push({ task: input.task, backend: input.backend });
      return { invoked: true, artifactPath: input.datasetPath };
    };

    const record = await triggerTraining(runtime, {
      source: "manual",
      task: "should_respond",
      backend: "atropos",
      dispatcher,
    });

    expect(record.status).toBe("succeeded");
    expect(record.task).toBe("should_respond");
    expect(record.backend).toBe("atropos");
    expect(dispatchCalls).toEqual([
      { task: "should_respond", backend: "atropos" },
    ]);
    expect(record.datasetPaths).toBeDefined();
    expect(record.pulledTrajectories).toBe(2);
  });

  it("skips when no backend is configured and none was requested", async () => {
    const { runtime } = makeRuntime([shouldRespondTrajectory("t-1")]);
    const record = await triggerTraining(runtime, {
      source: "manual",
      task: "should_respond",
    });
    expect(record.status).toBe("skipped");
    expect(record.reason).toMatch(/no backend configured/);
  });

  it("dry-run reports succeeded without invoking dispatcher", async () => {
    const { runtime } = makeRuntime([shouldRespondTrajectory("t-1")]);
    let dispatched = false;
    const dispatcher: BackendDispatcher = async () => {
      dispatched = true;
      return { invoked: true };
    };
    const record = await triggerTraining(runtime, {
      source: "manual",
      task: "should_respond",
      backend: "atropos",
      dryRun: true,
      dispatcher,
    });
    expect(dispatched).toBe(false);
    expect(record.status).toBe("succeeded");
    expect(record.dryRun).toBe(true);
    expect(record.notes?.[0] ?? "").toMatch(/dry run/);
  });

  it("persists run records under <state>/training/runs/", async () => {
    const { runtime } = makeRuntime([shouldRespondTrajectory("t-1")]);
    const record = await triggerTraining(runtime, {
      source: "manual",
      task: "should_respond",
      backend: "atropos",
      dispatcher: async () => ({ invoked: true }),
    });
    const runFile = join(stateDir, "training", "runs", `${record.runId}.json`);
    expect(existsSync(runFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(runFile, "utf-8"));
    expect(persisted.runId).toBe(record.runId);
    expect(persisted.status).toBe("succeeded");
  });
});

describe("TrainingTriggerService", () => {
  it("does not increment counters when autoTrain is disabled", async () => {
    saveTrainingConfig({
      autoTrain: false,
      triggerThreshold: 2,
      triggerCooldownHours: 0,
      backends: ["atropos"],
    });
    const { runtime } = makeRuntime([shouldRespondTrajectory("t-1")]);
    let triggerInvocations = 0;
    const service = new TrainingTriggerService(runtime, {
      triggerImpl: (async () => {
        triggerInvocations += 1;
        return {
          runId: "noop",
          status: "succeeded",
          task: "should_respond",
          backend: "atropos",
          source: "threshold",
          datasetSize: 0,
          startedAt: "",
          finishedAt: "",
          pulledTrajectories: 0,
          filteredTrajectories: 0,
          redactionCount: 0,
          anonymizationCount: 0,
          dryRun: false,
        } satisfies TrainingRunRecord;
      }) as unknown as typeof triggerTraining,
    });
    await service.notifyTrajectoryCompleted("t-1");
    expect(service.getStatus().counters.should_respond).toBe(0);
    expect(triggerInvocations).toBe(0);
  });

  it("fires the orchestrator when the per-task threshold is reached", async () => {
    saveTrainingConfig({
      autoTrain: true,
      triggerThreshold: 2,
      triggerCooldownHours: 0,
      backends: ["atropos"],
    });
    const trajectories = [
      shouldRespondTrajectory("t-1"),
      shouldRespondTrajectory("t-2"),
    ];
    const { runtime } = makeRuntime(trajectories);
    const fired: string[] = [];
    const service = new TrainingTriggerService(runtime, {
      triggerImpl: (async (
        _runtime: unknown,
        opts: { task?: string; source: string },
      ) => {
        fired.push(`${opts.source}:${opts.task ?? "any"}`);
        return {
          runId: `r-${fired.length}`,
          status: "succeeded",
          task: (opts.task as TrainingRunRecord["task"]) ?? null,
          backend: "atropos",
          source: opts.source as TrainingRunRecord["source"],
          datasetSize: 1,
          startedAt: "2025-01-01T00:00:00.000Z",
          finishedAt: "2025-01-01T00:00:01.000Z",
          pulledTrajectories: 1,
          filteredTrajectories: 1,
          redactionCount: 0,
          anonymizationCount: 0,
          dryRun: false,
        } satisfies TrainingRunRecord;
      }) as unknown as typeof triggerTraining,
    });

    await service.notifyTrajectoryCompleted("t-1");
    expect(fired).toHaveLength(0);
    await service.notifyTrajectoryCompleted("t-2");
    expect(fired).toEqual(["threshold:should_respond"]);
    // Counter is reset after a successful fire.
    expect(service.getStatus().counters.should_respond).toBe(0);
  });

  it("respects cooldown across multiple bursts", async () => {
    saveTrainingConfig({
      autoTrain: true,
      triggerThreshold: 1,
      triggerCooldownHours: 1,
      backends: ["atropos"],
    });
    const { runtime } = makeRuntime([
      shouldRespondTrajectory("t-1"),
      shouldRespondTrajectory("t-2"),
    ]);
    let fakeNow = 1_700_000_000_000;
    let fired = 0;
    const service = new TrainingTriggerService(runtime, {
      now: () => fakeNow,
      triggerImpl: (async () => {
        fired += 1;
        return {
          runId: `r-${fired}`,
          status: "succeeded",
          task: "should_respond",
          backend: "atropos",
          source: "threshold",
          datasetSize: 1,
          startedAt: "",
          finishedAt: "",
          pulledTrajectories: 1,
          filteredTrajectories: 1,
          redactionCount: 0,
          anonymizationCount: 0,
          dryRun: false,
        } satisfies TrainingRunRecord;
      }) as unknown as typeof triggerTraining,
    });

    await service.notifyTrajectoryCompleted("t-1");
    expect(fired).toBe(1);
    // Within the cooldown window — should not fire even though counter hits threshold again.
    fakeNow += 60_000;
    await service.notifyTrajectoryCompleted("t-2");
    expect(fired).toBe(1);
    // Past cooldown.
    fakeNow += 3_600_000;
    await service.notifyTrajectoryCompleted("t-1");
    expect(fired).toBe(2);
  });

  it("persists counters across constructor instances", async () => {
    saveTrainingConfig({
      autoTrain: true,
      triggerThreshold: 100,
      triggerCooldownHours: 12,
      backends: [],
    });
    const { runtime } = makeRuntime([shouldRespondTrajectory("t-1")]);
    const noopTrigger = (async () => ({
      runId: "noop",
      status: "skipped",
      task: null,
      backend: null,
      source: "threshold",
      datasetSize: 0,
      startedAt: "",
      finishedAt: "",
      pulledTrajectories: 0,
      filteredTrajectories: 0,
      redactionCount: 0,
      anonymizationCount: 0,
      dryRun: false,
    })) as unknown as typeof triggerTraining;

    const first = new TrainingTriggerService(runtime, {
      triggerImpl: noopTrigger,
    });
    await first.notifyTrajectoryCompleted("t-1");
    expect(first.getStatus().counters.should_respond).toBe(1);

    const second = new TrainingTriggerService(runtime, {
      triggerImpl: noopTrigger,
    });
    expect(second.getStatus().counters.should_respond).toBe(1);
  });

  it("registers into the runtime services map under TRAINING_TRIGGER_SERVICE", () => {
    const { runtime, services } = makeRuntime([]);
    const service = registerTrainingTriggerService(runtime);
    const entries = services.get(TRAINING_TRIGGER_SERVICE);
    expect(entries).toBeDefined();
    expect(Array.isArray(entries)).toBe(true);
    const entry = entries?.[0] as
      | { instance: TrainingTriggerService }
      | undefined;
    expect(entry?.instance).toBe(service);
  });
});
