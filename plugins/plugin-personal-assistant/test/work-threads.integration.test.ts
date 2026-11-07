/**
 * Integration coverage for LifeOps work threads: routing, guarding, follow-up, and
 * active-thread capping, plus multi-user/multi-channel thread-boundary enforcement with
 * current-channel merge. Real scheduler over a mocked runtime.
 */
import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  ResponseHandlerFieldContext,
  ResponseHandlerResult,
  Service,
  State,
} from "@elizaos/core";
import {
  AgentEventService,
  ChannelType,
  ModelType,
  runWithActionRoutingContext,
  setEntityRole,
  stringToUuid,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workThreadAction } from "../src/actions/work-thread.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";
import { registerLifeOpsScheduledTaskRunnerDeps } from "../src/lifeops/scheduled-task/runtime-wiring.js";
import { processDueScheduledTasks } from "../src/lifeops/scheduled-task/scheduler.ts";
import {
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "../src/lifeops/scheduled-task/service.js";
import { executeRawSql, sqlQuote } from "../src/lifeops/sql.js";
import {
  type ThreadOp,
  threadOpsFieldEvaluator,
} from "../src/lifeops/work-threads/field-evaluator-thread-ops.ts";
import { createWorkThreadStore } from "../src/lifeops/work-threads/store.ts";
import { workThreadsProvider } from "../src/providers/work-threads.ts";
import { createMockedTestRuntime } from "./support/helpers/mock-runtime.ts";

let cleanupRuntime: (() => Promise<void>) | undefined;

// Runs once after the scheduler's first thread read returns "active", before
// the claim, so a thread change can land exactly in that window.
let afterThreadCheck: (() => Promise<void>) | null = null;
vi.mock(
  "../src/lifeops/work-threads/followup-thread-check.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/lifeops/work-threads/followup-thread-check.ts")
      >();
    const workThreadFollowupInactiveReason: typeof actual.workThreadFollowupInactiveReason =
      async (runtime, task) => {
        const reason = await actual.workThreadFollowupInactiveReason(
          runtime,
          task,
        );
        const hook = afterThreadCheck;
        if (hook && reason === null) await hook();
        return reason;
      };
    return { ...actual, workThreadFollowupInactiveReason };
  },
);

vi.setConfig({ testTimeout: 120_000 });

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupRuntime?.();
  cleanupRuntime = undefined;
});

async function createRuntime(): Promise<IAgentRuntime> {
  const mocked = await createMockedTestRuntime({
    envs: [],
    seedGoogle: false,
    seedX: false,
    seedBenchmarkFixtures: false,
    withLLM: false,
  });
  cleanupRuntime = mocked.cleanup;
  // Production loads the scheduling service; this minimal fixture must too.
  await mocked.runtime.registerService(AgentEventService);
  await mocked.runtime.getServiceLoadPromise(AgentEventService.serviceType);
  registerLifeOpsScheduledTaskRunnerDeps(mocked.runtime);
  await mocked.runtime.registerService(ScheduledTaskRunnerService);
  await mocked.runtime.getServiceLoadPromise(
    ScheduledTaskRunnerService.serviceType,
  );
  return mocked.runtime;
}

function message(
  runtime: IAgentRuntime,
  roomId: string,
  text: string,
  options: {
    entityId?: string;
    source?: string;
    channelType?: string;
    groupName?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Memory {
  const source = options.source ?? "test";
  return {
    id: `${roomId}:message:${Math.random().toString(36).slice(2)}` as Memory["id"],
    entityId: (options.entityId ?? runtime.agentId) as Memory["entityId"],
    roomId: roomId as Memory["roomId"],
    agentId: runtime.agentId,
    content: {
      text,
      source,
      channelType: options.channelType ?? "dm",
    },
    metadata: {
      provider: source,
      group: { name: options.groupName ?? roomId },
      ...options.metadata,
    },
    createdAt: Date.now(),
  } as Memory;
}

async function connectParticipant(args: {
  runtime: IAgentRuntime;
  worldId: string;
  roomId: string;
  entityId: string;
  source: string;
  name: string;
  channelType?: string;
}): Promise<void> {
  await args.runtime.ensureConnection({
    entityId: args.entityId as never,
    roomId: args.roomId as never,
    worldId: args.worldId as never,
    worldName: "LifeOps Test World",
    userName: args.name,
    name: args.name,
    source: args.source,
    type: args.channelType ?? ChannelType.GROUP,
    channelId: args.roomId,
  });
}

async function grantWorldRole(
  runtime: IAgentRuntime,
  roomId: string,
  entityId: string,
  role: "OWNER" | "USER",
): Promise<void> {
  await setEntityRole(
    runtime,
    message(runtime, roomId, "seed role", { entityId }),
    entityId,
    role,
  );
}

async function runThreadAction(
  runtime: IAgentRuntime,
  msg: Memory,
  operations: unknown[],
): Promise<ActionResult> {
  const result = await workThreadAction.handler?.(
    runtime,
    msg,
    { values: {}, data: {}, text: "" } as State,
    { parameters: { operations } } as HandlerOptions,
    undefined,
  );
  if (!result || typeof result !== "object" || !("success" in result)) {
    throw new Error("workThreadAction returned a non-ActionResult");
  }
  return result as ActionResult;
}

function operationResults(
  result: ActionResult,
): Array<Record<string, unknown>> {
  const operations = result.data?.operations;
  if (!Array.isArray(operations)) {
    throw new Error("expected thread operation results");
  }
  return operations as Array<Record<string, unknown>>;
}

function fieldContext(
  runtime: IAgentRuntime,
  msg: Memory,
): ResponseHandlerFieldContext {
  return {
    runtime,
    message: msg,
    state: { values: {}, data: {}, text: "" } as State,
    senderRole: "OWNER",
    turnSignal: new AbortController().signal,
  };
}

function responseHandlerResult(): ResponseHandlerResult {
  return {
    shouldRespond: "RESPOND",
    contexts: [],
    intents: [],
    candidateActionNames: [],
    replyText: "",
    facts: [],
    relationships: [],
    addressedTo: [],
  };
}

async function applyThreadOpsField(
  runtime: IAgentRuntime,
  msg: Memory,
  ops: ThreadOp[],
): Promise<ResponseHandlerResult> {
  const parsed = responseHandlerResult();
  parsed.threadOps = ops;
  const effect = await threadOpsFieldEvaluator.handle?.({
    ...fieldContext(runtime, msg),
    value: ops,
    parsed,
  });
  effect?.mutateResult?.(parsed);
  return parsed;
}

describe("LifeOps work threads", () => {
  it.each([false, true, "remove fails", "remove unavailable"])(
    "links one follow-up or removes it after exhausted owner conflicts (%s)",
    async (exhaust) => {
      const runtime = await createRuntime();
      const store = createWorkThreadStore(runtime);
      const roomId = stringToUuid("followup-conflict-room");
      const thread = await store.create({
        title: "Check report",
        summary: "Original summary",
        primarySourceRef: { connector: "test", roomId, canMutate: true },
      });
      const original = LifeOpsRepository.prototype.upsertWorkThread;
      let conflicts = 0;
      vi.spyOn(
        LifeOpsRepository.prototype,
        "upsertWorkThread",
      ).mockImplementation(async function (
        this: LifeOpsRepository,
        agentId,
        next,
        options,
      ) {
        if (
          next.id === thread.id &&
          next.currentScheduledTaskId &&
          (exhaust || conflicts === 0)
        ) {
          conflicts++;
          const current = await store.get(thread.id);
          if (!current) throw new Error("Fixture thread disappeared");
          await original.call(
            this,
            agentId,
            {
              ...current,
              summary: `Owner edit ${conflicts}`,
              version: current.version + 1,
            },
            { expectedVersion: current.version },
          );
        }
        return original.call(this, agentId, next, options);
      });
      const runner = getScheduledTaskRunner(runtime, {
        agentId: runtime.agentId,
      });
      if (exhaust === "remove fails")
        vi.spyOn(runner, "remove").mockResolvedValue(false);
      if (exhaust === "remove unavailable")
        Object.defineProperty(runner, "remove", {
          value: undefined,
          configurable: true,
        });
      const action = runThreadAction(
        runtime,
        message(runtime, roomId, "Follow up on the report"),
        [
          {
            type: "schedule_followup",
            workThreadId: thread.id,
            instruction: "Check the report",
            trigger: { kind: "manual" },
          },
        ],
      );
      if (typeof exhaust === "string")
        await expect(action).rejects.toMatchObject({
          code: "WORK_THREAD_FOLLOWUP_RECONCILIATION_REQUIRED",
          context: { workThreadId: thread.id },
          cause: expect.objectContaining({
            errors: expect.arrayContaining([
              expect.objectContaining({
                code: "WORK_THREAD_FOLLOWUP_REMOVE_UNCONFIRMED",
              }),
            ]),
          }),
        });
      else if (exhaust) await expect(action).rejects.toThrow();
      else expect((await action).success).toBe(true);
      const tasks = await getScheduledTaskRunner(runtime, {
        agentId: runtime.agentId,
      }).list({ kind: "followup" });
      const final = await store.get(thread.id);
      expect(final?.summary).toBe(`Owner edit ${conflicts}`);
      if (exhaust) {
        expect(tasks).toHaveLength(typeof exhaust === "string" ? 1 : 0);
        expect(final?.currentScheduledTaskId ?? null).toBeNull();
        expect(conflicts).toBe(3);
      } else {
        expect(tasks).toHaveLength(1);
        expect(final?.currentScheduledTaskId).toBe(tasks[0].taskId);
        expect(conflicts).toBe(1);
      }
    },
  );

  it.each(["mark_waiting", "mark_completed"] as const)(
    "does not overwrite an owner stop with a stale %s request",
    async (type) => {
      const runtime = await createRuntime();
      const store = createWorkThreadStore(runtime);
      const roomId = stringToUuid("status-owner-stop-race");
      const thread = await store.create({
        title: "Check report",
        summary: "Report",
        primarySourceRef: { connector: "test", roomId, canMutate: true },
      });
      const originalGet = LifeOpsRepository.prototype.getWorkThread;
      let changed = false;
      vi.spyOn(LifeOpsRepository.prototype, "getWorkThread").mockImplementation(
        async function (this: LifeOpsRepository, agentId, id) {
          const snapshot = await originalGet.call(this, agentId, id);
          if (id === thread.id && snapshot && !changed) {
            changed = true;
            await this.upsertWorkThread(
              agentId,
              {
                ...snapshot,
                status: "stopped",
                version: snapshot.version + 1,
              },
              { expectedVersion: snapshot.version },
            );
          }
          return snapshot;
        },
      );
      await expect(
        runThreadAction(runtime, message(runtime, roomId, "Update thread"), [
          { type, workThreadId: thread.id },
        ]),
      ).rejects.toMatchObject({ code: "WORK_THREAD_NOT_ACTIVE" });
      expect(await store.get(thread.id)).toMatchObject({
        status: "stopped",
        version: thread.version + 1,
      });
    },
  );

  it("keeps an already linked follow-up when its event write fails", async () => {
    const runtime = await createRuntime();
    const store = createWorkThreadStore(runtime);
    const roomId = stringToUuid("followup-event-failure");
    const thread = await store.create({
      title: "Check report",
      summary: "Report",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    const original = LifeOpsRepository.prototype.appendWorkThreadEvent;
    vi.spyOn(
      LifeOpsRepository.prototype,
      "appendWorkThreadEvent",
    ).mockImplementation(async function (this: LifeOpsRepository, event) {
      if (
        event.workThreadId === thread.id &&
        event.type === "followup_scheduled"
      )
        throw new Error("event write failed");
      return original.call(this, event);
    });
    await expect(
      runThreadAction(runtime, message(runtime, roomId, "Follow up"), [
        {
          type: "schedule_followup",
          workThreadId: thread.id,
          instruction: "Check report",
          trigger: { kind: "manual" },
        },
      ]),
    ).rejects.toThrow("event write failed");
    const tasks = await getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    }).list({ kind: "followup" });
    expect(tasks).toHaveLength(1);
    expect((await store.get(thread.id))?.currentScheduledTaskId).toBe(
      tasks[0].taskId,
    );
  });

  it.each(["stopped", "deleted"])(
    "does not link a follow-up after the owner %s the thread",
    async (change) => {
      const runtime = await createRuntime();
      const store = createWorkThreadStore(runtime);
      const roomId = stringToUuid("followup-owner-terminal");
      const thread = await store.create({
        title: "Check report",
        summary: "Report",
        primarySourceRef: { connector: "test", roomId, canMutate: true },
      });
      const original = LifeOpsRepository.prototype.upsertWorkThread;
      let changed = false;
      vi.spyOn(
        LifeOpsRepository.prototype,
        "upsertWorkThread",
      ).mockImplementation(async function (
        this: LifeOpsRepository,
        agentId,
        next,
        options,
      ) {
        if (next.id === thread.id && next.currentScheduledTaskId && !changed) {
          changed = true;
          if (change === "deleted")
            await executeRawSql(
              runtime,
              `DELETE FROM app_lifeops.life_work_threads WHERE id = ${sqlQuote(thread.id)} AND agent_id = ${sqlQuote(runtime.agentId)}`,
            );
          else
            await original.call(
              this,
              agentId,
              { ...thread, status: "stopped", version: thread.version + 1 },
              { expectedVersion: thread.version },
            );
        }
        return original.call(this, agentId, next, options);
      });
      await expect(
        runThreadAction(runtime, message(runtime, roomId, "Follow up"), [
          {
            type: "schedule_followup",
            workThreadId: thread.id,
            instruction: "Check report",
            trigger: { kind: "manual" },
          },
        ]),
      ).rejects.toMatchObject({
        code:
          change === "deleted"
            ? "WORK_THREAD_NOT_FOUND"
            : "WORK_THREAD_NOT_ACTIVE",
      });
      expect(
        await getScheduledTaskRunner(runtime, {
          agentId: runtime.agentId,
        }).list({ kind: "followup" }),
      ).toHaveLength(0);
      if (change === "deleted") expect(await store.get(thread.id)).toBeNull();
      else
        expect(await store.get(thread.id)).toMatchObject({
          status: "stopped",
          currentScheduledTaskId: null,
        });
    },
  );

  it("preserves an owner summary when a steer retries its version conflict", async () => {
    const runtime = await createRuntime();
    const store = createWorkThreadStore(runtime);
    const roomId = stringToUuid("steer-conflict-room");
    const thread = await store.create({
      title: "Check report",
      summary: "Original summary",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    const original = LifeOpsRepository.prototype.upsertWorkThread;
    let conflicts = 0;
    vi.spyOn(
      LifeOpsRepository.prototype,
      "upsertWorkThread",
    ).mockImplementation(async function (
      this: LifeOpsRepository,
      agentId,
      next,
      options,
    ) {
      if (next.id === thread.id && conflicts === 0) {
        conflicts++;
        const current = await store.get(thread.id);
        if (!current) throw new Error("Fixture thread disappeared");
        await original.call(
          this,
          agentId,
          {
            ...current,
            summary: "Owner revised summary",
            version: current.version + 1,
          },
          { expectedVersion: current.version },
        );
      }
      return original.call(this, agentId, next, options);
    });
    const result = await runThreadAction(
      runtime,
      message(runtime, roomId, "Update the plan"),
      [
        {
          type: "steer",
          workThreadId: thread.id,
          instruction: "Use the revised plan",
        },
      ],
    );
    expect(result.success).toBe(true);
    expect(await store.get(thread.id)).toMatchObject({
      summary: "Owner revised summary",
      currentPlanSummary: "Use the revised plan",
      version: 3,
    });
  });

  it.each([undefined, "Explicit merged summary"])(
    "retries a merge after an owner edit with summary %s",
    async (summary) => {
      const runtime = await createRuntime();
      const store = createWorkThreadStore(runtime);
      const roomId = stringToUuid("merge-retry-room");
      const ref = { connector: "test", roomId, canMutate: true };
      const target = await store.create({
        title: "Prepare report",
        summary: "Original target",
        currentPlanSummary: "Original plan",
        primarySourceRef: ref,
      });
      const source = await store.create({
        title: "Collect notes",
        summary: "Source notes",
        primarySourceRef: ref,
      });
      const originalMerge = LifeOpsRepository.prototype.mergeWorkThreadsAtomic;
      const versions: number[] = [];
      vi.spyOn(
        LifeOpsRepository.prototype,
        "mergeWorkThreadsAtomic",
      ).mockImplementation(async function (this: LifeOpsRepository, input) {
        versions.push(input.target.version);
        if (versions.length === 1) {
          // Represent a writer outside the action's process-local lock.
          // The original SQL transaction still produces the real conflict.
          await store.update(target.id, {
            summary: "Owner edited summary",
            currentPlanSummary: "Owner edited plan",
            eventType: "steered",
          });
        }
        return originalMerge.call(this, input);
      });
      const result = await runThreadAction(
        runtime,
        message(runtime, roomId, "Merge the notes into the report"),
        [
          {
            type: "merge",
            workThreadId: target.id,
            sourceWorkThreadIds: [source.id],
            ...(summary === undefined ? {} : { summary }),
          },
        ],
      );
      expect(result.success).toBe(true);
      expect(versions).toEqual([1, 2]);
      expect(await store.get(target.id)).toMatchObject({
        summary: summary ?? "Owner edited summary",
        currentPlanSummary: "Owner edited plan",
        version: 3,
        metadata: { mergedFromWorkThreadIds: [source.id] },
      });
      expect(await store.get(source.id)).toMatchObject({
        status: "stopped",
        version: 2,
        metadata: { mergedIntoWorkThreadId: target.id },
      });
      const repo = new LifeOpsRepository(runtime);
      const targetEvents = await repo.listWorkThreadEvents({
        agentId: runtime.agentId,
        workThreadId: target.id,
      });
      const sourceEvents = await repo.listWorkThreadEvents({
        agentId: runtime.agentId,
        workThreadId: source.id,
      });
      expect(targetEvents.filter((e) => e.type === "steered")).toHaveLength(1);
      expect(targetEvents.filter((e) => e.type === "merged")).toHaveLength(1);
      expect(sourceEvents.filter((e) => e.type === "merged_into")).toHaveLength(
        1,
      );
    },
  );
  it("defers only the owning message's reply while retaining complete durable results", async () => {
    const runtime = await createRuntime();
    for (const owner of ["direct", "planner", "other-message"] as const) {
      const msg = message(
        runtime,
        "reply-owner-room",
        "Record a QA thread only",
      );
      const callback = vi.fn(async () => []);
      const result = await runWithActionRoutingContext(
        {
          actionName: "WORK_THREAD",
          modelClass: undefined,
          ...(owner === "direct" ? {} : { replyOwner: "planner" as const }),
          messageId: owner === "other-message" ? "different-message" : msg.id,
        },
        () =>
          workThreadAction.handler?.(
            runtime,
            msg,
            { values: {}, data: {}, text: "" } as State,
            {
              parameters: {
                operations: [
                  {
                    type: "create",
                    title: `QA ${owner}`,
                    instruction: "Record only",
                  },
                ],
              },
            } as HandlerOptions,
            callback,
          ),
      );
      expect(result).toMatchObject({
        success: true,
        data: { operations: [{ type: "create", success: true }] },
      });
      const created = operationResults(result as ActionResult)[0];
      expect(
        await createWorkThreadStore(runtime).get(
          created.workThreadId as string,
        ),
      ).toMatchObject({
        title: `QA ${owner}`,
        currentPlanSummary: "Record only",
      });
      if (owner === "planner") {
        expect(callback).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          transcriptVisibility: "internal",
          modelReplyRequired: true,
          turnComplete: false,
        });
      } else {
        expect(callback).toHaveBeenCalledOnce();
        expect(result).not.toHaveProperty("transcriptVisibility");
      }
    }
  });

  it("routes, guards, follows up, and caps active thread work", async () => {
    const runtime = await createRuntime();
    const notifications: unknown[] = [];
    const sink = {
      serviceType: "notification",
      capabilityDescription: "Synthetic test notification sink",
      async notify(input: unknown) {
        notifications.push(input);
        return { id: `test-followup-${notifications.length}` };
      },
      async stop() {},
    };
    runtime.services.set("notification", [sink as unknown as Service]);
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "Which visa document is next?",
      "test-followup-render",
    );
    const idleRoom = message(runtime, "room-idle", "hello there");
    expect(await workThreadAction.validate?.(runtime, idleRoom)).toBe(false);
    expect(
      await threadOpsFieldEvaluator.shouldRun?.(
        fieldContext(runtime, idleRoom),
      ),
    ).toBe(false);
    const idleProviderResult = await workThreadsProvider.get(
      runtime,
      idleRoom,
      { values: {}, data: {}, text: "" } as State,
    );
    expect(idleProviderResult.values?.workThreadCount).toBe(0);

    const roomA = message(runtime, "room-a", "start a thread for this work");
    const roomB = message(runtime, "room-b", "continue this thread over here");
    expect(await workThreadAction.validate?.(runtime, roomA)).toBe(true);

    const created = await runThreadAction(runtime, roomA, [
      {
        type: "create",
        title: "Visa renewal",
        summary: "Track the renewal work.",
        instruction: "Keep the renewal moving.",
      },
    ]);
    expect(created.success).toBe(true);
    const threadId = operationResults(created)[0].workThreadId as string;
    expect(threadId).toBeTruthy();

    const providerResult = await workThreadsProvider.get(runtime, roomA, {
      values: {},
      data: {},
      text: "",
    } as State);
    expect(providerResult.values?.workThreadCount).toBe(1);
    expect(providerResult.text).toContain(threadId);
    expect(providerResult.text).toContain("mutable-current-channel");

    expect(
      await threadOpsFieldEvaluator.shouldRun?.(fieldContext(runtime, roomA)),
    ).toBe(true);
    const staged = await applyThreadOpsField(runtime, roomA, [
      {
        type: "steer",
        workThreadId: threadId,
        instruction: "Keep the renewal moving.",
      },
    ]);
    expect(staged.candidateActionNames).toContain("work_thread");
    expect(staged.contexts).toEqual(
      expect.arrayContaining(["tasks", "messaging", "automation"]),
    );

    const crossChannelSteer = await runThreadAction(runtime, roomB, [
      {
        type: "steer",
        workThreadId: threadId,
        instruction: "Move this from room B.",
      },
    ]);
    expect(crossChannelSteer.success).toBe(false);
    expect(operationResults(crossChannelSteer)[0].error).toBe(
      "CROSS_CHANNEL_READ_ONLY",
    );

    const forgedAttach = await runThreadAction(runtime, roomB, [
      {
        type: "attach_source",
        workThreadId: threadId,
        sourceRef: { connector: "test", roomId: "room-c", canMutate: true },
      },
    ]);
    expect(forgedAttach.success).toBe(false);
    expect(operationResults(forgedAttach)[0].error).toBe(
      "SOURCE_REF_NOT_CURRENT_CHANNEL",
    );

    // The current room as a read-only source is refused by its own code, so
    // the planner is not told that the room is wrong.
    const readOnlyAttach = await runThreadAction(runtime, roomB, [
      {
        type: "attach_source",
        workThreadId: threadId,
        sourceRef: {
          connector: "test",
          roomId: roomB.roomId,
          canMutate: false,
        },
      },
    ]);
    expect(readOnlyAttach.success).toBe(false);
    expect(operationResults(readOnlyAttach)[0].error).toBe(
      "SOURCE_REF_READ_ONLY_NOT_SUPPORTED",
    );

    const attached = await runThreadAction(runtime, roomB, [
      { type: "attach_source", workThreadId: threadId },
    ]);
    expect(attached.success).toBe(true);

    const steered = await runThreadAction(runtime, roomB, [
      {
        type: "steer",
        workThreadId: threadId,
        instruction: "Continue the renewal from room B.",
      },
    ]);
    expect(steered.success).toBe(true);
    const store = createWorkThreadStore(runtime);
    const updated = await store.get(threadId);
    expect(updated?.currentPlanSummary).toBe(
      "Continue the renewal from room B.",
    );

    const noisyThreadIds: string[] = [];
    const noiseRoom = message(runtime, "room-noise", "start a thread");
    for (let i = 0; i < 8; i += 1) {
      const noisy = await runThreadAction(runtime, noiseRoom, [
        {
          type: "create",
          title: `Noisy channel ${i}`,
          summary: "More recent work from another channel.",
        },
      ]);
      expect(noisy.success).toBe(true);
      noisyThreadIds.push(operationResults(noisy)[0].workThreadId as string);
    }
    expect(await workThreadAction.validate?.(runtime, roomA)).toBe(true);
    expect(
      await threadOpsFieldEvaluator.shouldRun?.(fieldContext(runtime, roomA)),
    ).toBe(true);
    const providerWithNoise = await workThreadsProvider.get(runtime, roomA, {
      values: {},
      data: {},
      text: "",
    } as State);
    expect(providerWithNoise.text).toContain(threadId);
    for (const noisyThreadId of noisyThreadIds) {
      const stoppedNoise = await runThreadAction(runtime, noiseRoom, [
        { type: "stop", workThreadId: noisyThreadId },
      ]);
      expect(stoppedNoise.success).toBe(true);
    }

    const mergeSource = await runThreadAction(runtime, roomA, [
      {
        type: "create",
        title: "Merge source",
        summary: "Source with refs in two rooms.",
      },
    ]);
    const mergeSourceId = operationResults(mergeSource)[0]
      .workThreadId as string;
    const attachedMergeSource = await runThreadAction(runtime, roomB, [
      { type: "attach_source", workThreadId: mergeSourceId },
    ]);
    expect(attachedMergeSource.success).toBe(true);
    const mergeTargetA = await runThreadAction(runtime, roomA, [
      {
        type: "create",
        title: "Merge target A",
        summary: "Competing merge target A.",
      },
    ]);
    const mergeTargetAId = operationResults(mergeTargetA)[0]
      .workThreadId as string;
    const mergeTargetB = await runThreadAction(runtime, roomB, [
      {
        type: "create",
        title: "Merge target B",
        summary: "Competing merge target B.",
      },
    ]);
    const mergeTargetBId = operationResults(mergeTargetB)[0]
      .workThreadId as string;
    const competingMerges = await Promise.all([
      runThreadAction(runtime, roomA, [
        {
          type: "merge",
          workThreadId: mergeTargetAId,
          sourceWorkThreadIds: [mergeSourceId],
          instruction: "Merge source into target A.",
        },
      ]),
      runThreadAction(runtime, roomB, [
        {
          type: "merge",
          workThreadId: mergeTargetBId,
          sourceWorkThreadIds: [mergeSourceId],
          instruction: "Merge source into target B.",
        },
      ]),
    ]);
    expect(
      competingMerges.filter((result) => result.success === true),
    ).toHaveLength(1);
    expect(
      competingMerges.filter((result) => result.success === false),
    ).toHaveLength(1);
    expect(
      competingMerges
        .flatMap(operationResults)
        .some((result) => result.error === "SOURCE_THREAD_NOT_ACTIVE"),
    ).toBe(true);
    const mergeStore = createWorkThreadStore(runtime);
    expect((await mergeStore.get(mergeSourceId))?.status).toBe("stopped");
    for (const targetId of [mergeTargetAId, mergeTargetBId]) {
      const maybeActive = await mergeStore.get(targetId);
      if (maybeActive?.status === "active") {
        const stoppedTarget = await runThreadAction(runtime, roomA, [
          { type: "stop", workThreadId: targetId },
        ]);
        if (!stoppedTarget.success) {
          await runThreadAction(runtime, roomB, [
            { type: "stop", workThreadId: targetId },
          ]);
        }
      }
    }

    const rejectedTrigger = await runThreadAction(runtime, roomB, [
      {
        type: "steer",
        workThreadId: threadId,
        instruction: "Wait for the vendor reply.",
      },
      {
        type: "schedule_followup",
        workThreadId: threadId,
        instruction: "Check for the reply.",
        trigger: { kind: "cron", schedule: "0 9 * * *" },
      },
    ]);
    expect(operationResults(rejectedTrigger)).toMatchObject([
      { success: true, type: "steer" },
      { success: false, type: "schedule_followup", error: "INVALID_TRIGGER" },
    ]);
    expect((await store.get(threadId))?.currentScheduledTaskId ?? null).toBe(
      null,
    );

    const scheduled = await runThreadAction(runtime, roomB, [
      {
        type: "schedule_followup",
        workThreadId: threadId,
        instruction: "Ask for the next visa document tomorrow.",
        trigger: { kind: "once", atIso: "2026-05-11T18:00:00.000Z" },
      },
    ]);
    expect(scheduled.success).toBe(true);
    const taskId = operationResults(scheduled)[0].taskId as string;
    expect(taskId).toBeTruthy();
    const withTask = await store.get(threadId);
    expect(withTask?.currentScheduledTaskId).toBe(taskId);

    const processed = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-11T18:01:00.000Z"),
      limit: 5,
    });
    expect(processed.errors).toEqual([]);
    expect(processed.fires).toEqual([
      {
        taskId,
        status: "fired",
        reason: "once_due",
        occurrenceAtIso: "2026-05-11T18:00:00.000Z",
      },
    ]);

    const secondProcess = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-11T18:02:00.000Z"),
      limit: 5,
    });
    expect(secondProcess.fires).toEqual([]);
    expect(secondProcess.errors).toEqual([]);
    expect(notifications).toHaveLength(1);

    for (let i = 1; i < 30; i += 1) {
      const fill = await runThreadAction(runtime, roomA, [
        {
          type: "create",
          title: `Pool slot ${i}`,
          summary: "Fill the active work-thread pool.",
        },
      ]);
      expect(fill.success).toBe(true);
    }

    const overflow = await runThreadAction(runtime, roomA, [
      {
        type: "create",
        title: "Overflow",
        summary: "Should not start while the active pool is full.",
      },
    ]);
    expect(overflow.success).toBe(false);
    expect(operationResults(overflow)[0].error).toBe("THREAD_POOL_FULL");
  });

  it("enforces multi-user and multi-channel thread boundaries while allowing current-channel merge", async () => {
    const runtime = await createRuntime();
    const worldId = stringToUuid("lifeops-work-thread-boundary-world");
    const sharedRoom = stringToUuid("lifeops-work-thread-shared-room");
    const ownerAPrivateRoom = stringToUuid(
      "lifeops-work-thread-owner-a-private-room",
    );
    const ownerBPrivateRoom = stringToUuid(
      "lifeops-work-thread-owner-b-private-room",
    );
    const ownerA = stringToUuid("lifeops-work-thread-owner-a");
    const ownerB = stringToUuid("lifeops-work-thread-owner-b");
    const channelUser = stringToUuid("lifeops-work-thread-channel-user");

    for (const participant of [
      {
        runtime,
        worldId,
        roomId: sharedRoom,
        entityId: ownerA,
        source: "discord",
        name: "Owner A",
      },
      {
        runtime,
        worldId,
        roomId: sharedRoom,
        entityId: ownerB,
        source: "discord",
        name: "Owner B",
      },
      {
        runtime,
        worldId,
        roomId: sharedRoom,
        entityId: channelUser,
        source: "discord",
        name: "Channel User",
      },
      {
        runtime,
        worldId,
        roomId: ownerAPrivateRoom,
        entityId: ownerA,
        source: "imessage",
        name: "Owner A",
        channelType: ChannelType.DM,
      },
      {
        runtime,
        worldId,
        roomId: ownerBPrivateRoom,
        entityId: ownerB,
        source: "telegram",
        name: "Owner B",
        channelType: ChannelType.DM,
      },
    ]) {
      await connectParticipant(participant);
    }

    await grantWorldRole(runtime, sharedRoom, ownerA, "OWNER");
    await grantWorldRole(runtime, sharedRoom, ownerB, "OWNER");
    await grantWorldRole(runtime, sharedRoom, channelUser, "USER");

    const sharedMessageA = (text: string) =>
      message(runtime, sharedRoom, text, {
        entityId: ownerA,
        source: "discord",
        channelType: ChannelType.GROUP,
        groupName: "Project Room",
      });
    const sharedMessageB = (text: string) =>
      message(runtime, sharedRoom, text, {
        entityId: ownerB,
        source: "discord",
        channelType: ChannelType.GROUP,
        groupName: "Project Room",
      });
    const sharedMessageUser = (text: string) =>
      message(runtime, sharedRoom, text, {
        entityId: channelUser,
        source: "discord",
        channelType: ChannelType.GROUP,
        groupName: "Project Room",
      });
    const privateMessageA = (text: string) =>
      message(runtime, ownerAPrivateRoom, text, {
        entityId: ownerA,
        source: "imessage",
        channelType: ChannelType.DM,
        groupName: "Owner A iMessage",
      });
    const privateMessageB = (text: string) =>
      message(runtime, ownerBPrivateRoom, text, {
        entityId: ownerB,
        source: "telegram",
        channelType: ChannelType.DM,
        groupName: "Owner B Telegram",
      });

    const createdSharedA = await runThreadAction(
      runtime,
      sharedMessageA("start a thread for the launch plan"),
      [
        {
          type: "create",
          title: "Launch plan",
          summary: "Coordinate the shared launch.",
          instruction: "Track launch milestones.",
        },
      ],
    );
    const sharedPlanId = operationResults(createdSharedA)[0]
      .workThreadId as string;

    const createdSharedB = await runThreadAction(
      runtime,
      sharedMessageB("start a thread for launch budget"),
      [
        {
          type: "create",
          title: "Launch budget",
          summary: "Track the shared launch budget.",
          instruction: "Track budget approvals.",
        },
      ],
    );
    const sharedBudgetId = operationResults(createdSharedB)[0]
      .workThreadId as string;

    const createdPrivateA = await runThreadAction(
      runtime,
      privateMessageA("start a private thread for passport renewal"),
      [
        {
          type: "create",
          title: "Passport renewal",
          summary: "Private owner A renewal work.",
        },
      ],
    );
    const privateAId = operationResults(createdPrivateA)[0]
      .workThreadId as string;

    const createdPrivateB = await runThreadAction(
      runtime,
      privateMessageB("start a private thread for tax paperwork"),
      [
        {
          type: "create",
          title: "Tax paperwork",
          summary: "Private owner B tax work.",
        },
      ],
    );
    const privateBId = operationResults(createdPrivateB)[0]
      .workThreadId as string;

    const state = { values: {}, data: {}, text: "" } as State;
    const ownerAProvider = await workThreadsProvider.get(
      runtime,
      sharedMessageA("continue this thread"),
      state,
    );
    expect(ownerAProvider.text).toContain(sharedPlanId);
    expect(ownerAProvider.text).toContain(sharedBudgetId);
    expect(ownerAProvider.text).toContain(privateAId);
    expect(ownerAProvider.text).not.toContain(privateBId);
    expect(ownerAProvider.text).toContain("read-only-cross-channel");

    const ownerBProvider = await workThreadsProvider.get(
      runtime,
      sharedMessageB("continue this thread"),
      state,
    );
    expect(ownerBProvider.text).toContain(sharedPlanId);
    expect(ownerBProvider.text).toContain(sharedBudgetId);
    expect(ownerBProvider.text).toContain(privateBId);
    expect(ownerBProvider.text).not.toContain(privateAId);

    const userMessage = sharedMessageUser("continue this thread");
    expect(await workThreadAction.validate?.(runtime, userMessage)).toBe(false);
    expect(
      await threadOpsFieldEvaluator.shouldRun?.(
        fieldContext(runtime, userMessage),
      ),
    ).toBe(false);
    const userProvider = await workThreadsProvider.get(
      runtime,
      userMessage,
      state,
    );
    expect(userProvider.values?.workThreadCount).toBe(0);
    const deniedUserAction = await runThreadAction(runtime, userMessage, [
      {
        type: "steer",
        workThreadId: sharedPlanId,
        instruction: "Non-owner should not steer shared work.",
      },
    ]);
    expect(deniedUserAction.success).toBe(false);
    expect(deniedUserAction.data?.error).toBe("PERMISSION_DENIED");

    const ownerBSteersShared = await runThreadAction(
      runtime,
      sharedMessageB("continue this thread"),
      [
        {
          type: "steer",
          workThreadId: sharedPlanId,
          instruction: "Owner B can steer channel-scoped launch work.",
        },
      ],
    );
    expect(ownerBSteersShared.success).toBe(true);

    const ownerBPrivateADenied = await runThreadAction(
      runtime,
      sharedMessageB("continue this thread"),
      [
        {
          type: "steer",
          workThreadId: privateAId,
          instruction: "Owner B must not steer owner A private work.",
        },
      ],
    );
    expect(ownerBPrivateADenied.success).toBe(false);
    expect(operationResults(ownerBPrivateADenied)[0].error).toBe(
      "CROSS_CHANNEL_READ_ONLY",
    );

    const ownerAPrivateADeniedBeforeAttach = await runThreadAction(
      runtime,
      sharedMessageA("continue this thread"),
      [
        {
          type: "steer",
          workThreadId: privateAId,
          instruction: "Owner A still needs current-channel attachment.",
        },
      ],
    );
    expect(ownerAPrivateADeniedBeforeAttach.success).toBe(false);
    expect(operationResults(ownerAPrivateADeniedBeforeAttach)[0].error).toBe(
      "CROSS_CHANNEL_READ_ONLY",
    );

    const attachedPrivateA = await runThreadAction(
      runtime,
      sharedMessageA("continue this thread"),
      [{ type: "attach_source", workThreadId: privateAId }],
    );
    expect(attachedPrivateA.success).toBe(true);
    const ownerASteersAfterAttach = await runThreadAction(
      runtime,
      sharedMessageA("continue this thread"),
      [
        {
          type: "steer",
          workThreadId: privateAId,
          instruction: "Owner A may steer after attaching this channel.",
        },
      ],
    );
    expect(ownerASteersAfterAttach.success).toBe(true);

    const ownerBProviderAfterAttach = await workThreadsProvider.get(
      runtime,
      sharedMessageB("continue this thread"),
      state,
    );
    expect(ownerBProviderAfterAttach.text).toContain(privateAId);
    expect(ownerBProviderAfterAttach.text).toContain("mutable-current-channel");

    const crossChannelMergeDenied = await runThreadAction(
      runtime,
      sharedMessageB("merge these threads"),
      [
        {
          type: "merge",
          workThreadId: sharedPlanId,
          sourceWorkThreadIds: [privateBId],
          instruction: "Do not merge private cross-channel work directly.",
        },
      ],
    );
    expect(crossChannelMergeDenied.success).toBe(false);
    expect(operationResults(crossChannelMergeDenied)[0]).toMatchObject({
      error: "CROSS_CHANNEL_READ_ONLY",
      sourceWorkThreadId: privateBId,
    });

    const merged = await runThreadAction(
      runtime,
      sharedMessageA("merge these"),
      [
        {
          type: "merge",
          workThreadId: sharedPlanId,
          sourceWorkThreadIds: [sharedBudgetId],
          summary: "Merged launch plan and budget.",
          instruction: "Treat launch plan and budget as one workstream.",
        },
      ],
    );
    expect(merged.success).toBe(true);

    const store = createWorkThreadStore(runtime);
    const mergedTarget = await store.get(sharedPlanId);
    const mergedSource = await store.get(sharedBudgetId);
    const stillPrivateB = await store.get(privateBId);
    expect(mergedTarget?.summary).toBe("Merged launch plan and budget.");
    expect(mergedTarget?.currentPlanSummary).toBe(
      "Treat launch plan and budget as one workstream.",
    );
    expect(mergedTarget?.participantEntityIds).toContain(ownerA);
    expect(mergedTarget?.participantEntityIds).toContain(ownerB);
    expect(mergedTarget?.metadata?.mergedFromWorkThreadIds).toEqual([
      sharedBudgetId,
    ]);
    expect(mergedSource?.status).toBe("stopped");
    expect(mergedSource?.metadata?.mergedIntoWorkThreadId).toBe(sharedPlanId);
    expect(stillPrivateB?.status).toBe("active");

    const stopped = await runThreadAction(
      runtime,
      sharedMessageB("stop this"),
      [
        {
          type: "stop",
          workThreadId: sharedPlanId,
          reason: "Merged work done.",
        },
      ],
    );
    expect(stopped.success).toBe(true);

    const stoppedAgain = await runThreadAction(
      runtime,
      sharedMessageA("stop this"),
      [{ type: "stop", workThreadId: sharedPlanId }],
    );
    expect(stoppedAgain.success).toBe(true);
    expect(operationResults(stoppedAgain)[0]).toMatchObject({
      noop: true,
      status: "stopped",
    });

    const steerStopped = await runThreadAction(
      runtime,
      sharedMessageA("continue this thread"),
      [
        {
          type: "steer",
          workThreadId: sharedPlanId,
          instruction: "Stopped threads should not be steerable.",
        },
      ],
    );
    expect(steerStopped.success).toBe(false);
    expect(operationResults(steerStopped)[0]).toMatchObject({
      error: "THREAD_NOT_ACTIVE",
      status: "stopped",
    });

    const providerAfterStop = await workThreadsProvider.get(
      runtime,
      sharedMessageA("continue this thread"),
      state,
    );
    expect(providerAfterStop.text).not.toContain(sharedPlanId);
    expect(providerAfterStop.text).not.toContain(sharedBudgetId);
  });
});

describe("work thread follow-up lifecycle", () => {
  it("drops the follow-up a reschedule replaces and the one a stop leaves behind", async () => {
    const runtime = await createRuntime();
    const notifications: unknown[] = [];
    const sink = {
      serviceType: "notification",
      capabilityDescription: "Synthetic test notification sink",
      async notify(input: unknown) {
        notifications.push(input);
        return { id: `test-followup-${notifications.length}` };
      },
      async stop() {},
    };
    runtime.services.set("notification", [sink as unknown as Service]);
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "Which visa document is next?",
      "test-followup-render",
    );
    const store = createWorkThreadStore(runtime);
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const roomId = stringToUuid("followup-lifecycle-room");
    const followup = (atIso: string) => ({
      type: "schedule_followup",
      instruction: "Ask for the passport scan.",
      trigger: { kind: "once", atIso },
    });
    const scheduledFollowups = async () =>
      (await runner.list({ kind: "followup" })).filter(
        (task) => task.state.status === "scheduled",
      );

    const rescheduled = await store.create({
      title: "Visa documents",
      summary: "Collect the visa documents.",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    const first = await runThreadAction(
      runtime,
      message(runtime, roomId, "follow up on the visa documents"),
      [
        {
          ...followup("2026-05-11T18:00:00.000Z"),
          workThreadId: rescheduled.id,
        },
      ],
    );
    const firstTaskId = operationResults(first)[0].taskId as string;
    const second = await runThreadAction(
      runtime,
      message(runtime, roomId, "actually, follow up tomorrow instead"),
      [
        {
          ...followup("2026-05-12T18:00:00.000Z"),
          workThreadId: rescheduled.id,
        },
      ],
    );
    const secondTaskId = operationResults(second)[0].taskId as string;
    expect(secondTaskId).not.toBe(firstTaskId);
    expect((await scheduledFollowups()).map((task) => task.taskId)).toEqual([
      secondTaskId,
    ]);
    expect((await store.get(rescheduled.id))?.currentScheduledTaskId).toBe(
      secondTaskId,
    );

    const stopped = await store.create({
      title: "Vendor quote",
      summary: "Chase the vendor quote.",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    const chased = await runThreadAction(
      runtime,
      message(runtime, roomId, "follow up on the quote"),
      [{ ...followup("2026-05-11T18:00:00.000Z"), workThreadId: stopped.id }],
    );
    const stoppedTaskId = operationResults(chased)[0].taskId as string;
    const stop = await runThreadAction(
      runtime,
      message(runtime, roomId, "stop chasing the quote"),
      [{ type: "stop", workThreadId: stopped.id }],
    );
    expect(operationResults(stop)).toMatchObject([
      { success: true, type: "stop", status: "stopped" },
    ]);
    expect(await store.get(stopped.id)).toMatchObject({
      status: "stopped",
      currentScheduledTaskId: null,
    });
    expect(
      (await runner.list({ kind: "followup" })).map((task) => task.taskId),
    ).not.toContain(stoppedTaskId);

    const processed = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-12T18:01:00.000Z"),
      limit: 5,
    });
    expect(processed.errors).toEqual([]);
    expect(processed.fires.map((fire) => fire.taskId)).toEqual([secondTaskId]);
    expect(notifications).toHaveLength(1);
  });
  it("reports a follow-up its stop could not remove, and the follow-up never fires", async () => {
    const runtime = await createRuntime();
    const notifications: unknown[] = [];
    const sink = {
      serviceType: "notification",
      capabilityDescription: "Synthetic test notification sink",
      async notify(input: unknown) {
        notifications.push(input);
        return { id: `test-followup-${notifications.length}` };
      },
      async stop() {},
    };
    runtime.services.set("notification", [sink as unknown as Service]);
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "Which visa document is next?",
      "test-followup-render",
    );
    const store = createWorkThreadStore(runtime);
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const roomId = stringToUuid("followup-remove-fails-room");
    const thread = await store.create({
      title: "Vendor quote",
      summary: "Chase the vendor quote.",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    const chased = await runThreadAction(
      runtime,
      message(runtime, roomId, "follow up on the quote"),
      [
        {
          type: "schedule_followup",
          workThreadId: thread.id,
          instruction: "Ask for the quote.",
          trigger: { kind: "once", atIso: "2026-05-11T18:00:00.000Z" },
        },
      ],
    );
    const taskId = operationResults(chased)[0].taskId as string;
    const remove = vi
      .spyOn(runner, "remove")
      .mockRejectedValue(new Error("task store offline"));
    await expect(
      runThreadAction(runtime, message(runtime, roomId, "stop this"), [
        { type: "stop", workThreadId: thread.id },
      ]),
    ).rejects.toMatchObject({
      code: "WORK_THREAD_FOLLOWUP_RECONCILIATION_REQUIRED",
      context: { workThreadId: thread.id, taskId, status: "stopped" },
    });
    remove.mockRestore();
    // The owner's stop is durable; the task row outlived it.
    expect(await store.get(thread.id)).toMatchObject({
      status: "stopped",
      currentScheduledTaskId: null,
    });
    expect(
      (await runner.list({ kind: "followup" })).map((task) => task.taskId),
    ).toContain(taskId);
    // The leftover task cannot notify: the tick reads the thread first.
    const processed = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-11T18:01:00.000Z"),
      limit: 5,
    });
    expect(processed.errors).toEqual([]);
    expect(processed.fires).toEqual([
      expect.objectContaining({ taskId, status: "dismissed" }),
    ]);
    expect(notifications).toHaveLength(0);
  });

  it("dismisses a follow-up stored before this check when its thread has ended", async () => {
    const runtime = await createRuntime();
    const notifications: unknown[] = [];
    const sink = {
      serviceType: "notification",
      capabilityDescription: "Synthetic test notification sink",
      async notify(input: unknown) {
        notifications.push(input);
        return { id: `test-followup-${notifications.length}` };
      },
      async stop() {},
    };
    runtime.services.set("notification", [sink as unknown as Service]);
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "Which visa document is next?",
      "test-followup-render",
    );
    const store = createWorkThreadStore(runtime);
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const roomId = stringToUuid("followup-legacy-task-room");
    const thread = await store.create({
      title: "Vendor quote",
      summary: "Chase the vendor quote.",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    // The durable shape a deployed agent already holds: a follow-up task
    // bound to the thread by subject only, linked on the thread row.
    const legacy = await runner.schedule({
      kind: "followup",
      promptInstructions: "Ask for the quote.",
      trigger: { kind: "once", atIso: "2026-05-11T18:00:00.000Z" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
      subject: { kind: "thread", id: thread.id },
      output: { destination: "channel", target: `in_app:${roomId}` },
      metadata: { workThreadId: thread.id },
    });
    await store.update(thread.id, {
      currentScheduledTaskId: legacy.taskId,
      expectedVersion: thread.version,
    });
    const remove = vi
      .spyOn(runner, "remove")
      .mockRejectedValue(new Error("task store offline"));
    await expect(
      runThreadAction(runtime, message(runtime, roomId, "stop this"), [
        { type: "stop", workThreadId: thread.id },
      ]),
    ).rejects.toMatchObject({
      code: "WORK_THREAD_FOLLOWUP_RECONCILIATION_REQUIRED",
      context: { workThreadId: thread.id, taskId: legacy.taskId },
    });
    remove.mockRestore();
    expect(await store.get(thread.id)).toMatchObject({
      status: "stopped",
      currentScheduledTaskId: null,
    });
    const processed = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-11T18:01:00.000Z"),
      limit: 5,
    });
    expect(processed.errors).toEqual([]);
    expect(processed.fires).toEqual([
      expect.objectContaining({
        taskId: legacy.taskId,
        status: "dismissed",
        reason: "work thread is stopped",
      }),
    ]);
    expect(notifications).toHaveLength(0);
  });

  it("changes nothing when a stop cannot commit the thread", async () => {
    const runtime = await createRuntime();
    const store = createWorkThreadStore(runtime);
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const roomId = stringToUuid("followup-stop-conflict-room");
    const thread = await store.create({
      title: "Vendor quote",
      summary: "Chase the vendor quote.",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    const chased = await runThreadAction(
      runtime,
      message(runtime, roomId, "follow up on the quote"),
      [
        {
          type: "schedule_followup",
          workThreadId: thread.id,
          instruction: "Ask for the quote.",
          trigger: { kind: "once", atIso: "2026-05-11T18:00:00.000Z" },
        },
      ],
    );
    const taskId = operationResults(chased)[0].taskId as string;
    const remove = vi.spyOn(runner, "remove");
    // Every optimistic attempt loses to an owner edit.
    const original = LifeOpsRepository.prototype.upsertWorkThread;
    vi.spyOn(
      LifeOpsRepository.prototype,
      "upsertWorkThread",
    ).mockImplementation(async function (
      this: LifeOpsRepository,
      agentId,
      next,
      options,
    ) {
      if (next.id === thread.id && next.status === "stopped") {
        const current = await store.get(thread.id);
        if (!current) throw new Error("Fixture thread disappeared");
        await original.call(
          this,
          agentId,
          {
            ...current,
            summary: `Owner edit ${current.version}`,
            version: current.version + 1,
          },
          { expectedVersion: current.version },
        );
      }
      return original.call(this, agentId, next, options);
    });
    await expect(
      runThreadAction(runtime, message(runtime, roomId, "stop this"), [
        { type: "stop", workThreadId: thread.id },
      ]),
    ).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
    const unchanged = await store.get(thread.id);
    expect(unchanged?.status).toBe(thread.status);
    expect(unchanged?.currentScheduledTaskId).toBe(taskId);
    expect(
      (await runner.list({ kind: "followup" })).map((task) => task.taskId),
    ).toContain(taskId);
  });

  it("names a replaced follow-up that cannot be removed for reconciliation, and only the replacement delivers", async () => {
    const runtime = await createRuntime();
    const notifications: unknown[] = [];
    const sink = {
      serviceType: "notification",
      capabilityDescription: "Synthetic test notification sink",
      async notify(input: unknown) {
        notifications.push(input);
        return { id: `test-followup-${notifications.length}` };
      },
      async stop() {},
    };
    runtime.services.set("notification", [sink as unknown as Service]);
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "Which visa document is next?",
      "test-followup-render",
    );
    const store = createWorkThreadStore(runtime);
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const roomId = stringToUuid("followup-replace-remove-fails-room");
    const thread = await store.create({
      title: "Visa documents",
      summary: "Collect the visa documents.",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    const followup = (atIso: string) => ({
      type: "schedule_followup",
      workThreadId: thread.id,
      instruction: "Ask for the passport scan.",
      trigger: { kind: "once", atIso },
    });
    const first = await runThreadAction(
      runtime,
      message(runtime, roomId, "follow up"),
      [followup("2026-05-11T18:00:00.000Z")],
    );
    const firstTaskId = operationResults(first)[0].taskId as string;
    vi.spyOn(runner, "remove").mockRejectedValue(
      new Error("task store offline"),
    );
    await expect(
      runThreadAction(runtime, message(runtime, roomId, "tomorrow instead"), [
        followup("2026-05-12T18:00:00.000Z"),
      ]),
    ).rejects.toMatchObject({
      code: "WORK_THREAD_FOLLOWUP_RECONCILIATION_REQUIRED",
      context: { workThreadId: thread.id, taskId: firstTaskId },
    });
    const linked = await store.get(thread.id);
    expect(linked?.currentScheduledTaskId).toBeTruthy();
    expect(linked?.currentScheduledTaskId).not.toBe(firstTaskId);
    const scheduled = (await runner.list({ kind: "followup" })).map(
      (task) => task.taskId,
    );
    expect(scheduled).toContain(firstTaskId);
    expect(scheduled).toContain(linked?.currentScheduledTaskId);
    // Both are due: the replaced task is dismissed, only the current one fires.
    const processed = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-12T18:01:00.000Z"),
      limit: 5,
    });
    expect(processed.errors).toEqual([]);
    expect(processed.fires.map((fire) => [fire.taskId, fire.status])).toEqual(
      expect.arrayContaining([
        [firstTaskId, "dismissed"],
        [linked?.currentScheduledTaskId, "fired"],
      ]),
    );
    expect(processed.fires).toHaveLength(2);
    expect(notifications).toHaveLength(1);
  });
  it("skips a follow-up whose thread was stopped between the tick's read and the claim", async () => {
    const runtime = await createRuntime();
    const notifications: unknown[] = [];
    const sink = {
      serviceType: "notification",
      capabilityDescription: "Synthetic test notification sink",
      async notify(input: unknown) {
        notifications.push(input);
        return { id: `test-followup-${notifications.length}` };
      },
      async stop() {},
    };
    runtime.services.set("notification", [sink as unknown as Service]);
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "Which visa document is next?",
      "test-followup-render",
    );
    const store = createWorkThreadStore(runtime);
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const roomId = stringToUuid("followup-stop-race-room");
    const thread = await store.create({
      title: "Vendor quote",
      summary: "Chase the vendor quote.",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    const chased = await runThreadAction(
      runtime,
      message(runtime, roomId, "follow up on the quote"),
      [
        {
          type: "schedule_followup",
          workThreadId: thread.id,
          instruction: "Ask for the quote.",
          trigger: { kind: "once", atIso: "2026-05-11T18:00:00.000Z" },
        },
      ],
    );
    const taskId = operationResults(chased)[0].taskId as string;
    // Removal fails, so the task row survives the stop and only the thread
    // state can keep it from notifying.
    vi.spyOn(runner, "remove").mockRejectedValue(
      new Error("task store offline"),
    );
    // The stop commits after the tick has read the thread as active and
    // before it claims the task.
    afterThreadCheck = async () => {
      afterThreadCheck = null;
      await expect(
        runThreadAction(runtime, message(runtime, roomId, "stop this"), [
          { type: "stop", workThreadId: thread.id },
        ]),
      ).rejects.toMatchObject({
        code: "WORK_THREAD_FOLLOWUP_RECONCILIATION_REQUIRED",
      });
    };
    const processed = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-11T18:01:00.000Z"),
      limit: 5,
    });
    expect(afterThreadCheck).toBeNull();
    expect(processed.errors).toEqual([]);
    expect(processed.fires).toEqual([
      expect.objectContaining({
        taskId,
        status: "scheduled",
        reason: "work thread is stopped",
      }),
    ]);
    expect(notifications).toHaveLength(0);
    expect(
      (await runner.list({ kind: "followup" })).find(
        (task) => task.taskId === taskId,
      )?.state.status,
    ).toBe("scheduled");
    // The next tick dismisses the leftover row for good.
    const again = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-11T18:02:00.000Z"),
      limit: 5,
    });
    expect(again.fires).toEqual([
      expect.objectContaining({ taskId, status: "dismissed" }),
    ]);
    expect(notifications).toHaveLength(0);
  });

  it("delivers only the replacement when a follow-up is rescheduled between the tick's read and the claim", async () => {
    const runtime = await createRuntime();
    const notifications: unknown[] = [];
    const sink = {
      serviceType: "notification",
      capabilityDescription: "Synthetic test notification sink",
      async notify(input: unknown) {
        notifications.push(input);
        return { id: `test-followup-${notifications.length}` };
      },
      async stop() {},
    };
    runtime.services.set("notification", [sink as unknown as Service]);
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "Which visa document is next?",
      "test-followup-render",
    );
    const store = createWorkThreadStore(runtime);
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const roomId = stringToUuid("followup-replace-race-room");
    const thread = await store.create({
      title: "Vendor quote",
      summary: "Chase the vendor quote.",
      primarySourceRef: { connector: "test", roomId, canMutate: true },
    });
    const first = await runThreadAction(
      runtime,
      message(runtime, roomId, "follow up on the quote"),
      [
        {
          type: "schedule_followup",
          workThreadId: thread.id,
          instruction: "Ask for the quote.",
          trigger: { kind: "once", atIso: "2026-05-11T18:00:00.000Z" },
        },
      ],
    );
    const firstTaskId = operationResults(first)[0].taskId as string;
    vi.spyOn(runner, "remove").mockRejectedValue(
      new Error("task store offline"),
    );
    let secondTaskId = "";
    afterThreadCheck = async () => {
      afterThreadCheck = null;
      await expect(
        runThreadAction(runtime, message(runtime, roomId, "ask again sooner"), [
          {
            type: "schedule_followup",
            workThreadId: thread.id,
            instruction: "Ask for the quote again.",
            trigger: { kind: "once", atIso: "2026-05-11T18:00:30.000Z" },
          },
        ]),
      ).rejects.toMatchObject({
        code: "WORK_THREAD_FOLLOWUP_RECONCILIATION_REQUIRED",
      });
      secondTaskId = (await store.get(thread.id))?.currentScheduledTaskId ?? "";
    };
    const processed = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-11T18:01:00.000Z"),
      limit: 5,
    });
    expect(afterThreadCheck).toBeNull();
    expect(secondTaskId).not.toBe("");
    expect(processed.errors).toEqual([]);
    // The replaced follow-up is not claimed; the replacement was created after
    // this tick listed its due tasks, so it fires on the next tick.
    expect(processed.fires).toEqual([
      expect.objectContaining({
        taskId: firstTaskId,
        status: "scheduled",
        reason: "work thread follow-up was replaced",
      }),
    ]);
    expect(notifications).toHaveLength(0);
    const next = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-11T18:02:00.000Z"),
      limit: 5,
    });
    expect(next.errors).toEqual([]);
    expect(
      new Map(next.fires.map((fire) => [fire.taskId, fire.status])),
    ).toEqual(
      new Map([
        [firstTaskId, "dismissed"],
        [secondTaskId, "fired"],
      ]),
    );
    expect(notifications).toHaveLength(1);
  });

  it("delivers a follow-up another pack scheduled with a thread subject that is not a work thread", async () => {
    const runtime = await createRuntime();
    const notifications: unknown[] = [];
    const sink = {
      serviceType: "notification",
      capabilityDescription: "Synthetic test notification sink",
      async notify(input: unknown) {
        notifications.push(input);
        return { id: `test-followup-${notifications.length}` };
      },
      async stop() {},
    };
    runtime.services.set("notification", [sink as unknown as Service]);
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "Did the vendor answer the quote question?",
      "test-followup-render",
    );
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    // The executive-assistant waiting-on watcher schedules follow-ups with
    // `subject.kind: "thread"` and a stable id from the delegated item, which
    // is not a work-thread row. No `metadata.workThreadId` marks it.
    const task = await runner.schedule({
      kind: "followup",
      promptInstructions: "Nudge the vendor about the open quote question.",
      trigger: { kind: "once", atIso: "2026-05-11T18:00:00.000Z" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: runtime.agentId,
      ownerVisible: true,
      subject: { kind: "thread", id: "sent-question:vendor-quote" },
      metadata: { createdFrom: "executive_assistant_waiting_on" },
    });
    const processed = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-11T18:01:00.000Z"),
      limit: 5,
    });
    expect(processed.errors).toEqual([]);
    expect(processed.fires).toEqual([
      expect.objectContaining({ taskId: task.taskId, status: "fired" }),
    ]);
    expect(notifications).toHaveLength(1);
  });
});
