/** Real task execution and PGlite trajectory persistence; no model provider calls. */

import { randomUUID } from "node:crypto";
import {
  getTrajectoryContext,
  logActiveTrajectoryLlmCall,
  ModelType,
  PseudonymSession,
  recordLlmCall,
  runWithTrajectoryContext,
  runWithTrajectoryPurpose,
  SecretSwapSession,
  TaskService,
  withStandaloneTrajectory,
} from "@elizaos/core";
import { trajectoriesPlugin } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  DatabaseTrajectoryLogger,
  installDatabaseTrajectoryLogger,
} from "../src/runtime/trajectory-storage.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let reader: DatabaseTrajectoryLogger;
let service: TaskService;
beforeAll(async () => {
  vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "1");
  vi.stubEnv("ELIZA_DISABLE_TRAJECTORY_LOGGING", undefined);
  fixture = await createTestRuntime({
    characterName: "TaskCaptureAcceptance",
    plugins: [trajectoriesPlugin],
  });
  await fixture.runtime.getServiceLoadPromise("trajectories");
  await installDatabaseTrajectoryLogger(fixture.runtime);
  reader = new DatabaseTrajectoryLogger(fixture.runtime);
  reader.setEnabled(true);
  service = new TaskService(fixture.runtime);
}, 120_000);
afterAll(async () => {
  if (reader) await reader.stop();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
});
it("preserves step-less ambient privacy sessions when starting a standalone capture", async () => {
  const secretSwapSession = new SecretSwapSession({
    knownSecrets: { TEST_KEY: "private-fixture-secret-12345" },
  });
  const piiSwapSession = new PseudonymSession();
  const roomId = randomUUID();
  await runWithTrajectoryContext(
    { secretSwapSession, piiSwapSession, roomId },
    () =>
      withStandaloneTrajectory(
        fixture.runtime,
        { source: "task-context-test" },
        () => {
          expect(getTrajectoryContext()?.trajectoryStepId).toBeTruthy();
          expect(getTrajectoryContext()?.secretSwapSession).toBe(
            secretSwapSession,
          );
          expect(getTrajectoryContext()?.piiSwapSession).toBe(piiSwapSession);
          expect(getTrajectoryContext()?.roomId).toBe(roomId);
        },
      ),
  );
  expect(getTrajectoryContext()).toBeUndefined();
});

for (const failure of [false, true]) {
  it(`persists complete background call bodies and ${failure ? "failure" : "success"} task bookkeeping`, async () => {
    const name = `capture-${randomUUID()}`;
    const prompt = `request ${"retain entire input ".repeat(10_000)} FINAL-REQUEST`;
    const response = `result ${"retain entire output ".repeat(1_000)} FINAL-RESPONSE`;
    let trajectoryId: string | undefined;
    let executions = 0;
    fixture.runtime.registerTaskWorker({
      name,
      execute: async () => {
        executions += 1;
        await runWithTrajectoryPurpose("reminder_dispatch", async () => {
          await recordLlmCall(
            fixture.runtime,
            {
              model: "fixture-no-inference",
              purpose: "reminder_dispatch",
              actionType: "runtime.useModel",
              systemPrompt: "Complete synthetic task instructions",
              userPrompt: prompt,
              response,
              promptTokens: 13,
              completionTokens: 7,
            },
            () => {
              trajectoryId = getTrajectoryContext()?.trajectoryId;
              return response;
            },
          );
        });
        if (failure) throw new Error("controlled worker failure");
        return { nextInterval: 45_000 };
      },
    });
    const taskId = await fixture.runtime.createTask({
      name,
      tags: ["queue", "repeat"],
      metadata: {
        updateInterval: 60_000,
        updatedAt: 1,
        privateTaskBody: "must-not-copy-into-trajectory-metadata",
      },
    });
    if (failure) {
      await expect(service.executeTaskById(taskId)).rejects.toMatchObject({
        code: "TASK_EXECUTION_FAILED",
        cause: { message: "controlled worker failure" },
      });
    } else await service.executeTaskById(taskId);
    expect(executions).toBe(1);
    if (!trajectoryId)
      throw new Error("Worker did not receive a trajectory owner");
    const detail = await reader.getTrajectoryDetail(trajectoryId);
    expect(detail?.status).toBe(failure ? "error" : "completed");
    expect(detail?.metadata).toMatchObject({ taskId, taskName: name });
    expect(JSON.stringify(detail?.metadata)).not.toContain("must-not-copy");
    expect(detail?.steps?.flatMap((step) => step.llmCalls ?? [])).toEqual([
      expect.objectContaining({
        purpose: "reminder_dispatch",
        systemPrompt: "Complete synthetic task instructions",
        userPrompt: prompt,
        response,
        promptTokens: 13,
        completionTokens: 7,
      }),
    ]);
    const task = await fixture.runtime.getTask(taskId);
    expect(task?.metadata).toMatchObject(
      failure
        ? { failureCount: 1, lastError: "controlled worker failure" }
        : { updateInterval: 45_000, failureCount: 0 },
    );
    expect(getTrajectoryContext()).toBeUndefined();
    await fixture.runtime.deleteTask(taskId);
  });
}

it("reuses an active step without closing its owner and preserves task results", async () => {
  const owner = await reader.startTrajectory(fixture.runtime.agentId, {
    source: "foreground-owner",
  });
  const stepId = reader.startStep(owner, { kind: "llm" });
  await reader.flushWriteQueue(owner);
  const secretSwapSession = new SecretSwapSession();
  let executions = 0;
  const name = `active-${randomUUID()}`;
  fixture.runtime.registerTaskWorker({
    name,
    execute: async () => {
      executions += 1;
      expect(getTrajectoryContext()?.trajectoryStepId).toBe(stepId);
      expect(getTrajectoryContext()?.secretSwapSession).toBe(secretSwapSession);
      expect(
        logActiveTrajectoryLlmCall(fixture.runtime, {
          model: "fixture",
          systemPrompt: "system",
          userPrompt: "active task",
          purpose: "active_task",
          actionType: "runtime.useModel",
          response: "done",
        }),
      ).toBe(true);
      return { preserveTask: true };
    },
  });
  const taskId = await fixture.runtime.createTask({
    name,
    tags: ["queue"],
    metadata: { untouched: true },
  });
  const before = await reader.listTrajectories({});
  await runWithTrajectoryContext(
    { trajectoryId: owner, trajectoryStepId: stepId, secretSwapSession },
    () => service.executeTaskById(taskId),
  );
  await reader.flushWriteQueue(owner);
  expect(executions).toBe(1);
  expect((await reader.listTrajectories({})).total).toBe(before.total);
  expect((await reader.getTrajectoryDetail(owner))?.status).not.toBe(
    "completed",
  );
  expect((await fixture.runtime.getTask(taskId))?.metadata).toEqual({
    untouched: true,
  });
  await reader.endTrajectory(owner, "completed");
  expect(
    (await reader.getTrajectoryDetail(owner))?.steps?.flatMap(
      (step) => step.llmCalls ?? [],
    ),
  ).toHaveLength(1);
  await fixture.runtime.deleteTask(taskId);
});

it("does not create capture when recording is disabled and still executes once", async () => {
  const logger = fixture.runtime.getService("trajectories") as unknown as {
    setEnabled(enabled: boolean): void;
  };
  const before = await reader.listTrajectories({});
  const name = `disabled-${randomUUID()}`;
  let executions = 0;
  fixture.runtime.registerTaskWorker({
    name,
    execute: async () => {
      executions += 1;
      expect(getTrajectoryContext()?.trajectoryStepId).toBeUndefined();
      expect(
        logActiveTrajectoryLlmCall(fixture.runtime, {
          model: "fixture",
          userPrompt: "not recorded",
          systemPrompt: "disabled fixture",
          purpose: "disabled_task",
          response: "done",
        }),
      ).toBe(false);
    },
  });
  const taskId = await fixture.runtime.createTask({ name, tags: ["queue"] });
  logger.setEnabled(false);
  try {
    await service.executeTaskById(taskId);
  } finally {
    logger.setEnabled(true);
  }
  expect(executions).toBe(1);
  expect(await fixture.runtime.getTask(taskId)).toBeNull();
  expect((await reader.listTrajectories({})).total).toBe(before.total);
});

it("creates zero capture rows for 100 enabled no-model executions", async () => {
  const before = await reader.listTrajectories({});
  const name = `no-model-${randomUUID()}`;
  const owners: string[] = [];
  fixture.runtime.registerTaskWorker({
    name,
    execute: async () => {
      owners.push(getTrajectoryContext()?.trajectoryId ?? "");
      return { preserveTask: true };
    },
  });
  const taskId = await fixture.runtime.createTask({ name, tags: ["queue"] });
  for (let i = 0; i < 100; i++) await service.executeTaskById(taskId);
  expect(owners).toHaveLength(100);
  expect(owners.every((id) => id === "")).toBe(true);
  expect((await reader.listTrajectories({})).total).toBe(before.total);
  await fixture.runtime.deleteTask(taskId);
});

it("reports capture cleanup failure without retrying or failing completed task work", async () => {
  const logger = fixture.runtime.getService("trajectories") as unknown as {
    flushWriteQueue(id?: string): Promise<void>;
  };
  const captureFailure = new Error("controlled telemetry flush failure");
  const flush = vi
    .spyOn(logger, "flushWriteQueue")
    .mockRejectedValueOnce(captureFailure);
  const diagnostics = vi.spyOn(fixture.runtime, "reportError");
  const name = `cleanup-${randomUUID()}`;
  let executions = 0;
  fixture.runtime.registerTaskWorker({
    name,
    execute: async () => {
      executions += 1;
      await recordLlmCall(
        fixture.runtime,
        {
          model: "fixture",
          purpose: "task_test",
          systemPrompt: "fixture",
          actionType: "runtime.useModel",
          userPrompt: "cleanup",
          response: "done",
        },
        () => "done",
      );
    },
  });
  const taskId = await fixture.runtime.createTask({ name, tags: ["queue"] });
  try {
    await service.executeTaskById(taskId);
    expect(executions).toBe(1);
    expect(await fixture.runtime.getTask(taskId)).toBeNull();
    expect(diagnostics).toHaveBeenCalledWith(
      "StandaloneTrajectory.flush",
      captureFailure,
      expect.objectContaining({ diagnosticOnly: true }),
    );
  } finally {
    flush.mockRestore();
    diagnostics.mockRestore();
  }
});

it("persists upstream-swapped task payloads without restoring secret or PII values", async () => {
  const secret = "synthetic-task-secret-abcdef123456";
  const person = "Patricia Fixtureperson";
  const original = `${person} uses ${secret}`;
  const secretSwapSession = new SecretSwapSession({
    knownSecrets: { TEST_KEY: secret },
  });
  const piiSwapSession = new PseudonymSession({
    salt: "task-persistence-fixture",
  });
  piiSwapSession.learnSpans(original, [{ kind: "person", value: person }]);
  const expected = piiSwapSession.substituteText(
    secretSwapSession.substituteText(original),
  );
  expect(expected).not.toContain(secret);
  expect(expected).not.toContain(person);
  expect(expected).toContain("__ELIZA_SECRET_");
  expect(
    secretSwapSession.restoreText(piiSwapSession.restoreText(expected)),
  ).toBe(original);
  let owner: string | undefined;
  const name = `swapped-${randomUUID()}`;
  fixture.runtime.registerTaskWorker({
    name,
    execute: async () => {
      const context = getTrajectoryContext();
      owner = context?.trajectoryId;
      if (!context?.secretSwapSession || !context.piiSwapSession)
        throw new Error("Task lost its existing privacy sessions");
      // The dispatcher prepares provider payloads with these sessions; the
      // recording boundary must persist those bytes, not restore their values.
      const prepared = context.piiSwapSession.substituteText(
        context.secretSwapSession.substituteText(original),
      );
      await recordLlmCall(
        fixture.runtime,
        {
          model: "fixture-no-inference",
          purpose: "reminder_dispatch",
          actionType: "runtime.useModel",
          systemPrompt: prepared,
          userPrompt: prepared,
          response: prepared,
        },
        () => {
          owner = getTrajectoryContext()?.trajectoryId;
          return prepared;
        },
      );
    },
  });
  const taskId = await fixture.runtime.createTask({ name, tags: ["queue"] });
  await runWithTrajectoryContext({ secretSwapSession, piiSwapSession }, () =>
    service.executeTaskById(taskId),
  );
  if (!owner) throw new Error("Task did not create a capture owner");
  const detail = await reader.getTrajectoryDetail(owner);
  expect(detail?.steps?.flatMap((step) => step.llmCalls ?? [])).toEqual([
    expect.objectContaining({
      systemPrompt: expected,
      userPrompt: expected,
      response: expected,
    }),
  ]);
  expect(JSON.stringify(detail)).not.toContain(secret);
  expect(JSON.stringify(detail)).not.toContain(person);
});

it("allocates once for parallel model calls and isolates concurrent tasks and privacy", async () => {
  const before = await reader.listTrajectories({});
  const name = `parallel-${randomUUID()}`;
  const owners = new Map<string, Set<string>>();
  fixture.runtime.registerModel(
    ModelType.TEXT_SMALL,
    async () => {
      const context = getTrajectoryContext();
      if (!context?.trajectoryId || !context.trajectoryStepId)
        throw Error("No capture before handler");
      const key = context.roomId ?? "missing";
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(context.trajectoryId);
      owners.set(key, ids);
      expect(context.secretSwapSession).toBeTruthy();
      expect(context.piiSwapSession).toBeTruthy();
      return "synthetic result";
    },
    "task-test",
    1000,
  );
  fixture.runtime.registerTaskWorker({
    name,
    execute: async () => {
      await Promise.all(
        ["one", "two"].map((purpose) =>
          runWithTrajectoryPurpose(purpose, () =>
            fixture.runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "full synthetic request",
            }),
          ),
        ),
      );
    },
  });
  const ids = await Promise.all(
    [1, 2].map(() => fixture.runtime.createTask({ name, tags: ["queue"] })),
  );
  await Promise.all(
    ids.map((id) =>
      runWithTrajectoryContext(
        {
          trajectoryId: "obsolete-owner",
          roomId: id,
          secretSwapSession: new SecretSwapSession(),
          piiSwapSession: new PseudonymSession(),
        },
        () => service.executeTaskById(id),
      ),
    ),
  );
  expect(owners.size).toBe(2);
  const distinct = [...owners.values()].flatMap((set) => [...set]);
  expect(distinct).toHaveLength(2);
  expect(new Set(distinct).size).toBe(2);
  expect(distinct).not.toContain("obsolete-owner");
  expect((await reader.listTrajectories({})).total).toBe(before.total + 2);
  for (const id of distinct)
    expect(
      (await reader.getTrajectoryDetail(id))?.steps?.flatMap(
        (step) => step.llmCalls ?? [],
      ),
    ).toHaveLength(2);
});

it("captures PII generation and nested text fallback but not embedding-only work", async () => {
  const before = await reader.listTrajectories({});
  let piiOwner: string | undefined;
  fixture.runtime.registerModel(
    ModelType.PII_SCRUB,
    async () => {
      piiOwner = getTrajectoryContext()?.trajectoryId;
      expect(piiOwner).toBeTruthy();
      return {
        verdicts: [],
        modelId: "synthetic-local",
        rulesetVersion: "test",
      };
    },
    "task-test",
    1000,
  );
  fixture.runtime.registerModel(
    ModelType.TEXT_EMBEDDING,
    async () => [1, 0],
    "task-test",
    1000,
  );
  const embedding = `embedding-${randomUUID()}`;
  fixture.runtime.registerTaskWorker({
    name: embedding,
    execute: async () => {
      await fixture.runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: "synthetic",
      });
    },
  });
  await service.executeTaskById(
    await fixture.runtime.createTask({ name: embedding, tags: ["queue"] }),
  );
  expect((await reader.listTrajectories({})).total).toBe(before.total);
  const pii = `pii-${randomUUID()}`;
  fixture.runtime.registerTaskWorker({
    name: pii,
    execute: async () => {
      await fixture.runtime.useModel(ModelType.PII_SCRUB, {
        text: "synthetic",
        candidateSpans: [],
        rulesetVersion: "test",
      });
    },
  });
  await service.executeTaskById(
    await fixture.runtime.createTask({ name: pii, tags: ["queue"] }),
  );
  expect((await reader.listTrajectories({})).total).toBe(before.total + 1);
  if (!piiOwner) throw Error("Missing PII owner");
  expect(
    (await reader.getTrajectoryDetail(piiOwner))?.steps?.flatMap(
      (step) => step.llmCalls ?? [],
    ),
  ).toHaveLength(1);
  fixture.runtime.registerModel(
    ModelType.TEXT_SMALL,
    async () => "fallback",
    "task-test",
    1001,
  );
  fixture.runtime.registerModel(
    ModelType.TEXT_EMBEDDING,
    async () => {
      await fixture.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "fallback generation",
      });
      return [1, 0];
    },
    "task-test",
    1001,
  );
  await service.executeTaskById(
    await fixture.runtime.createTask({ name: embedding, tags: ["queue"] }),
  );
  expect((await reader.listTrajectories({})).total).toBe(before.total + 2);
});

for (const cancel of [false, true]) {
  it(`retains deferred stream finalization on ${cancel ? "cancellation" : "completion"}`, async () => {
    let owner: string | undefined;
    let finalized = false;
    const controller = new AbortController();
    fixture.runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => {
        owner = getTrajectoryContext()?.trajectoryId;
        if (!owner) throw Error("Stream started without capture");
        let resolveText!: (text: string) => void;
        const text = new Promise<string>((resolve) => {
          resolveText = resolve;
        });
        return {
          text,
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({
            promptTokens: 2,
            completionTokens: 2,
            totalTokens: 4,
          }),
          textStream: (async function* () {
            try {
              yield "first";
              yield " second";
            } finally {
              finalized = true;
              expect(
                logActiveTrajectoryLlmCall(fixture.runtime, {
                  model: "synthetic-stream",
                  actionType: "runtime.useModel",
                  purpose: "task_test",
                  systemPrompt: "fixture",
                  userPrompt: "stream input",
                  response: cancel ? "first" : "first second",
                  finishReason: cancel ? "error" : "stop",
                }),
              ).toBe(true);
              resolveText(cancel ? "first" : "first second");
            }
          })(),
        };
      },
      `task-stream-test-${cancel}`,
      cancel ? 2001 : 2000,
    );
    const name = `stream-${randomUUID()}`;
    fixture.runtime.registerTaskWorker({
      name,
      execute: async () => {
        const result = await fixture.runtime.useModel<
          typeof ModelType.TEXT_LARGE,
          import("@elizaos/core").TextStreamResult
        >(ModelType.TEXT_LARGE, {
          prompt: "stream input",
          stream: true,
          signal: controller.signal,
        });
        for await (const chunk of result.textStream) {
          expect(chunk).toBeTruthy();
          if (cancel)
            controller.abort(new Error("controlled stream cancellation"));
        }
      },
    });
    const id = await fixture.runtime.createTask({ name, tags: ["queue"] });
    if (cancel) await expect(service.executeTaskById(id)).rejects.toThrow();
    else await service.executeTaskById(id);
    expect(finalized).toBe(true);
    if (!owner) throw Error("Missing stream capture");
    const detail = await reader.getTrajectoryDetail(owner);
    expect(detail?.status).toBe(cancel ? "error" : "completed");
    expect(detail?.steps?.flatMap((step) => step.llmCalls ?? [])).toEqual([
      expect.objectContaining({
        model: "synthetic-stream",
        userPrompt: "stream input",
        response: cancel ? "first" : "first second",
      }),
    ]);
  });
}

it("does not retry capture initialization or worker work when capture setup fails", async () => {
  const logger = fixture.runtime.getService("trajectories") as unknown as {
    startTrajectory: (...args: unknown[]) => Promise<string>;
  };
  const start = vi
    .spyOn(logger, "startTrajectory")
    .mockRejectedValue(new Error("synthetic capture setup failure"));
  const report = vi.spyOn(fixture.runtime, "reportError");
  const before = await reader.listTrajectories({});
  let calls = 0;
  const name = `setup-failure-${randomUUID()}`;
  fixture.runtime.registerTaskWorker({
    name,
    execute: async () => {
      for (let i = 0; i < 2; i++)
        await recordLlmCall(
          fixture.runtime,
          {
            model: "fixture",
            purpose: "task_test",
            systemPrompt: "fixture",
            userPrompt: "unrecorded only on diagnostic failure",
          },
          () => {
            calls++;
            return "done";
          },
        );
    },
  });
  const id = await fixture.runtime.createTask({ name, tags: ["queue"] });
  try {
    await service.executeTaskById(id);
    expect(calls).toBe(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect((await reader.listTrajectories({})).total).toBe(before.total);
    expect(await fixture.runtime.getTask(id)).toBeNull();
    expect(report).toHaveBeenCalledWith(
      "StandaloneTrajectory.start",
      expect.any(Error),
      expect.objectContaining({ diagnosticOnly: true }),
    );
  } finally {
    start.mockRestore();
    report.mockRestore();
  }
});

it("does not enter the model handler if cancellation arrives during capture initialization", async () => {
  const logger = fixture.runtime.getService("trajectories") as unknown as {
    startTrajectory: (...args: unknown[]) => Promise<string>;
  };
  const original = logger.startTrajectory.bind(logger);
  let admit!: () => void;
  const initializing = new Promise<void>((resolve) => {
    admit = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = vi
    .spyOn(logger, "startTrajectory")
    .mockImplementation(async (...args) => {
      admit();
      await released;
      return original(...args);
    });
  const controller = new AbortController();
  let providerCalls = 0;
  fixture.runtime.registerModel(
    ModelType.TEXT_SMALL,
    async () => {
      providerCalls++;
      return "not reached";
    },
    "cancel-during-capture",
    3000,
  );
  const name = `init-cancel-${randomUUID()}`;
  fixture.runtime.registerTaskWorker({
    name,
    execute: async () => {
      await fixture.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "cancel before provider",
        signal: controller.signal,
      });
    },
  });
  const id = await fixture.runtime.createTask({ name, tags: ["queue"] });
  const execution = service.executeTaskById(id);
  const rejected = expect(execution).rejects.toThrow();
  try {
    await initializing;
    controller.abort(new Error("cancel during capture initialization"));
    release();
    await rejected;
    expect(providerCalls).toBe(0);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    release();
    start.mockRestore();
  }
});
