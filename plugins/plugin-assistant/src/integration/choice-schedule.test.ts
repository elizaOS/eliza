/** Exercises actual SQL choice dispatch and owned approval cancellation. */
import assert from "node:assert/strict";
import {
  AgentRuntime,
  type ApprovalResult,
  ApprovalService,
  ChannelType,
  canActionRun,
  createCharacter,
  ElizaError,
  type Memory,
  resolveActionCallerRoles,
  ServiceType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { DrizzleDatabase } from "@elizaos/plugin-sql";
import { taskTable } from "@elizaos/plugin-sql";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../../plugin-sql/src/__tests__/test-helpers";
import { choiceAction } from "../features/basic-capabilities/actions/choice";
import { choiceProvider } from "../features/basic-capabilities/providers/choice";

it("rejects a damaged choice before worker effects while healthy and repaired choices execute", async () => {
  const f = await createIsolatedTestDatabase("choice-schedule-admission");
  const roomId = "11111111-1111-4111-8111-111111111111" as UUID;
  const effects: UUID[] = [];
  try {
    await f.adapter.createRooms([
      {
        id: roomId,
        agentId: f.testAgentId,
        name: "choice",
        source: "test",
        type: ChannelType.GROUP,
      },
    ]);
    f.runtime.registerTaskWorker({
      name: "choice-schedule",
      execute: async (_runtime, _options, task) => {
        if (!task.id) throw new Error("Expected persisted task ID");
        effects.push(task.id);
      },
    });
    const metadata = {
      options: [{ name: "run", description: "Run the task" }],
      scheduledAt: "2026-09-21T09:00:00Z",
    };
    const create = () =>
      f.adapter.createTask({
        name: "choice-schedule",
        roomId,
        tags: ["AWAITING_CHOICE"],
        metadata,
      });
    const healthy = await create();
    const damaged = await create();
    await (f.adapter.getDatabase() as DrizzleDatabase)
      .update(taskTable)
      .set({ metadata: { ...metadata, scheduledAt: "2026-02-30T00:00:00Z" } })
      .where(eq(taskTable.id, damaged));
    const message: Memory = {
      id: "22222222-2222-4222-8222-222222222222" as UUID,
      agentId: f.testAgentId,
      entityId: f.testAgentId,
      roomId,
      content: { text: "run", source: "test" },
    };
    const choose = (taskId: UUID, option = "run") =>
      choiceAction.handler(f.runtime, message, undefined, {
        parameters: { taskId, option },
      });
    // The provider is the planner's only listing of pending choices, so it
    // must print the taskId that CHOOSE_OPTION requires.
    const listing = await choiceProvider.get(f.runtime, message, {
      values: {},
      data: {},
      text: "",
    });
    expect(listing.text).toContain(`(taskId: ${healthy})`);
    expect(listing.text).toContain(`(taskId: ${damaged})`);
    const missed = await choose("choice-schedule" as UUID);
    expect(missed).toMatchObject({
      success: false,
      values: { error: "TASK_NOT_FOUND" },
    });
    expect(missed?.text).toContain(`(taskId: ${healthy})`);
    expect(effects).toEqual([]);
    expect(await choose(healthy, "the first one")).toMatchObject({
      success: false,
      values: { error: "INVALID_OPTION" },
      data: { validOptions: ["run", "ABORT"] },
    });
    expect(effects).toEqual([]);
    expect(await choose(healthy)).toMatchObject({ success: true });
    expect(effects).toEqual([healthy]);
    await expect(choose(damaged)).rejects.toMatchObject({
      code: "TASK_SCHEDULE_INVALID",
    });
    expect(effects).toEqual([healthy]);
    const visible = await f.runtime.getTasks({
      roomId,
      tags: ["AWAITING_CHOICE"],
    });
    expect(
      visible.find((task) => task.id === damaged)?.metadata?.scheduledAt,
    ).toBe("2026-02-30T00:00:00Z");
    await f.adapter.patchTaskMetadata(damaged, {
      set: { scheduledAt: metadata.scheduledAt },
    });
    expect(await choose(damaged)).toMatchObject({ success: true });
    expect(effects).toEqual([healthy, damaged]);
    await (f.adapter.getDatabase() as DrizzleDatabase)
      .update(taskTable)
      .set({ metadata: { ...metadata, scheduledAt: "not-a-date" } })
      .where(eq(taskTable.id, damaged));
    expect(await choose(damaged, "ABORT")).toMatchObject({ success: true });
    expect(await f.runtime.getTask(damaged)).toBeNull();
    expect(effects).toEqual([healthy, damaged]);
  } finally {
    f.runtime.unregisterTaskWorker("choice-schedule");
    await f.cleanup();
  }
});

/** Exercise the actual registered approval owner and choice action over SQLite. */
async function approvalChoiceFixture(onSelect?: () => Promise<void>) {
  const name = "ChoiceApprovalCancellationAgent";
  const runtime = new AgentRuntime({
    character: createCharacter({ name }),
    adapter: SQLiteDatabaseAdapter.create(":memory:", stringToUuid(name)),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  await runtime.initialize();
  await runtime.registerPlugin({
    name: "choice-approval-conformance",
    description: "Actual choice and approval lifecycle",
    services: [ApprovalService],
    actions: [choiceAction],
  });
  const service = (await runtime.getServiceLoadPromise(
    ServiceType.APPROVAL,
  )) as ApprovalService;
  const roomId = stringToUuid("choice-approval-cancellation-room");
  await runtime.adapter.createRooms([
    {
      id: roomId,
      agentId: runtime.agentId,
      name: "Approval cancellation",
      source: "test",
      type: ChannelType.GROUP,
      messageServerId: stringToUuid("choice-approval-cancellation-server"),
    },
  ]);
  const message: Memory = {
    id: stringToUuid("choice-approval-cancellation-message"),
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId,
    content: { text: "Cancel the pending approval", source: "test" },
  };
  const state = { values: {}, data: {}, text: "" };
  const calls: string[] = [];
  let approvalResult: ApprovalResult | undefined;
  const waiting = service
    .requestApproval({
      name: "CHOICE_APPROVAL",
      description: "Confirm the pending operation",
      roomId,
      options: [{ name: "approve" }, { name: "deny", isCancel: true }],
      timeoutMs: 60_000,
      onSelect: async (option) => {
        calls.push(option);
        await onSelect?.();
      },
    })
    .then((result) => {
      approvalResult = result;
      return result;
    });
  await vi.waitFor(() =>
    expect(service.listPendingUserActions()).toHaveLength(1),
  );
  const taskId = service.listPendingUserActions()[0].id as UUID;
  const replies: { text: string | undefined; settled: boolean }[] = [];
  const abort = async () => {
    const roles = await resolveActionCallerRoles(runtime, message);
    expect(roles).toEqual(["OWNER"]);
    expect(
      canActionRun(choiceAction, {
        message,
        userRoles: roles,
        activeContexts: ["tasks"],
      }),
    ).toBe(true);
    expect(await choiceAction.validate(runtime, message, state)).toBe(true);
    return choiceAction.handler(
      runtime,
      message,
      state,
      { parameters: { taskId, option: "ABORT" } },
      async (content) => {
        replies.push({
          text: content.text,
          settled: approvalResult?.cancelled === true,
        });
        return [];
      },
    );
  };
  return {
    runtime,
    service,
    taskId,
    calls,
    waiting,
    result: () => approvalResult,
    replies,
    abort,
    cleanup: async () => {
      vi.restoreAllMocks();
      await runtime.stop();
      await runtime.close();
    },
  };
}

it("ABORT confirms owned SQLite cancellation only after deletion and caller settlement", async () => {
  const f = await approvalChoiceFixture();
  try {
    expect(await f.abort()).toMatchObject({ success: true });
    expect(f.replies).toHaveLength(1);
    expect(f.replies[0].settled).toBe(true);
    expect(await f.waiting).toMatchObject({ cancelled: true, success: false });
    expect(f.calls).toEqual([]);
    expect(f.service.listPendingUserActions()).toEqual([]);
    expect(await f.runtime.getTask(f.taskId)).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it("ABORT retains the SQLite approval owner on deletion failure and retries without effects", async () => {
  const f = await approvalChoiceFixture();
  try {
    const failure = new ElizaError("cancel task delete failed", {
      code: "DB_QUERY_FAILED",
    });
    vi.spyOn(f.runtime.adapter, "deleteTasks").mockRejectedValueOnce(failure);
    await expect(f.abort()).rejects.toBe(failure);
    expect(f.replies).toEqual([]);
    expect(f.service.listPendingUserActions()).toHaveLength(1);
    const row = await f.runtime.getTask(f.taskId);
    assert(row);
    expect(f.result()).toBeUndefined();
    expect(await f.abort()).toMatchObject({ success: true });
    expect(await f.waiting).toMatchObject({ cancelled: true, success: false });
    expect(f.replies).toHaveLength(1);
    expect(f.replies[0].settled).toBe(true);
    expect(f.calls).toEqual([]);
    expect(await f.runtime.getTask(f.taskId)).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it("ABORT refuses an already-claimed SQLite approval without a cancellation receipt", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await approvalChoiceFixture(async () => {
    enter();
    await held;
  });
  try {
    const selecting = f.service.handleSelection(f.taskId, "approve");
    await entered;
    await expect(f.abort()).rejects.toMatchObject({
      code: "APPROVAL_CALLBACK_UNAVAILABLE",
    });
    expect(f.replies).toEqual([]);
    expect(f.result()).toBeUndefined();
    expect(await f.runtime.getTask(f.taskId)).not.toBeNull();
    release();
    await selecting;
    expect(await f.waiting).toMatchObject({
      selectedOption: "approve",
      success: true,
      cancelled: false,
    });
    expect(f.calls).toEqual(["approve"]);
  } finally {
    release();
    await f.cleanup();
  }
});

it("ABORT retains the SQLite approval when its registered owner is unavailable", async () => {
  const f = await approvalChoiceFixture();
  try {
    vi.spyOn(f.runtime, "getService").mockReturnValue(null);
    await expect(f.abort()).rejects.toMatchObject({
      code: "APPROVAL_SERVICE_UNAVAILABLE",
    });
    expect(f.replies).toEqual([]);
    expect(f.result()).toBeUndefined();
    expect(f.service.listPendingUserActions()).toHaveLength(1);
    expect(await f.runtime.getTask(f.taskId)).not.toBeNull();
    expect(f.calls).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
