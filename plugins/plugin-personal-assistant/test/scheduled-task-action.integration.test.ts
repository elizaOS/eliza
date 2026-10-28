/**
 * `SCHEDULED_TASK` action unit tests.
 *
 * Drives the umbrella action through its main verbs (create, list, complete,
 * snooze) against a real `LifeOpsRepository`-backed runner via the same
 * runtime helper used by other lifeops action tests. No LLM. No mocks for
 * the runner — the action talks to the production wiring and we assert the
 * round-trip.
 */

import type {
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  Memory,
  Room,
  UUID,
} from "@elizaos/core";
import {
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  executePlannedToolCall,
  validateToolArgs,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduledTaskAction } from "../src/actions/scheduled-task.ts";
import type { ScheduledTask } from "../src/lifeops/scheduled-task/index.ts";
import { getScheduledTaskRunner } from "../src/lifeops/scheduled-task/service.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

function ownerMessage(agentId: UUID, text: string): Memory {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}` as UUID,
    entityId: agentId,
    roomId: agentId,
    agentId,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

// Owner-chat reminder creates delegate to the OWNER_REMINDERS definition flow
// (routing contract in scheduled-task.ts); only autonomy-sourced messages keep
// the raw scheduler surface this file exercises. Creates therefore arrive as
// autonomy messages, the way background automations schedule their own work.
function autonomyMessage(agentId: UUID, text: string): Memory {
  const message = ownerMessage(agentId, text);
  message.content.source = "autonomy";
  return message;
}

function receipt(result: ActionResult | undefined): EffectReceipt {
  expect(result?.effectReceipts).toHaveLength(1);
  const value = result?.effectReceipts?.[0];
  if (!value) throw new Error("expected one effect receipt");
  expect(result?.userFacingEffectReceiptIds).toEqual([value.receiptId]);
  return value;
}

describe("SCHEDULED_TASK action", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("create → list → complete → snooze round-trip via the registered runner", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const created = await scheduledTaskAction.handler?.(
      runtime,
      autonomyMessage(runtime.agentId, "schedule a reminder"),
      undefined,
      {
        parameters: {
          subaction: "create",
          kind: "reminder",
          promptInstructions: "drink a glass of water",
          trigger: { kind: "manual" },
          priority: "medium",
        },
      },
      undefined,
      [],
    );
    expect(created?.success).toBe(true);
    expect(receipt(created)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.scheduled_task.create",
      commit: { kind: "durable", id: expect.any(String) },
    });
    const createdTask = (created?.data as { task?: ScheduledTask } | undefined)
      ?.task;
    expect(createdTask?.kind).toBe("reminder");
    expect(createdTask?.state.status).toBe("scheduled");
    const taskId = createdTask?.taskId;
    if (!taskId) throw new Error("create did not return a taskId");

    // list
    const listed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "what scheduled tasks do i have?"),
      undefined,
      { parameters: { subaction: "list", kind: "reminder" } },
      undefined,
      [],
    );
    expect(listed?.success).toBe(true);
    expect(receipt(listed)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.scheduled_task.list",
    });
    const tasks = (listed?.data as { tasks?: ScheduledTask[] } | undefined)
      ?.tasks;
    if (!tasks) throw new Error("list did not return scheduled tasks");
    expect(tasks.some((task) => task.taskId === taskId)).toBe(true);

    // snooze 30m
    const snoozed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "snooze it"),
      undefined,
      { parameters: { subaction: "snooze", taskId, minutes: 30 } },
      undefined,
      [],
    );
    expect(snoozed?.success).toBe(true);
    expect(receipt(snoozed)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.scheduled_task.snooze",
      resource: { id: taskId },
      commit: { kind: "durable", id: expect.any(String) },
    });
    const snoozedTask = (snoozed?.data as { task?: ScheduledTask } | undefined)
      ?.task;
    expect(snoozedTask?.state.lastDecisionLog).toMatch(/snoozed until/);

    // complete
    const completed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "done"),
      undefined,
      { parameters: { subaction: "complete", taskId, reason: "done by user" } },
      undefined,
      [],
    );
    expect(completed?.success).toBe(true);
    expect(receipt(completed)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.scheduled_task.complete",
      resource: { id: taskId },
      commit: { kind: "durable", id: expect.any(String) },
    });
    const completedTask = (
      completed?.data as { task?: ScheduledTask } | undefined
    )?.task;
    expect(completedTask?.state.status).toBe("completed");
  });

  it("reads an offset-free once time in the message's time zone, not the host's", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    // CURRENT_TIME shows the user's zone, so "Monday 9am" arrives as 09:00
    // with no offset. New York is on EST (-05:00) after 2026-11-01.
    const message = autonomyMessage(runtime.agentId, "remind me monday 9am");
    message.content.metadata = { uiTimeZone: "America/New_York" };

    const created = await scheduledTaskAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          subaction: "create",
          kind: "reminder",
          promptInstructions: "call the dentist",
          trigger: { kind: "once", atIso: "2026-11-02T09:00:00" },
          priority: "medium",
        },
      },
      undefined,
      [],
    );

    expect(created?.success).toBe(true);
    const task = (created?.data as { task?: ScheduledTask } | undefined)?.task;
    expect(task?.trigger).toEqual({
      kind: "once",
      atIso: "2026-11-02T14:00:00.000Z",
    });
  });

  it("proves mutation preconditions, replay noops, and every ledger-backed transition", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const idempotencyKey = `scheduled-receipt-${crypto.randomUUID()}`;
    const parameters = {
      subaction: "create",
      kind: "custom",
      promptInstructions: "exercise every receipt-backed transition",
      trigger: { kind: "manual" },
      priority: "medium",
      idempotencyKey,
    };
    const created = await scheduledTaskAction.handler?.(
      runtime,
      autonomyMessage(runtime.agentId, "create transition test task"),
      undefined,
      { parameters },
      undefined,
      [],
    );
    expect(created?.success).toBe(true);
    expect(receipt(created).outcome).toBe("applied");
    const task = (created?.data as { task?: ScheduledTask } | undefined)?.task;
    if (!task) throw new Error("create did not return a task");

    const duplicate = await scheduledTaskAction.handler?.(
      runtime,
      autonomyMessage(runtime.agentId, "retry transition test task"),
      undefined,
      { parameters },
      undefined,
      [],
    );
    expect(duplicate?.success).toBe(true);
    expect(receipt(duplicate)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.scheduled_task.create",
      resource: { id: task.taskId },
      idempotency: { key: idempotencyKey, replayed: true },
    });

    const updated = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "make it important"),
      undefined,
      {
        parameters: {
          subaction: "update",
          taskId: task.taskId,
          patch: { priority: "high" },
        },
      },
      undefined,
      [],
    );
    expect(updated?.success).toBe(true);
    expect(receipt(updated)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.scheduled_task.update",
      resource: { id: task.taskId },
      idempotency: { key: null, replayed: false },
    });

    const unchanged = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "keep it important"),
      undefined,
      {
        parameters: {
          subaction: "update",
          taskId: task.taskId,
          patch: { priority: "high" },
        },
      },
      undefined,
      [],
    );
    expect(unchanged?.success).toBe(true);
    expect(receipt(unchanged)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.scheduled_task.update",
      resource: { id: task.taskId },
    });

    const completed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "finish it"),
      undefined,
      { parameters: { subaction: "complete", taskId: task.taskId } },
      undefined,
      [],
    );
    expect(receipt(completed).outcome).toBe("applied");

    const completeReplay = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "finish it again"),
      undefined,
      { parameters: { subaction: "complete", taskId: task.taskId } },
      undefined,
      [],
    );
    expect(completeReplay?.success).toBe(true);
    expect(receipt(completeReplay)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.scheduled_task.complete",
    });

    const closedSnooze = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "snooze the closed task"),
      undefined,
      {
        parameters: {
          subaction: "snooze",
          taskId: task.taskId,
          minutes: 5,
        },
      },
      undefined,
      [],
    );
    expect(closedSnooze?.success).toBe(false);
    expect(receipt(closedSnooze)).toMatchObject({
      outcome: "failed",
      operation: "lifeops.scheduled_task.snooze",
      failure: { code: "INVALID_STATE_TRANSITION" },
    });

    const reopened = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "reopen it"),
      undefined,
      { parameters: { subaction: "reopen", taskId: task.taskId } },
      undefined,
      [],
    );
    expect(reopened?.success).toBe(true);
    expect(receipt(reopened)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.scheduled_task.reopen",
    });

    const cancelled = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "cancel it"),
      undefined,
      { parameters: { subaction: "cancel", taskId: task.taskId } },
      undefined,
      [],
    );
    expect(cancelled?.success).toBe(true);
    expect(receipt(cancelled)).toMatchObject({
      outcome: "applied",
      operation: "lifeops.scheduled_task.cancel",
    });

    const cancelReplay = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "cancel it again"),
      undefined,
      { parameters: { subaction: "cancel", taskId: task.taskId } },
      undefined,
      [],
    );
    expect(cancelReplay?.success).toBe(true);
    expect(receipt(cancelReplay)).toMatchObject({
      outcome: "noop",
      operation: "lifeops.scheduled_task.cancel",
    });
  }, 120_000);

  it("authorizes before storage and binds a connector task to the attested chat destination", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const ownerId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId);
    await runtime.createWorld({
      id: runtime.agentId,
      name: "Connector scheduling test",
      agentId: runtime.agentId,
      serverId: "telegram-scheduling-test",
    });
    await runtime.createEntity({
      id: ownerId,
      names: ["Owner"],
      agentId: runtime.agentId,
    });
    await runtime.createRoom({
      id: roomId,
      source: "telegram",
      channelId: "owner-chat-42",
      type: ChannelType.DM,
      worldId: runtime.agentId,
      metadata: { accountId: "personal" },
    } as Room);
    await runtime.addParticipant(ownerId, roomId);
    await runtime.addParticipant(runtime.agentId, roomId);

    const message = {
      id: crypto.randomUUID() as UUID,
      entityId: ownerId,
      roomId,
      agentId: runtime.agentId,
      content: { text: "run my private check later", source: "telegram" },
      createdAt: Date.now(),
    } as Memory;
    await attestDeliveryAudienceFromCanonicalRoom(runtime, message);
    const bindingIdempotencyKey = `bound-${crypto.randomUUID()}`;
    const result = await executePlannedToolCall(
      runtime,
      { message, userRoles: ["OWNER"], activeContexts: ["tasks"] },
      {
        name: "SCHEDULED_TASKS",
        params: {
          action: "create",
          kind: "custom",
          promptInstructions: "Run the private check and report the result.",
          trigger: { kind: "manual" },
          output: { destination: "channel", target: "discord:public-room" },
          idempotencyKey: bindingIdempotencyKey,
        },
      },
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    // The supplied Discord destination is not applied, and the result says so.
    expect(result.data).toMatchObject({
      outputIgnored: true,
      boundOutput: { destination: "channel", target: "telegram:owner-chat-42" },
    });
    expect(result.text).toContain("telegram chat");
    const task = (result.data as { task?: ScheduledTask } | undefined)?.task;
    expect(task?.output).toEqual({
      destination: "channel",
      target: "telegram:owner-chat-42",
    });
    expect(task?.metadata?.chatDeliveryBinding).toMatchObject({
      version: 1,
      source: "telegram",
      roomId,
      channelId: "owner-chat-42",
      audience: {
        kind: "direct",
        provenance: "canonical_room",
        ownerEntityId: ownerId,
        agentEntityId: runtime.agentId,
      },
    });

    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });

    const poisonedUpdate = await executePlannedToolCall(
      runtime,
      { message, userRoles: ["OWNER"], activeContexts: ["tasks"] },
      {
        name: "SCHEDULED_TASKS",
        params: {
          action: "update",
          taskId: task?.taskId,
          patch: {
            promptInstructions: "Run the updated private check.",
            output: { destination: "channel", target: "discord:public-room" },
            metadata: { chatDeliveryBinding: { version: 999 } },
          },
        },
      },
    );
    expect(poisonedUpdate.success).toBe(true);
    expect(poisonedUpdate.data).toMatchObject({ outputIgnored: true });
    expect(poisonedUpdate.text).toContain("telegram chat");

    // A patch whose only change is the pinned destination changes nothing.
    for (const output of [
      { destination: "channel", target: "discord:public-room" },
      {},
      null,
    ]) {
      const outputOnlyUpdate = await executePlannedToolCall(
        runtime,
        { message, userRoles: ["OWNER"], activeContexts: ["tasks"] },
        {
          name: "SCHEDULED_TASKS",
          params: {
            action: "update",
            taskId: task?.taskId,
            patch: {
              output,
            },
          },
        },
      );
      expect(outputOnlyUpdate.success).toBe(false);
      expect(outputOnlyUpdate.data).toMatchObject({
        error: "OUTPUT_BOUND_TO_CHAT",
      });
    }
    const protectedTask = (await runner.list()).find(
      (candidate) => candidate.taskId === task?.taskId,
    );
    expect(protectedTask?.promptInstructions).toBe(
      "Run the updated private check.",
    );
    expect(protectedTask?.output).toEqual({
      destination: "channel",
      target: "telegram:owner-chat-42",
    });
    expect(protectedTask?.metadata?.chatDeliveryBinding).toMatchObject({
      version: 1,
      roomId,
    });

    // The same content and planner idempotency key in a second account/room is
    // a distinct delivery, not a duplicate of the first DM.
    const secondRoomId = crypto.randomUUID() as UUID;
    await runtime.createRoom({
      id: secondRoomId,
      source: "telegram",
      channelId: "owner-chat-99",
      type: ChannelType.DM,
      worldId: runtime.agentId,
      metadata: { accountId: "work" },
    } as Room);
    await runtime.addParticipant(ownerId, secondRoomId);
    await runtime.addParticipant(runtime.agentId, secondRoomId);
    const secondMessage = {
      ...message,
      id: crypto.randomUUID() as UUID,
      roomId: secondRoomId,
    } as Memory;
    await attestDeliveryAudienceFromCanonicalRoom(runtime, secondMessage);
    const secondCreate = await executePlannedToolCall(
      runtime,
      {
        message: secondMessage,
        userRoles: ["OWNER"],
        activeContexts: ["tasks"],
      },
      {
        name: "SCHEDULED_TASKS",
        params: {
          action: "create",
          kind: "custom",
          promptInstructions: "Run the private check and report the result.",
          trigger: { kind: "manual" },
          idempotencyKey: bindingIdempotencyKey,
        },
      },
    );
    expect(secondCreate.success).toBe(true);
    const secondTask = (
      secondCreate.data as { task?: ScheduledTask } | undefined
    )?.task;
    expect(secondTask?.taskId).not.toBe(task?.taskId);
    expect(secondTask?.output?.target).toBe("telegram:owner-chat-99");
    expect(secondTask?.metadata?.chatDeliveryBinding).toMatchObject({
      roomId: secondRoomId,
    });

    // Owner-only first-party/API rooms use the same audience attestation as a
    // connector DM, but must retain their in-app output and public planner key.
    const apiRoomId = crypto.randomUUID() as UUID;
    await runtime.createRoom({
      id: apiRoomId,
      source: "telegram",
      // First-party/scenario rooms can inherit the preferred connector source
      // while retaining the internal room id as their synthetic channel id.
      channelId: apiRoomId,
      type: ChannelType.DM,
      worldId: runtime.agentId,
    } as Room);
    await runtime.addParticipant(ownerId, apiRoomId);
    await runtime.addParticipant(runtime.agentId, apiRoomId);
    const apiMessage = {
      ...message,
      id: crypto.randomUUID() as UUID,
      roomId: apiRoomId,
      content: { text: "schedule an internal check", source: "telegram" },
    } as Memory;
    await attestDeliveryAudienceFromCanonicalRoom(runtime, apiMessage);
    const apiIdempotencyKey = `api-${crypto.randomUUID()}`;
    const apiCreate = await executePlannedToolCall(
      runtime,
      { message: apiMessage, userRoles: ["OWNER"], activeContexts: ["tasks"] },
      {
        name: "SCHEDULED_TASKS",
        params: {
          action: "create",
          kind: "custom",
          promptInstructions: "Run the internal check.",
          trigger: { kind: "manual" },
          output: { destination: "in_app" },
          idempotencyKey: apiIdempotencyKey,
        },
      },
    );
    expect(apiCreate.success).toBe(true);
    const apiTask = (apiCreate.data as { task?: ScheduledTask } | undefined)
      ?.task;
    expect(apiTask?.idempotencyKey).toBe(apiIdempotencyKey);
    expect(apiTask?.output?.target).toMatch(/^in_app:/);
    expect(apiTask?.metadata?.chatDeliveryBinding).toBeUndefined();

    const before = (await runner.list()).length;
    const deniedMessage = { ...message, id: crypto.randomUUID() as UUID };
    await attestDeliveryAudienceFromCanonicalRoom(runtime, deniedMessage);
    const guestId = crypto.randomUUID() as UUID;
    await runtime.createEntity({
      id: guestId,
      names: ["Guest"],
      agentId: runtime.agentId,
    });
    await runtime.addParticipant(guestId, roomId);
    const denied = await executePlannedToolCall(
      runtime,
      {
        message: deniedMessage,
        userRoles: ["OWNER"],
        activeContexts: ["tasks"],
      },
      {
        name: "SCHEDULED_TASKS",
        params: {
          action: "create",
          kind: "custom",
          promptInstructions: "Must not persist.",
          trigger: { kind: "manual" },
          idempotencyKey: `denied-${crypto.randomUUID()}`,
        },
      },
    );
    expect(denied.success).toBe(false);
    expect((await runner.list()).length).toBe(before);
  }, 120_000);

  it("binds one callback to the validated receipt through the canonical executor", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const callback = vi.fn<HandlerCallback>(async () => []);
    const message = autonomyMessage(
      runtime.agentId,
      "create an executor receipt task",
    );
    // Owner-private actions require an attested delivery audience
    // (disclosureGate stamped by ownerPrivateAction at plugin assembly).
    // Production always attests before the executor runs — handleMessage
    // attests every inbound turn from canonical room state — so mirror that
    // seam here. The runtime provisions its own SELF room (id = agentId, agent
    // as sole participant) at initialize, and the agent-actor turn clears the
    // gate via the internal_agent_turn basis.
    await attestDeliveryAudienceFromCanonicalRoom(runtime, message);
    const result = await executePlannedToolCall(
      runtime,
      {
        message,
        callback,
        userRoles: ["OWNER"],
        activeContexts: ["tasks"],
      },
      {
        name: "SCHEDULED_TASKS",
        params: {
          action: "create",
          kind: "custom",
          promptInstructions: "prove the scheduler executor receipt",
          trigger: { kind: "manual" },
          idempotencyKey: `executor-scheduled-${crypto.randomUUID()}`,
        },
      },
    );

    const applied = receipt(result);
    expect(applied).toMatchObject({
      outcome: "applied",
      operation: "lifeops.scheduled_task.create",
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      text: result.text,
      effectReceiptIds: [applied.receiptId],
    });
  }, 120_000);

  it("rejects missing-subaction calls cleanly", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const result = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "do something"),
      undefined,
      { parameters: {} },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string } | undefined)?.error).toBe(
      "MISSING_SUBACTION",
    );
  });

  it("rejects malformed LLM-supplied gate structure before writing a row (#11791)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const result = await scheduledTaskAction.handler?.(
      runtime,
      autonomyMessage(runtime.agentId, "schedule a gated reminder"),
      undefined,
      {
        parameters: {
          subaction: "create",
          kind: "reminder",
          promptInstructions: "drink a glass of water",
          trigger: { kind: "manual" },
          priority: "medium",
          shouldFire: {
            gates: [{ kind: "not_registered", params: {} }],
          },
        },
      },
      undefined,
      [],
    );

    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string } | undefined)?.error).toBe(
      "INVALID_SCHEDULED_TASK",
    );
    expect(
      JSON.stringify(
        (result?.data as { issues?: string[] } | undefined)?.issues,
      ),
    ).toContain("not_registered");

    const listed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "list scheduled tasks"),
      undefined,
      { parameters: { subaction: "list" } },
      undefined,
      [],
    );
    const tasks = (listed?.data as { tasks?: ScheduledTask[] } | undefined)
      ?.tasks;
    if (!tasks) throw new Error("list did not return scheduled tasks");
    // First-run defaults seed check-in/watcher/recap/output tasks on a fresh
    // runtime; the rejected create must not have written its reminder row.
    expect(tasks.filter((task) => task.kind === "reminder")).toHaveLength(0);
  });

  it("refuses filter values outside the declared kind, status and subjectKind sets", () => {
    for (const args of [
      { action: "list", status: "pending" },
      { action: "list", kind: "reminders" },
      { action: "create", kind: "habit" },
      { action: "list", subjectKind: "person", subjectId: "p1" },
      { action: "create", source: "chat" },
    ]) {
      expect(validateToolArgs(scheduledTaskAction, args).valid).toBe(false);
    }
    expect(
      validateToolArgs(scheduledTaskAction, {
        action: "list",
        kind: "reminder",
        status: "scheduled",
        subjectKind: "self",
      }).valid,
    ).toBe(true);
  });

  it("update and snooze return a structured refusal for input the runner rejects", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const call = (parameters: Record<string, unknown>) =>
      scheduledTaskAction.handler?.(
        runtime,
        ownerMessage(runtime.agentId, "change that scheduled item"),
        undefined,
        { parameters },
        undefined,
        [],
      );
    const errorOf = (result: ActionResult | undefined) =>
      (result?.data as { error?: string } | undefined)?.error;

    const created = await scheduledTaskAction.handler?.(
      runtime,
      autonomyMessage(runtime.agentId, "schedule a custom task"),
      undefined,
      {
        parameters: {
          action: "create",
          kind: "custom",
          promptInstructions: "review the weekly numbers",
          trigger: { kind: "manual" },
        },
      },
      undefined,
      [],
    );
    const taskId = (created?.data as { task?: ScheduledTask } | undefined)?.task
      ?.taskId;
    if (!taskId) throw new Error("create did not return a taskId");

    // The trigger shape create accepts is accepted on update too.
    const retimed = await call({
      action: "update",
      taskId,
      patch: { trigger: { type: "cron", schedule: "0 8 * * *" } },
    });
    expect(retimed?.success).toBe(true);
    expect(
      (retimed?.data as { task?: ScheduledTask } | undefined)?.task?.trigger,
    ).toMatchObject({ kind: "cron", expression: "0 8 * * *" });

    const badTrigger = await call({
      action: "update",
      taskId,
      patch: { trigger: { kind: "cron" } },
    });
    expect(badTrigger?.success).toBe(false);
    expect(errorOf(badTrigger)).toBe("INVALID_TRIGGER");

    const badGate = await call({
      action: "update",
      taskId,
      patch: {
        shouldFire: { gates: [{ kind: "not_registered", params: {} }] },
      },
    });
    expect(badGate?.success).toBe(false);
    expect(errorOf(badGate)).toBe("INVALID_SCHEDULED_TASK");

    const readOnly = await call({
      action: "update",
      taskId,
      patch: { state: { status: "completed" } },
    });
    expect(readOnly?.success).toBe(false);
    expect(errorOf(readOnly)).toBe("READ_ONLY_FIELD");

    // A key the task does not have changes nothing, so it is refused instead
    // of being reported as an applied edit.
    for (const patch of [
      { atIso: "2027-01-13T09:00:00Z" },
      { text: "Check on the vendor invoice" },
      { dueAt: "2027-01-13T09:00:00Z" },
    ]) {
      const unknownField = await call({ action: "update", taskId, patch });
      expect(unknownField?.success).toBe(false);
      expect(errorOf(unknownField)).toBe("UNKNOWN_PATCH_FIELD");
    }

    // A subject is a kind and an id together; one half alone is refused
    // instead of being dropped from the filter or the new task.
    for (const half of [{ subjectKind: "thread" }, { subjectId: "wt-1" }]) {
      const listed = await call({ action: "list", ...half });
      expect(listed?.success).toBe(false);
      expect(errorOf(listed)).toBe("SUBJECT_INCOMPLETE");
    }
    const halfSubjectCreate = await scheduledTaskAction.handler?.(
      runtime,
      autonomyMessage(runtime.agentId, "schedule a follow-up"),
      undefined,
      {
        parameters: {
          action: "create",
          kind: "followup",
          promptInstructions: "Check on the vendor reply",
          trigger: { kind: "manual" },
          subjectKind: "self",
        },
      },
      undefined,
      [],
    );
    expect(halfSubjectCreate?.success).toBe(false);
    expect(errorOf(halfSubjectCreate)).toBe("SUBJECT_INCOMPLETE");

    // A history bound that is not a timestamp is refused, not read as an
    // empty log.
    const badRange = await call({ action: "history", sinceIso: "yesterday" });
    expect(badRange?.success).toBe(false);
    expect(errorOf(badRange)).toBe("INVALID_HISTORY_RANGE");
    // A bound with an offset is compared as an instant. One hour from now,
    // written at -12:00, has wall-clock text 11 hours before now: as raw text
    // it would sort before every stored UTC row and return nothing.
    const allEntries = (
      (await call({ action: "history", taskId }))?.data as
        | { entries?: unknown[] }
        | undefined
    )?.entries;
    if (!allEntries?.length) throw new Error("history returned no entries");
    const inOneHourAtMinus12 = new Date(Date.now() - 11 * 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "-12:00");
    const bounded = await call({
      action: "history",
      taskId,
      untilHistoryIso: inOneHourAtMinus12,
    });
    expect(
      (bounded?.data as { entries?: unknown[] } | undefined)?.entries,
    ).toHaveLength(allEntries.length);

    for (const target of [{ untilIso: "tomorrow 9am" }, { minutes: 0 }]) {
      const snoozed = await call({ action: "snooze", taskId, ...target });
      expect(snoozed?.success).toBe(false);
      expect(errorOf(snoozed)).toBe("INVALID_SNOOZE_TARGET");
    }

    const stored = await getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    }).list();
    expect(stored.find((task) => task.taskId === taskId)).toMatchObject({
      trigger: { kind: "cron", expression: "0 8 * * *" },
      state: { status: "scheduled" },
    });
  });

  it("get returns NOT_FOUND for an unknown taskId", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const result = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "get task"),
      undefined,
      { parameters: { subaction: "get", taskId: "st_nonexistent" } },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string } | undefined)?.error).toBe(
      "NOT_FOUND",
    );
  });

  // Recap turns ask for history without naming a task; that call used to hard
  // fail MISSING_TASK_ID and derail the whole read-then-summarize turn
  // (#16935). Id-less history now spans all scheduled items.
  it("history without a taskId returns recent entries across all scheduled items", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const taskIds: string[] = [];
    for (const instructions of ["sort the receipts", "reply to Jordan"]) {
      const created = await scheduledTaskAction.handler?.(
        runtime,
        autonomyMessage(runtime.agentId, `remind me to ${instructions}`),
        undefined,
        {
          parameters: {
            subaction: "create",
            kind: "reminder",
            promptInstructions: instructions,
            trigger: { kind: "manual" },
            priority: "medium",
          },
        },
        undefined,
        [],
      );
      expect(created?.success).toBe(true);
      const task = (created?.data as { task?: ScheduledTask } | undefined)
        ?.task;
      if (!task) throw new Error("create did not return a task");
      taskIds.push(task.taskId);
    }
    const completed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "done sorting"),
      undefined,
      {
        parameters: {
          subaction: "complete",
          taskId: taskIds[0],
          reason: "done this morning",
        },
      },
      undefined,
      [],
    );
    expect(completed?.success).toBe(true);

    const history = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "what happened with my reminders today?"),
      undefined,
      { parameters: { subaction: "history" } },
      undefined,
      [],
    );
    expect(history?.success).toBe(true);
    const entries = (
      history?.data as
        | { entries?: Array<{ taskId: string; eventType?: string }> }
        | undefined
    )?.entries;
    if (!entries) throw new Error("history did not return entries");
    // Entries from BOTH tasks are present — the read spans the whole ledger.
    const seenTaskIds = new Set(entries.map((entry) => entry.taskId));
    expect(seenTaskIds.has(taskIds[0])).toBe(true);
    expect(seenTaskIds.has(taskIds[1])).toBe(true);

    // Single-task reads keep their narrowing contract.
    const scoped = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "history for the receipts reminder"),
      undefined,
      { parameters: { subaction: "history", taskId: taskIds[0] } },
      undefined,
      [],
    );
    expect(scoped?.success).toBe(true);
    const scopedEntries = (
      scoped?.data as { entries?: Array<{ taskId: string }> } | undefined
    )?.entries;
    if (!scopedEntries)
      throw new Error("scoped history did not return entries");
    expect(scopedEntries.length).toBeGreaterThan(0);
    expect(scopedEntries.every((entry) => entry.taskId === taskIds[0])).toBe(
      true,
    );
  });
});
