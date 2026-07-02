/**
 * Deterministic inbound-reply completion — production wiring (issues
 * #10721/#10723 completion-check realness).
 *
 * Before this hook the ONLY `evaluateCompletion` caller was the LLM verb
 * action, so a plain owner "done!" left `user_replied_within` tasks `fired`
 * until the completion timeout skipped them. These tests exercise the REAL
 * seam end to end: PA's `events[MESSAGE_RECEIVED]` handler (registered by
 * the plugin itself, not a harness shim) matches the reply room against each
 * fired task's pending-prompt room and evaluates the task's completion check
 * against PA's production runner deps — including the real
 * `SubjectStoreView` for `subject_updated`.
 */

import { KNOWLEDGE_GRAPH_SERVICE, KnowledgeGraphService } from "@elizaos/agent";
import { EventType, type Memory } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { resolvePendingPromptsStore } from "../pending-prompts/store.js";
import { LifeOpsRepository } from "../repository.js";
import { completeFiredTasksOnOwnerReply } from "./inbound-reply-completion.js";
import type { ScheduledTask, ScheduledTaskCompletionCheck } from "./index.js";

type Runtime = RealTestRuntimeResult["runtime"];

interface FiredTaskSeed {
  taskId?: string;
  roomId: string;
  firedAtIso: string;
  completionCheck: ScheduledTaskCompletionCheck;
  subject?: ScheduledTask["subject"];
}

async function seedFiredTask(
  runtime: Runtime,
  seed: FiredTaskSeed,
): Promise<ScheduledTask> {
  const repo = new LifeOpsRepository(runtime);
  const task: ScheduledTask = {
    taskId:
      seed.taskId ?? `st_fired_${Math.random().toString(36).slice(2, 10)}`,
    kind: "checkin",
    promptInstructions: "How did it go?",
    trigger: { kind: "manual" },
    priority: "medium",
    respectsGlobalPause: false,
    source: "user_chat",
    createdBy: runtime.agentId,
    ownerVisible: true,
    completionCheck: seed.completionCheck,
    ...(seed.subject ? { subject: seed.subject } : {}),
    metadata: { pendingPromptRoomId: seed.roomId },
    state: {
      status: "fired",
      firedAt: seed.firedAtIso,
      followupCount: 0,
    },
  };
  await repo.upsertScheduledTask(runtime.agentId, task);
  return task;
}

function ownerReply(runtime: Runtime, roomId: string): Memory {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    entityId: "owner-entity-1",
    roomId,
    agentId: runtime.agentId,
    content: { text: "done!" },
    createdAt: Date.now(),
  } as unknown as Memory;
}

async function persistedStatus(
  runtime: Runtime,
  taskId: string,
): Promise<string | undefined> {
  const repo = new LifeOpsRepository(runtime);
  const task = await repo.getScheduledTask(runtime.agentId, taskId);
  return task?.state.status;
}

const FIVE_MINUTES_AGO = () => new Date(Date.now() - 5 * 60_000).toISOString();

describe("inbound-reply completion — production wiring", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("an owner reply in the pending-prompt room completes a fired user_replied_within task via MESSAGE_RECEIVED", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const roomId = "room-checkin-1";

    const task = await seedFiredTask(runtime, {
      roomId,
      firedAtIso: FIVE_MINUTES_AGO(),
      completionCheck: { kind: "user_replied_within" },
    });
    // Mirror the scheduler's fire-time bookkeeping so the resolve path is
    // observable too.
    const prompts = resolvePendingPromptsStore(runtime);
    await prompts.record({
      roomId,
      taskId: task.taskId,
      promptSnippet: task.promptInstructions,
      firedAt: task.state.firedAt as string,
      expectedReplyKind: "free_form",
    });

    // The REAL seam: emit through the runtime bus; PA's registered
    // events[MESSAGE_RECEIVED] handler does the completion pass.
    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      message: ownerReply(runtime, roomId),
    });

    expect(await persistedStatus(runtime, task.taskId)).toBe("completed");
    // The open prompt was forgotten so the planner stops steering at it.
    expect(await prompts.list(roomId)).toHaveLength(0);

    const repo = new LifeOpsRepository(runtime);
    const log = await repo.listScheduledTaskLog({
      agentId: runtime.agentId,
      taskId: task.taskId,
    });
    const completedEntry = log.find(
      (entry) => entry.transition === "completed",
    );
    expect(completedEntry?.reason).toBe("completion-check:user_replied_within");
  }, 180_000);

  it("a reply in a different room leaves the fired task untouched", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const task = await seedFiredTask(runtime, {
      roomId: "room-a",
      firedAtIso: FIVE_MINUTES_AGO(),
      completionCheck: { kind: "user_replied_within" },
    });

    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      message: ownerReply(runtime, "room-b"),
    });

    expect(await persistedStatus(runtime, task.taskId)).toBe("fired");
  }, 180_000);

  it("a plain reply does NOT complete user_acknowledged (acknowledgment stays an explicit verb)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const roomId = "room-ack-1";

    const task = await seedFiredTask(runtime, {
      roomId,
      firedAtIso: FIVE_MINUTES_AGO(),
      completionCheck: { kind: "user_acknowledged" },
    });

    const result = await completeFiredTasksOnOwnerReply(
      runtime,
      ownerReply(runtime, roomId),
    );

    // The check was evaluated against the reply but honestly declined.
    expect(result.evaluated).toContain(task.taskId);
    expect(result.completed).not.toContain(task.taskId);
    expect(await persistedStatus(runtime, task.taskId)).toBe("fired");
  }, 180_000);

  it("the agent's own outbound message never evaluates completion", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const roomId = "room-self-1";

    const task = await seedFiredTask(runtime, {
      roomId,
      firedAtIso: FIVE_MINUTES_AGO(),
      completionCheck: { kind: "user_replied_within" },
    });

    const selfMessage = {
      id: "msg-self",
      entityId: runtime.agentId,
      roomId,
      agentId: runtime.agentId,
      content: { text: "reminder: how did it go?" },
      createdAt: Date.now(),
    } as unknown as Memory;

    const result = await completeFiredTasksOnOwnerReply(runtime, selfMessage);

    expect(result.evaluated).toEqual([]);
    expect(await persistedStatus(runtime, task.taskId)).toBe("fired");
  }, 180_000);

  it("subject_updated completes only after the real entity row changes", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const roomId = "room-subject-1";

    // The production SubjectStoreView answers from the registered
    // KnowledgeGraphService — the agent runtime registers it in production;
    // the harness registers it here.
    await runtime.registerService(KnowledgeGraphService);
    await runtime.getServiceLoadPromise(KNOWLEDGE_GRAPH_SERVICE);
    await LifeOpsRepository.bootstrapSchema(runtime);

    const entityId = `ent_subject_${Math.random().toString(36).slice(2, 8)}`;
    const task = await seedFiredTask(runtime, {
      roomId,
      firedAtIso: new Date(Date.now() - 60_000).toISOString(),
      completionCheck: { kind: "subject_updated" },
      subject: { kind: "entity", id: entityId },
    });

    // No entity row yet → honest not-updated, task stays fired.
    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      message: ownerReply(runtime, roomId),
    });
    expect(await persistedStatus(runtime, task.taskId)).toBe("fired");

    // The subject row lands (updatedAt = now >= firedAt) → the next
    // opportunistic re-evaluation completes the task deterministically.
    const repo = new LifeOpsRepository(runtime);
    const store = await repo.entityStore(runtime.agentId);
    await store.upsert({
      entityId,
      type: "person",
      preferredName: "Alice",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      message: ownerReply(runtime, roomId),
    });
    expect(await persistedStatus(runtime, task.taskId)).toBe("completed");
  }, 180_000);
});
