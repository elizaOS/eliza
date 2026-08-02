/**
 * Unit tests for TRIGGER's `create` op: prompt-kind reminders vs workflow
 * triggers. Pins the reminder contract — relative delay (delaySeconds /
 * delayMinutes) converts to a one-off scheduledAtIso, no workflowId means
 * kind:"prompt", prompt triggers are creatable with the autonomy loop off and
 * land in the originating room — against a minimal in-memory runtime.
 * Also covers the update / delete / toggle lifecycle ops (happy paths and
 * structured not-found failures) and the effect-receipt contract: mutating
 * ops bind their canonical ack text to committed receipts — an applied
 * receipt for fresh mutations, a replayed no-op for the idempotent
 * already-exists path — so the planned-reply egress verifier can ground a
 * truthful completion claim, while failures stay receipt-less.
 */

import type {
  ActionParameters,
  IAgentRuntime,
  Memory,
  PromptTriggerConfig,
  Task,
  UUID,
} from "@elizaos/core";
import {
  AUTONOMY_SERVICE_TYPE,
  hasAppliedUserFacingEffectProof,
  stringToUuid,
  TRIGGER_SCHEMA_VERSION,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TriggerTaskMetadata } from "../triggers/types.ts";
import { triggerAction } from "./trigger.ts";

const AGENT_ID = stringToUuid("trigger-create-test-agent");
const USER_ID = stringToUuid("trigger-create-test-user");
const CHAT_ROOM_ID = stringToUuid("trigger-create-chat-room");
const AUTONOMY_ROOM_ID = stringToUuid("trigger-create-autonomy-room");

interface CreatedTask {
  name: string;
  description?: string;
  roomId?: UUID;
  tags?: string[];
  metadata: TriggerTaskMetadata;
}

function makeRuntime(opts: { enableAutonomy: boolean }): {
  runtime: IAgentRuntime;
  createdTasks: CreatedTask[];
} {
  const createdTasks: CreatedTask[] = [];
  const runtime = {
    agentId: AGENT_ID,
    enableAutonomy: opts.enableAutonomy,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getSetting: () => undefined,
    getService: (name: string) =>
      name === AUTONOMY_SERVICE_TYPE
        ? { getAutonomousRoomId: () => AUTONOMY_ROOM_ID }
        : null,
    getTasks: vi.fn(async () => [] as Task[]),
    getTask: vi.fn(async () => null),
    createTask: vi.fn(async (task: CreatedTask) => {
      createdTasks.push(task);
      return stringToUuid(`created-${createdTasks.length}`);
    }),
    updateTask: vi.fn(async () => undefined),
  } as unknown as IAgentRuntime;
  return { runtime, createdTasks };
}

function makeMessage(text: string): Memory {
  return {
    id: stringToUuid(`msg-${text.slice(0, 24)}`),
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: CHAT_ROOM_ID,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

async function create(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  text = "remind me to drink water",
) {
  return triggerAction.handler(runtime, makeMessage(text), undefined, {
    parameters: { action: "create", ...parameters },
  });
}

describe("TRIGGER create — prompt-kind reminders", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("creates a prompt-kind once trigger from delaySeconds with autonomy off", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const before = Date.now();
    const result = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks).toHaveLength(1);
    const trigger = createdTasks[0].metadata.trigger;
    expect(trigger?.kind).toBe("prompt");
    expect(trigger?.triggerType).toBe("once");
    const at = Date.parse(trigger?.scheduledAtIso ?? "");
    expect(at).toBeGreaterThanOrEqual(before + 89_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 91_000);
  });

  it("delivers reminders to the originating room, not the autonomy room", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: true });
    const result = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 60,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].roomId).toBe(CHAT_ROOM_ID);
  });

  it("converts delayMinutes when delaySeconds is absent", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const before = Date.now();
    const result = await create(runtime, {
      instructions: "stretch",
      delayMinutes: 5,
    });
    expect(result?.success).toBe(true);
    const at = Date.parse(
      createdTasks[0].metadata.trigger?.scheduledAtIso ?? "",
    );
    expect(at).toBeGreaterThanOrEqual(before + 299_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 301_000);
  });

  it("accepts numeric-string delaySeconds (planner args arrive as strings)", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "call mom",
      delaySeconds: "120",
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger?.triggerType).toBe("once");
  });

  it("prefers an explicit scheduledAtIso over a relative delay", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const explicit = new Date(Date.now() + 3_600_000).toISOString();
    const result = await create(runtime, {
      instructions: "meeting",
      scheduledAtIso: explicit,
      delaySeconds: 90,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger?.scheduledAtIso).toBe(explicit);
  });

  it("rejects a non-positive delay with a structured failure", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "noop",
      delaySeconds: 0,
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_DELAY");
    expect(createdTasks).toHaveLength(0);
  });

  it("rejects a sub-minute fractional delayMinutes instead of scheduling 'now'", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "noop",
      delayMinutes: 0.5,
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_DELAY");
    expect(createdTasks).toHaveLength(0);
  });

  it("rejects a past explicit scheduledAtIso instead of creating a dead task", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "meeting",
      scheduledAtIso: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_SCHEDULE");
    expect(createdTasks).toHaveLength(0);
  });

  it("keeps the delay one-shot even when the model contradicts with triggerType interval", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "hydrate",
      triggerType: "interval",
      delaySeconds: 90,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger?.triggerType).toBe("once");
  });

  it("dedupes an identical delay-derived reminder (planner retry double-emit)", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(first?.success).toBe(true);
    const firstTrigger = createdTasks[0].metadata.trigger;
    // Second identical call sees the first trigger as an existing task.
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("existing-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: { updatedAt: Date.now(), trigger: firstTrigger },
      } as unknown as Task,
    ]);
    const second = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(second?.success).toBe(true);
    expect(second?.data?.duplicateTaskId).toBeDefined();
    expect(createdTasks).toHaveLength(1);
  });
});

describe("TRIGGER handler — silent, planner-voiced acks (#16863)", () => {
  it("never invokes the user-visible callback on a successful create", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const callback = vi.fn(async () => []);
    const result = await triggerAction.handler(
      runtime,
      makeMessage("remind me to stretch"),
      undefined,
      {
        parameters: {
          action: "create",
          instructions: "stretch",
          delaySeconds: 45,
        },
      },
      callback,
    );
    expect(result?.success).toBe(true);
    expect(createdTasks).toHaveLength(1);
    // The planner's final message is the single user-facing ack; a handler
    // callback here double-posted the mechanical result seconds before it.
    expect(callback).not.toHaveBeenCalled();
  });

  it("returns the invalid-op failure without echoing it to chat", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    const callback = vi.fn(async () => []);
    const result = await triggerAction.handler(
      runtime,
      makeMessage("do something"),
      undefined,
      { parameters: { action: "explode" } },
      callback,
    );
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("TRIGGER_INVALID");
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("TRIGGER create — workflow triggers", () => {
  it("still requires the autonomy loop for workflow triggers", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "run the report workflow",
      workflowId: "wf-1",
      delaySeconds: 60,
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("AUTONOMY_OFF");
    expect(createdTasks).toHaveLength(0);
  });

  it("creates a workflow-kind trigger into the autonomy room when autonomy is on", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: true });
    const result = await create(runtime, {
      instructions: "run the report workflow",
      workflowId: "wf-1",
      workflowName: "Report",
      intervalMs: 3_600_000,
    });
    expect(result?.success).toBe(true);
    const trigger = createdTasks[0].metadata.trigger;
    expect(trigger?.kind).toBe("workflow");
    expect(trigger?.kind === "workflow" ? trigger.workflowId : undefined).toBe(
      "wf-1",
    );
    expect(createdTasks[0].roomId).toBe(AUTONOMY_ROOM_ID);
  });

  it("creates a valid cron trigger", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: true });
    const result = await create(runtime, {
      instructions: "run the report workflow",
      workflowId: "wf-1",
      cronExpression: "0 9 * * 1-5",
    });

    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger).toMatchObject({
      triggerType: "cron",
      cronExpression: "0 9 * * 1-5",
    });
  });

  it("rejects an invalid cron expression without creating a task", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: true });
    const result = await create(runtime, {
      instructions: "run the report workflow",
      workflowId: "wf-1",
      triggerType: "cron",
      cronExpression: "not a cron",
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_CRON");
    expect(createdTasks).toHaveLength(0);
  });
});

describe("TRIGGER lifecycle", () => {
  it("resolves a task UUID and accepts a string boolean when toggling", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    await create(runtime, { instructions: "drink water", delaySeconds: 90 });
    const taskId = stringToUuid("existing-trigger-task");
    vi.mocked(runtime.getTask).mockResolvedValue({
      id: taskId,
      name: createdTasks[0].name,
      tags: createdTasks[0].tags,
      metadata: createdTasks[0].metadata,
    } as Task);

    const result = await triggerAction.handler(
      runtime,
      makeMessage("enable my reminder"),
      undefined,
      { parameters: { action: "toggle", taskId, enabled: "yes" } },
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.enabled).toBe(true);
    expect(runtime.updateTask).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ metadata: expect.any(Object) }),
    );
  });
});

describe("TRIGGER update / delete / toggle — lifecycle ops (#16863)", () => {
  const LIFECYCLE_TASK_ID = stringToUuid("trigger-lifecycle-task");

  function makePromptTrigger(
    overrides: Partial<PromptTriggerConfig> = {},
  ): PromptTriggerConfig {
    return {
      version: TRIGGER_SCHEMA_VERSION,
      triggerId: stringToUuid("trigger-lifecycle-config"),
      displayName: "Trigger: water the plants",
      instructions: "water the plants",
      triggerType: "interval",
      enabled: true,
      wakeMode: "inject_now",
      createdBy: String(USER_ID),
      runCount: 0,
      intervalMs: 3_600_000,
      kind: "prompt",
      ...overrides,
    };
  }

  function makeTriggerTask(trigger: PromptTriggerConfig): Task {
    return {
      id: LIFECYCLE_TASK_ID,
      name: "TRIGGER_DISPATCH",
      description: trigger.displayName,
      roomId: CHAT_ROOM_ID,
      tags: ["queue", "repeat", "trigger"],
      metadata: { updatedAt: Date.now(), trigger },
    } as unknown as Task;
  }

  interface TaskPatch {
    description?: string;
    metadata?: TriggerTaskMetadata;
  }

  function makeLifecycleRuntime(tasks: Task[]): {
    runtime: IAgentRuntime;
    updates: Array<{ taskId: UUID; patch: TaskPatch }>;
    deletions: UUID[];
  } {
    const updates: Array<{ taskId: UUID; patch: TaskPatch }> = [];
    const deletions: UUID[] = [];
    const runtime = {
      agentId: AGENT_ID,
      enableAutonomy: false,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      getSetting: () => undefined,
      getService: () => null,
      getTask: vi.fn(async (id: UUID) => tasks.find((t) => t.id === id)),
      getTasks: vi.fn(async () => tasks),
      updateTask: vi.fn(async (taskId: UUID, patch: TaskPatch) => {
        updates.push({ taskId, patch });
      }),
      deleteTask: vi.fn(async (taskId: UUID) => {
        deletions.push(taskId);
      }),
    } as unknown as IAgentRuntime;
    return { runtime, updates, deletions };
  }

  async function dispatch(
    runtime: IAgentRuntime,
    parameters: ActionParameters,
  ) {
    return triggerAction.handler(
      runtime,
      makeMessage("manage my triggers"),
      undefined,
      { parameters },
    );
  }

  it("update patches displayName and interval and persists a recomputed schedule", async () => {
    const { runtime, updates } = makeLifecycleRuntime([
      makeTriggerTask(makePromptTrigger()),
    ]);
    const before = Date.now();
    const result = await dispatch(runtime, {
      action: "update",
      taskId: LIFECYCLE_TASK_ID,
      displayName: "Trigger: hydrate",
      intervalMs: 120_000,
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toBe('Updated trigger "Trigger: hydrate".');
    expect(updates).toHaveLength(1);
    expect(updates[0].taskId).toBe(LIFECYCLE_TASK_ID);
    expect(updates[0].patch.description).toBe("Trigger: hydrate");
    const next = updates[0].patch.metadata?.trigger;
    expect(next?.displayName).toBe("Trigger: hydrate");
    expect(next?.intervalMs).toBe(120_000);
    // buildTriggerMetadata re-armed the schedule off the new interval.
    expect(next?.nextRunAtMs).toBeGreaterThanOrEqual(before + 120_000);
  });

  it("update fails structurally on a missing or unknown taskId without persisting", async () => {
    const { runtime, updates } = makeLifecycleRuntime([]);
    const missing = await dispatch(runtime, {
      action: "update",
      taskId: stringToUuid("no-such-task"),
      displayName: "whatever",
    });
    expect(missing?.success).toBe(false);
    expect(missing?.error).toBe("TRIGGER_NOT_FOUND");

    const noId = await dispatch(runtime, {
      action: "update",
      displayName: "whatever",
    });
    expect(noId?.success).toBe(false);
    expect(noId?.error).toBe("MISSING_TASK_ID");
    expect(updates).toHaveLength(0);
  });

  it("delete resolves the trigger by displayName fragment and removes its task", async () => {
    const { runtime, deletions } = makeLifecycleRuntime([
      makeTriggerTask(makePromptTrigger()),
    ]);
    const result = await dispatch(runtime, {
      action: "delete",
      displayName: "water the plants",
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toBe('Deleted trigger "Trigger: water the plants".');
    expect(deletions).toEqual([LIFECYCLE_TASK_ID]);
  });

  it("delete reports TRIGGER_NOT_FOUND when no triggers exist", async () => {
    const { runtime, deletions } = makeLifecycleRuntime([]);
    const result = await dispatch(runtime, {
      action: "delete",
      displayName: "anything",
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("TRIGGER_NOT_FOUND");
    expect(result?.text).toBe("No triggers exist.");
    expect(deletions).toHaveLength(0);
  });

  it("toggle flips a disabled trigger back on and persists the re-armed schedule", async () => {
    const { runtime, updates } = makeLifecycleRuntime([
      makeTriggerTask(makePromptTrigger({ enabled: false })),
    ]);
    const result = await dispatch(runtime, {
      action: "toggle",
      taskId: LIFECYCLE_TASK_ID,
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toBe('Enabled trigger "Trigger: water the plants".');
    expect(result?.data?.enabled).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.metadata?.trigger?.enabled).toBe(true);
  });
});

describe("TRIGGER effect receipts — completion-claim grounding", () => {
  it("binds a fresh create to an applied receipt with the canonical ack text", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      triggerType: "cron",
      cronExpression: "0 8 * * *",
    });
    if (!result) throw new Error("expected a result");
    expect(result.success).toBe(true);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.userFacingText).toBe(result.text);
    const receipt = result.effectReceipts?.[0];
    expect(receipt).toMatchObject({
      operation: "trigger.create",
      outcome: "applied",
      resource: { kind: "trigger.task", id: String(result.data?.taskId) },
      idempotency: { key: result.data?.dedupeKey, replayed: false },
    });
    expect(result.userFacingEffectReceiptIds).toEqual([receipt?.receiptId]);
    expect(hasAppliedUserFacingEffectProof(result)).toBe(true);
    expect(createdTasks).toHaveLength(1);
  });

  it("grounds the already-exists dedupe as a replayed no-op — success, not a lie", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(first?.success).toBe(true);
    const firstTrigger = createdTasks[0].metadata.trigger;
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("existing-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: { updatedAt: Date.now(), trigger: firstTrigger },
      } as unknown as Task,
    ]);
    const second = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    if (!second) throw new Error("expected a result");
    expect(second.success).toBe(true);
    expect(second.verifiedUserFacing).toBe(true);
    expect(second.userFacingText).toBe("Already set — you're covered.");
    expect(second.effectReceipts?.[0]).toMatchObject({
      operation: "trigger.create",
      outcome: "noop",
      resource: {
        kind: "trigger.task",
        id: String(second.data?.duplicateTaskId),
      },
      idempotency: { key: second.data?.dedupeKey, replayed: true },
    });
    // The replayed no-op is committed desired-state proof: the truthful
    // "already covered" ack passes the planned-reply egress verifier instead
    // of being swapped for the unverified-effect fallback.
    expect(hasAppliedUserFacingEffectProof(second)).toBe(true);
    expect(createdTasks).toHaveLength(1);
  });

  it("refuses to claim success for a failed create — no receipts, no verified text", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      triggerType: "cron",
      cronExpression: "not a cron",
    });
    if (!result) throw new Error("expected a result");
    expect(result.success).toBe(false);
    expect(result.effectReceipts).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(hasAppliedUserFacingEffectProof(result)).toBe(false);
    expect(createdTasks).toHaveLength(0);
  });

  it("binds delete to an applied receipt for the removed task", async () => {
    const taskId = stringToUuid("receipt-delete-task");
    const task = {
      id: taskId,
      name: "TRIGGER_DISPATCH",
      description: "Trigger: water the plants",
      roomId: CHAT_ROOM_ID,
      tags: ["queue", "repeat", "trigger"],
      metadata: {
        updatedAt: Date.now(),
        trigger: {
          version: TRIGGER_SCHEMA_VERSION,
          triggerId: stringToUuid("receipt-delete-config"),
          displayName: "Trigger: water the plants",
          instructions: "water the plants",
          triggerType: "interval",
          enabled: true,
          wakeMode: "inject_now",
          createdBy: String(USER_ID),
          runCount: 0,
          intervalMs: 3_600_000,
          kind: "prompt",
        },
      },
    } as unknown as Task;
    const runtime = {
      agentId: AGENT_ID,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      getSetting: () => undefined,
      getService: () => null,
      getTask: async (id: UUID) => (id === taskId ? task : null),
      getTasks: async () => [task],
      deleteTask: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
    const result = await triggerAction.handler(
      runtime,
      makeMessage("delete the plants trigger"),
      undefined,
      { parameters: { action: "delete", taskId } },
    );
    if (!result) throw new Error("expected a result");
    expect(result.success).toBe(true);
    expect(result.userFacingText).toBe(result.text);
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: "trigger.delete",
      outcome: "applied",
      resource: { kind: "trigger.task", id: String(taskId) },
    });
    expect(hasAppliedUserFacingEffectProof(result)).toBe(true);
  });
});
