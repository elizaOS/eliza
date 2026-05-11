import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  ResponseHandlerFieldContext,
  ResponseHandlerResult,
  State,
} from "@elizaos/core";
import { ChannelType, setEntityRole, stringToUuid } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workThreadAction } from "../src/actions/work-thread.ts";
import { processDueScheduledTasks } from "../src/lifeops/scheduled-task/scheduler.ts";
import {
  type ThreadOp,
  threadOpsFieldEvaluator,
} from "../src/lifeops/work-threads/field-evaluator-thread-ops.ts";
import { createWorkThreadStore } from "../src/lifeops/work-threads/store.ts";
import { workThreadsProvider } from "../src/providers/work-threads.ts";
import { createMockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";

let cleanupRuntime: (() => Promise<void>) | undefined;

vi.setConfig({ testTimeout: 120_000 });

afterEach(async () => {
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

function operationResults(result: ActionResult): Array<Record<string, unknown>> {
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
  it("routes, guards, follows up, and caps active thread work", async () => {
    const runtime = await createRuntime();
    const idleRoom = message(runtime, "room-idle", "hello there");
    expect(await workThreadAction.validate?.(runtime, idleRoom)).toBe(false);
    expect(
      await threadOpsFieldEvaluator.shouldRun?.(fieldContext(runtime, idleRoom)),
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

    const providerResult = await workThreadsProvider.get(
      runtime,
      roomA,
      { values: {}, data: {}, text: "" } as State,
    );
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
    const providerWithNoise = await workThreadsProvider.get(
      runtime,
      roomA,
      { values: {}, data: {}, text: "" } as State,
    );
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
        source: "signal",
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
        source: "signal",
        channelType: ChannelType.DM,
        groupName: "Owner A Signal",
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
      await threadOpsFieldEvaluator.shouldRun?.(fieldContext(runtime, userMessage)),
    ).toBe(false);
    const userProvider = await workThreadsProvider.get(runtime, userMessage, state);
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

    const merged = await runThreadAction(runtime, sharedMessageA("merge these"), [
      {
        type: "merge",
        workThreadId: sharedPlanId,
        sourceWorkThreadIds: [sharedBudgetId],
        summary: "Merged launch plan and budget.",
        instruction: "Treat launch plan and budget as one workstream.",
      },
    ]);
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

    const stopped = await runThreadAction(runtime, sharedMessageB("stop this"), [
      { type: "stop", workThreadId: sharedPlanId, reason: "Merged work done." },
    ]);
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
