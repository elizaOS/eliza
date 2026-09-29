/** Real task execution and PGlite trajectory persistence; no model provider calls. */
import { randomUUID } from "node:crypto";
import { trajectoriesPlugin } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PseudonymSession } from "../../core/src/security/pii-pseudonymizer.ts";
import { SecretSwapSession } from "../../core/src/security/secret-swap.ts";
import { TaskService } from "../../core/src/services/task.ts";
import {
  getTrajectoryContext,
  runWithTrajectoryContext,
  runWithTrajectoryPurpose,
} from "../../core/src/trajectory-context.ts";
import {
  logActiveTrajectoryLlmCall,
  withStandaloneTrajectory,
} from "../../core/src/trajectory-utils.ts";
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
        trajectoryId = getTrajectoryContext()?.trajectoryId;
        await runWithTrajectoryPurpose("reminder_dispatch", () => {
          expect(
            logActiveTrajectoryLlmCall(fixture.runtime, {
              model: "fixture-no-inference",
              purpose: "provider_default",
              actionType: "runtime.useModel",
              systemPrompt: "Complete synthetic task instructions",
              userPrompt: prompt,
              response,
              promptTokens: 13,
              completionTokens: 7,
            }),
          ).toBe(true);
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

it("records one empty parent and step per enabled no-model execution without retrying", async () => {
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
  await service.executeTaskById(taskId);
  await service.executeTaskById(taskId);
  expect(owners).toHaveLength(2);
  expect(new Set(owners).size).toBe(2);
  expect((await reader.listTrajectories({})).total).toBe(before.total + 2);
  for (const owner of owners) {
    const detail = await reader.getTrajectoryDetail(owner);
    expect(detail?.status).toBe("completed");
    expect(detail?.steps).toHaveLength(1);
    expect(detail?.steps?.flatMap((step) => step.llmCalls ?? [])).toEqual([]);
  }
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
      expect(
        logActiveTrajectoryLlmCall(fixture.runtime, {
          model: "fixture-no-inference",
          purpose: "reminder_dispatch",
          actionType: "runtime.useModel",
          systemPrompt: prepared,
          userPrompt: prepared,
          response: prepared,
        }),
      ).toBe(true);
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
