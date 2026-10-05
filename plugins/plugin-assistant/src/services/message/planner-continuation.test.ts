/** Durable task storage with deterministic message execution; no external model or connector acceptance. */
import { randomUUID } from "node:crypto";
import {
  ChannelType,
  type Memory,
  ModelType,
  type PlannerLoopResult,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators.ts";
import { DefaultMessageService } from "../message.ts";
import {
  CANCEL_PLANNER_OPTION,
  checkpointActivePlanner,
  getActivePlannerContinuation,
  PLANNER_CONTINUATION_TASK,
  type PlannerContinuation,
  persistPlannerContinuation,
  RESUME_PLANNER_OPTION,
  registerPlannerContinuationWorker,
} from "./planner-continuation.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let original: Memory;
let result: PlannerLoopResult;
beforeEach(async () => {
  fixture = await createTestRuntime({
    characterName: "PlannerContinuationPersistence",
  });
  fixture.runtime.messageService = new DefaultMessageService();
  const roomId = randomUUID() as UUID;
  await fixture.runtime.ensureConnection({
    entityId: fixture.runtime.agentId,
    roomId,
    worldId: randomUUID() as UUID,
    worldName: "Continuation acceptance",
    name: "Owner",
    userName: "Owner",
    source: "test",
    type: ChannelType.DM,
  });
  original = {
    id: randomUUID() as UUID,
    entityId: fixture.runtime.agentId,
    agentId: fixture.runtime.agentId,
    roomId,
    content: {
      text: "Preserve exact original\n\ncomplete task",
      source: "test",
    },
  };
  result = {
    status: "finished",
    trajectory: {
      context: { id: "test", events: [] },
      steps: [
        {
          iteration: 1,
          toolCall: {
            id: "done",
            name: "WRITE",
            params: { value: "exact\nsource" },
          },
          result: {
            success: true,
            text: "saved",
            effectReceipts: [
              {
                receiptId: "saved-receipt",
                operation: "file.write",
                resource: { kind: "file", id: "one" },
                outcome: "applied",
                commit: {
                  kind: "provider_accepted",
                  id: "one",
                  committedAt: "2026-09-26T00:00:00Z",
                },
                observedAt: "2026-09-26T00:00:00Z",
              },
            ],
          },
        },
      ],
      archivedSteps: [],
      plannedQueue: [{ id: "pending", name: "PUBLISH", params: {} }],
      evaluatorOutputs: [],
    },
    modelUsage: { promptTokens: 101, completionTokens: 4, modelCalls: 2 },
    terminalFailure: {
      kind: "resource_limit",
      transient: false,
      message: "Incomplete",
    },
  };
  await registerPlannerContinuationWorker(fixture.runtime);
  await persistPlannerContinuation(fixture.runtime, original, result, 100);
}, 120_000);
afterEach(async () => {
  vi.restoreAllMocks();
  if (fixture) await fixture.cleanup();
}, 120_000);
async function task() {
  const rows = await fixture.runtime.getTasks({
    roomId: original.roomId,
    agentIds: [fixture.runtime.agentId],
  });
  expect(rows).toHaveLength(1);
  return required(rows[0]);
}

it("rehydrates the existing task, grants budget once, and cancels without discarding receipts", async () => {
  fixture.runtime.unregisterTaskWorker(PLANNER_CONTINUATION_TASK);
  await registerPlannerContinuationWorker(fixture.runtime);
  const worker = required(
    fixture.runtime.getTaskWorker(PLANNER_CONTINUATION_TASK),
  );
  const saved = await task();
  expect(saved.metadata?.plannerContinuation).toMatchObject({
    version: 1,
    phase: "paused",
    original,
    state: { modelUsage: result.modelUsage, trajectory: result.trajectory },
  });
  expect(
    await worker.canExecute?.(fixture.runtime, original, {
      values: {},
      data: {},
      text: "",
    }),
  ).toBe(true);
  await worker.execute(
    fixture.runtime,
    { option: RESUME_PLANNER_OPTION },
    saved,
  );
  await worker.execute(
    fixture.runtime,
    { option: RESUME_PLANNER_OPTION },
    saved,
  );
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "queued",
    authorizedTotalPromptBudget: 200,
    state: { modelUsage: { promptTokens: 101 } },
  });
  await worker.execute(
    fixture.runtime,
    { option: CANCEL_PLANNER_OPTION },
    saved,
  );
  await worker.execute(fixture.runtime, {}, saved);
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "cancelled",
    state: { trajectory: result.trajectory },
  });
});

it("refreshes authorization and refuses a foreign owner before queuing", async () => {
  const worker = required(
    fixture.runtime.getTaskWorker(PLANNER_CONTINUATION_TASK),
  );
  const outsider = { ...original, entityId: randomUUID() as UUID };
  expect(
    await worker.canExecute?.(fixture.runtime, outsider, {
      values: {},
      data: {},
      text: "",
    }),
  ).toBe(false);
  const saved = await task();
  const checkpoint = saved.metadata?.plannerContinuation as Record<
    string,
    unknown
  >;
  await fixture.runtime.updateTask(required(saved.id), {
    entityId: outsider.entityId,
    metadata: {
      ...saved.metadata,
      plannerContinuation: { ...checkpoint, original: outsider },
    },
  });
  await worker.execute(
    fixture.runtime,
    { option: RESUME_PLANNER_OPTION },
    saved,
  );
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "blocked",
    authorizedTotalPromptBudget: 100,
  });
});

it("parks a crash after pre-dispatch checkpoint and never replays it on restart or duplicate resume", async () => {
  const runtime = fixture.runtime;
  const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await worker.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  expect(runtime.messageService).toBeDefined();
  const execute = vi
    .spyOn(required(runtime.messageService), "handleMessage")
    .mockImplementation(async (_runtime, message) => {
      const active = required(getActivePlannerContinuation(runtime, message));
      expect(active.original.id).toBe(original.id);
      expect(active.state.modelUsage.promptTokens).toBe(101);
      await checkpointActivePlanner(
        runtime,
        message,
        active.state,
        "before_tool",
      );
      throw new Error("Synthetic crash at uncertain effect boundary");
    });
  await expect(worker.execute(runtime, {}, await task())).resolves.toEqual({
    preserveTask: true,
  });
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "executing",
  });
  runtime.unregisterTaskWorker(PLANNER_CONTINUATION_TASK);
  await registerPlannerContinuationWorker(runtime);
  const restarted = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await restarted.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  await restarted.execute(runtime, {}, await task());
  expect(execute).toHaveBeenCalledTimes(1);
});

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Required fixture missing");
  return value;
}

it("makes a settled post-tool checkpoint explicitly resumable after re-registration", async () => {
  const runtime = fixture.runtime;
  const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await worker.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  vi.spyOn(
    required(runtime.messageService),
    "handleMessage",
  ).mockImplementation(async (_runtime, message) => {
    const active = required(getActivePlannerContinuation(runtime, message));
    await checkpointActivePlanner(runtime, message, active.state, "after_tool");
    throw new Error("Crash after settlement");
  });
  await expect(worker.execute(runtime, {}, await task())).resolves.toEqual({
    preserveTask: true,
  });
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "running",
  });
  runtime.unregisterTaskWorker(PLANNER_CONTINUATION_TASK);
  await registerPlannerContinuationWorker(runtime);
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "paused",
    state: { modelUsage: { promptTokens: 101 }, trajectory: result.trajectory },
  });
  expect(
    (await task()).metadata?.options?.some(
      (option) => option.name === RESUME_PLANNER_OPTION,
    ),
  ).toBe(true);
});

it("does not resend an unacknowledged delivery after restart or a duplicate resume", async () => {
  const runtime = fixture.runtime;
  const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await worker.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  vi.spyOn(
    required(runtime.messageService),
    "handleMessage",
  ).mockImplementation(async (_runtime, _message, callback) => {
    const content = {
      text: "Completed from settled evidence",
      agentVoiced: true,
    };
    await callback?.(content);
    return {
      outcome: { status: "completed", effects: [] },
      didRespond: true,
      responseContent: content,
      responseMessages: [],
    };
  });
  const send = vi.fn(async () => undefined);
  runtime.registerSendHandler("test", send);
  await worker.execute(runtime, {}, await task());
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "delivery_pending",
    delivery: { acknowledged: false },
  });
  runtime.unregisterTaskWorker(PLANNER_CONTINUATION_TASK);
  await registerPlannerContinuationWorker(runtime);
  const restarted = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await restarted.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  await restarted.execute(runtime, {}, await task());
  expect(send).toHaveBeenCalledTimes(1);
});

it("persists acknowledgments for every guarded output and does not deliver a completed task twice", async () => {
  const runtime = fixture.runtime;
  const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await worker.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  vi.spyOn(
    required(runtime.messageService),
    "handleMessage",
  ).mockImplementation(async (_runtime, _message, callback) => {
    await callback?.({ text: "First complete output", agentVoiced: true });
    await callback?.({ text: "Second complete output", agentVoiced: true });
    return {
      outcome: { status: "completed", effects: [] },
      didRespond: true,
      responseContent: { text: "Must not bypass guarded callback outputs" },
      responseMessages: [],
    };
  });
  let deliveries = 0;
  runtime.registerSendHandler("test", async (_runtime, target, content) => {
    const memory: Memory = {
      id: content.id as UUID,
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: required(target.roomId),
      content,
    };
    await runtime.createMemory(memory, "messages");
    deliveries++;
    return memory;
  });
  await worker.execute(runtime, {}, await task());
  const saved = (await task()).metadata?.plannerContinuation as {
    phase: string;
    deliveries: Array<{ acknowledged: boolean; content: { text: string } }>;
  };
  expect(saved.phase).toBe("delivered");
  expect(
    saved.deliveries.map((entry) => [entry.acknowledged, entry.content.text]),
  ).toEqual([
    [true, "First complete output"],
    [true, "Second complete output"],
  ]);
  await worker.execute(runtime, {}, await task());
  await worker.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  expect(deliveries).toBe(2);
});

it("serializes stale concurrent resume choices without multiplying the budget", async () => {
  const runtime = fixture.runtime;
  const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  const saved = await task();
  const choices = await Promise.allSettled([
    worker.execute(runtime, { option: RESUME_PLANNER_OPTION }, saved),
    worker.execute(runtime, { option: RESUME_PLANNER_OPTION }, saved),
  ]);
  expect(choices.some((choice) => choice.status === "fulfilled")).toBe(true);
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "queued",
    authorizedTotalPromptBudget: 200,
  });
});

it("keeps cancellation terminal when a checkpoint write is in flight", async () => {
  const runtime = fixture.runtime;
  const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await worker.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const realUpdate = runtime.updateTask.bind(runtime);
  let intercept = false;
  vi.spyOn(runtime, "updateTask").mockImplementation(async (id, update) => {
    const snapshot = update.metadata?.plannerContinuation as
      | { phase?: string }
      | undefined;
    if (intercept && snapshot?.phase === "running") {
      intercept = false;
      blocked.resolve();
      await release.promise;
    }
    await realUpdate(id, update);
  });
  vi.spyOn(
    required(runtime.messageService),
    "handleMessage",
  ).mockImplementation(async (_runtime, message) => {
    const active = required(getActivePlannerContinuation(runtime, message));
    await checkpointActivePlanner(
      runtime,
      message,
      active.state,
      "before_tool",
    );
    intercept = true;
    await checkpointActivePlanner(runtime, message, active.state, "after_tool");
    throw new Error("End synthetic in-flight turn");
  });
  const execution = worker
    .execute(runtime, {}, await task())
    .catch(() => undefined);
  await blocked.promise;
  const cancellation = worker.execute(
    runtime,
    { option: CANCEL_PLANNER_OPTION },
    await task(),
  );
  release.resolve();
  await Promise.all([execution, cancellation]);
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "cancelled",
  });
  await worker.execute(runtime, {}, await task());
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "cancelled",
  });
});

it("retains ambiguous execution evidence when the actual task scheduler handles a worker failure", async () => {
  const runtime = fixture.runtime;
  const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await worker.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  const execute = vi
    .spyOn(required(runtime.messageService), "handleMessage")
    .mockImplementation(async (_runtime, message) => {
      const active = required(getActivePlannerContinuation(runtime, message));
      await checkpointActivePlanner(
        runtime,
        message,
        active.state,
        "before_tool",
      );
      throw new Error("Synthetic transport failure after possible effect");
    });
  const scheduler = new TaskService(runtime);
  const taskId = required((await task()).id);
  await scheduler.executeTaskById(taskId);
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "executing",
    failure: { code: "PLANNER_CONTINUATION_EXECUTION_FAILED" },
    state: { trajectory: result.trajectory },
  });
  await scheduler.executeTaskById(taskId);
  expect(execute).toHaveBeenCalledTimes(1);
  const parked = await task();
  expect(parked.tags).toContain("AWAITING_CHOICE");
  expect(parked.metadata?.options).toEqual([
    expect.objectContaining({ name: CANCEL_PLANNER_OPTION }),
  ]);
  await worker.execute(runtime, { option: CANCEL_PLANNER_OPTION }, parked);
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "cancelled",
    state: { trajectory: result.trajectory },
  });
});

it("parks an executing checkpoint orphaned by a restart with a cancel choice, never replaying it", async () => {
  const runtime = fixture.runtime;
  const saved = await task();
  const checkpoint = saved.metadata?.plannerContinuation as Record<
    string,
    unknown
  >;
  await runtime.updateTask(required(saved.id), {
    metadata: {
      ...saved.metadata,
      plannerContinuation: { ...checkpoint, phase: "executing" },
    },
  });
  const execute = vi.spyOn(required(runtime.messageService), "handleMessage");
  runtime.unregisterTaskWorker(PLANNER_CONTINUATION_TASK);
  await registerPlannerContinuationWorker(runtime);
  const parked = await task();
  expect(parked.metadata?.plannerContinuation).toMatchObject({
    phase: "executing",
    failure: { code: "PLANNER_CONTINUATION_INTERRUPTED" },
  });
  expect(parked.tags).toContain("AWAITING_CHOICE");
  const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await worker.execute(runtime, {}, parked);
  expect(execute).not.toHaveBeenCalled();
});

it("refuses stale queued admission after another invocation settles and releases its lock", async () => {
  const runtime = fixture.runtime;
  const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
  await worker.execute(
    runtime,
    { option: RESUME_PLANNER_OPTION },
    await task(),
  );
  const queued = await task();
  const captured = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const getTask = runtime.getTask.bind(runtime);
  let delayFirstRead = true;
  vi.spyOn(runtime, "getTask").mockImplementation(async (id) => {
    const snapshot = await getTask(id);
    if (delayFirstRead) {
      delayFirstRead = false;
      captured.resolve();
      await release.promise;
    }
    return snapshot;
  });
  const execute = vi
    .spyOn(required(runtime.messageService), "handleMessage")
    .mockImplementation(async (_runtime, message) => {
      const active = required(getActivePlannerContinuation(runtime, message));
      await checkpointActivePlanner(
        runtime,
        message,
        active.state,
        "before_tool",
      );
      throw new Error("Park uncertain execution");
    });
  const stale = worker.execute(runtime, {}, queued);
  await captured.promise;
  await worker.execute(runtime, {}, queued);
  release.resolve();
  await stale;
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await task()).metadata?.plannerContinuation).toMatchObject({
    phase: "executing",
    attempt: 1,
  });
});

it.each([true, false])(
  "reloads checkpoint domains through current authorization (available=%s)",
  async (available) => {
    const runtime = fixture.runtime;
    for (const field of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
      runtime.registerResponseHandlerFieldEvaluator(field);
    }
    runtime.actions.length = 0;
    runtime.providers.length = 0;
    runtime.evaluators.length = 0;
    runtime.contexts.registerMany([
      { id: "simple" },
      { id: "general" },
      { id: "files" },
    ]);
    const effect = vi.fn(async () => ({ success: true }));
    runtime.registerAction({
      name: "RESUME_READ",
      description: "Read the pending artifact",
      contexts: ["files"],
      contextGate: { contexts: ["files"] },
      validate: async () => available,
      handler: effect,
    });
    const saved = await task();
    const checkpoint = saved.metadata
      ?.plannerContinuation as PlannerContinuation;
    const userId = randomUUID() as UUID;
    const room = required(await runtime.getRoom(original.roomId));
    const world = required(await runtime.getWorld(required(room.worldId)));
    await runtime.updateWorld({
      ...world,
      metadata: {
        ...world.metadata,
        roles: { [userId]: "OWNER" },
        roleSources: { [userId]: "manual" },
      },
    });
    await runtime.ensureConnection({
      entityId: userId,
      roomId: original.roomId,
      worldId: world.id,
      name: "Resume owner",
      source: "test",
      type: ChannelType.DM,
    });
    checkpoint.original.entityId = userId;
    for (const step of checkpoint.state.trajectory.steps) {
      for (const receipt of step.result?.effectReceipts ?? []) {
        Object.assign(receipt, {
          artifacts: [],
          idempotency: { key: null, replayed: false },
        });
      }
    }
    const preservedSteps = structuredClone(checkpoint.state.trajectory.steps);
    checkpoint.state.trajectory.context.trajectoryPrefix = {
      selectedContexts: ["files"],
    };
    checkpoint.state.trajectory.outcomeIntents = ["Read the pending artifact"];
    // An old serialized tool must not become an executable capability on resume.
    checkpoint.state.trajectory.context.trajectoryPrefix.expandedTools = [
      { name: "STALE_WRITE", description: "Previously available mutation" },
    ];
    await runtime.updateTask(required(saved.id), {
      entityId: userId,
      metadata: { ...saved.metadata, plannerContinuation: checkpoint },
    });
    const plannerSurfaces: string[][] = [];
    const errors = vi.spyOn(runtime, "reportError");
    for (const type of [
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
      ModelType.TEXT_SMALL,
      ModelType.TEXT_LARGE,
    ]) {
      runtime.registerModel(
        type,
        async () => {
          throw new Error("Unexpected unstubbed model");
        },
        "continuation-test",
        100,
      );
    }
    const execution = vi.spyOn(
      required(runtime.messageService),
      "handleMessage",
    );
    const model = vi
      .spyOn(runtime, "useModel")
      .mockImplementation(async (type, params) => {
        if (type === ModelType.RESPONSE_HANDLER)
          return {
            text: "",
            toolCalls: [
              {
                id: "route",
                name: "HANDLE_RESPONSE",
                arguments: {
                  shouldRespond: "RESPOND",
                  contexts: ["simple"],
                  intents: [],
                  replyText: "Ready.",
                  replyEffectStatus: "none",
                  facts: [],
                  relationships: [],
                  addressedTo: [],
                  emotion: "none",
                },
              },
            ],
            finishReason: "tool-calls",
          };
        if (type === ModelType.ACTION_PLANNER) {
          const request = params as { tools?: Array<{ name: string }> };
          plannerSurfaces.push((request.tools ?? []).map((tool) => tool.name));
          return {
            text: "",
            toolCalls: [{ id: "stop", name: "STOP", arguments: {} }],
            finishReason: "tool-calls",
          };
        }
        throw new Error(`Unexpected model request: ${String(type)}`);
      });
    const worker = required(runtime.getTaskWorker(PLANNER_CONTINUATION_TASK));
    await worker.execute(
      runtime,
      { option: RESUME_PLANNER_OPTION },
      await task(),
    );
    await worker.execute(runtime, {}, await task());
    expect(
      model,
      JSON.stringify(await execution.mock.results[0]?.value),
    ).toHaveBeenCalled();
    expect(
      plannerSurfaces,
      JSON.stringify({
        outcome: await execution.mock.results[0]?.value,
        calls: model.mock.calls.map(([type]) => type),
        errors: errors.mock.calls.map(([scope, error]) => [
          scope,
          String(error),
        ]),
      }),
    ).toHaveLength(1);
    expect(plannerSurfaces[0].includes("RESUME_READ")).toBe(available);
    expect(plannerSurfaces[0]).not.toContain("STALE_WRITE");
    expect(effect).not.toHaveBeenCalled();
    const output = await execution.mock.results[0]?.value;
    expect(output?.outcome?.status).not.toBe("failed");
    expect(output?.outcome?.error).toBeUndefined();
    expect((await task()).metadata?.plannerContinuation).toMatchObject({
      state: {
        trajectory: {
          steps: expect.arrayContaining(preservedSteps),
        },
      },
    });
  },
);
