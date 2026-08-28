/** Verifies the Shared reminder action against its trusted-destination boundary. */

import type { IAgentRuntime, Memory } from "@elizaos/core/edge";
import { describe, expect, it, vi } from "vitest";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRunner,
} from "./scheduled-task/types.js";
import {
  createSharedRemindersEdgePlugin,
  parseSharedReminderDelivery,
  type SharedRemindersEdgePluginOptions,
} from "./shared-reminders.js";

const NOW = "2026-08-14T20:00:00.000Z";
const PRIVATE_DELIVERY = {
  platform: "telegram" as const,
  project: "eliza-app",
  connectorAccountId: "bot:123456789",
  chatId: "123456",
};

function scheduledTask(input: ScheduledTaskInput): ScheduledTask {
  return {
    taskId: "reminder-1",
    ...input,
    state: { status: "scheduled", followupCount: 0 },
  };
}

function reminderInput(
  text: string,
  trigger: ScheduledTaskInput["trigger"],
): ScheduledTaskInput {
  return {
    kind: "reminder",
    promptInstructions: text,
    trigger,
    priority: "medium",
    escalation: { steps: [{ delayMinutes: 0, channelKey: "current_dm" }] },
    output: {
      destination: "channel",
      target: "current_dm",
      fallback: { body: text },
    },
    subject: { kind: "self", id: "personal:user-1" },
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: "personal:user-1",
    ownerVisible: true,
    metadata: { delivery: PRIVATE_DELIVERY },
    executionProfile: "notify-only",
  };
}

function harness(): {
  options: SharedRemindersEdgePluginOptions;
  scheduleWithResult: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  applyWithResult: ReturnType<typeof vi.fn>;
} {
  const scheduleWithResult = vi.fn(async (input: ScheduledTaskInput) => ({
    task: scheduledTask(input),
    commit: {
      logId: "scheduled-log-1",
      taskId: "reminder-1",
      agentId: "personal:user-1",
      occurredAtIso: NOW,
      transition: "scheduled" as const,
      rolledUp: false,
    },
    replayed: false,
  }));
  const defaultTask = scheduledTask(
    reminderInput("Stretch", {
      kind: "once",
      atIso: "2026-08-14T20:02:00.000Z",
    }),
  );
  const list = vi.fn(
    async (filter?: Parameters<ScheduledTaskRunner["list"]>[0]) =>
      filter?.status ? [defaultTask] : ([] as ScheduledTask[]),
  );
  const apply = vi.fn(async () => {
    throw new Error("not used");
  });
  const applyWithResult = vi.fn(
    async (
      taskId: string,
      operation: "snooze" | "complete" | "dismiss",
      _payload: unknown,
      input: { idempotencyKey: string },
    ) => ({
      task: {
        ...scheduledTask(
          reminderInput("Stretch", {
            kind: "once" as const,
            atIso: "2026-08-14T20:02:00.000Z",
          }),
        ),
        taskId,
        state: {
          status:
            operation === "complete"
              ? ("completed" as const)
              : operation === "dismiss"
                ? ("dismissed" as const)
                : ("scheduled" as const),
          followupCount: 0,
        },
      },
      commit: {
        logId: `${operation}-log-1`,
        taskId,
        agentId: "personal:user-1",
        occurredAtIso: NOW,
        transition:
          operation === "snooze"
            ? ("snoozed" as const)
            : operation === "complete"
              ? ("completed" as const)
              : ("dismissed" as const),
        rolledUp: false,
      },
      idempotencyKey: input.idempotencyKey,
      replayed: false,
    }),
  );
  const runner: ScheduledTaskRunner = {
    scheduleWithResult,
    schedule: vi.fn(async (input: ScheduledTaskInput) => scheduledTask(input)),
    list,
    apply,
    applyWithResult,
    pipeline: vi.fn(async () => []),
  };
  return {
    scheduleWithResult,
    list,
    applyWithResult,
    options: {
      runner,
      agentId: "personal:user-1",
      delivery: PRIVATE_DELIVERY,
      now: () => new Date(NOW),
    },
  };
}

describe("Shared reminders edge plugin", () => {
  it("accepts only trusted private Telegram, Blooio, and Discord destinations", () => {
    expect(
      parseSharedReminderDelivery({
        platform: "telegram",
        project: "eliza-app",
        connectorAccountId: "bot:123456789",
        chatId: "123456",
      }),
    ).toEqual({
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "bot:123456789",
      chatId: "123456",
    });
    expect(
      parseSharedReminderDelivery({
        platform: "telegram",
        project: "eliza-app",
        chatId: "123456",
      }),
    ).toBeUndefined();
    expect(
      parseSharedReminderDelivery({
        platform: "blooio",
        project: "eliza-app",
        phoneNumber: "+15551234567",
      }),
    ).toEqual({
      platform: "blooio",
      project: "eliza-app",
      phoneNumber: "+15551234567",
    });
    expect(
      parseSharedReminderDelivery({
        platform: "discord",
        discordUserId: "123456789012345678",
      }),
    ).toEqual({
      platform: "discord",
      discordUserId: "123456789012345678",
    });
    expect(
      parseSharedReminderDelivery({
        platform: "discord",
        discordUserId: "guild:attacker",
      }),
    ).toBeUndefined();
    expect(
      parseSharedReminderDelivery({
        platform: "blooio",
        project: "eliza-app",
        phoneNumber: "15551234567",
      }),
    ).toBeUndefined();
  });

  it("creates one canonical task and pins delivery to the trusted current DM", async () => {
    const { options, scheduleWithResult } = harness();
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-1" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "Stretch",
          inMinutes: 2,
          target: "attacker-chat",
          platform: "discord",
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toBe("Got it — I'll remind you in 2 minutes: Stretch");
    expect(result?.text).not.toMatch(/reminder-1|scheduled|2026-08-14T/);
    expect(action?.tags).not.toContain("effect:idempotent");
    expect(action?.tags).not.toContain("effect:receipt-required");
    expect(scheduleWithResult).toHaveBeenCalledTimes(1);
    expect(scheduleWithResult.mock.calls[0]?.[0]).toMatchObject({
      kind: "reminder",
      trigger: { kind: "once", atIso: "2026-08-14T20:02:00.000Z" },
      output: {
        destination: "channel",
        target: "current_dm",
        fallback: { body: "Stretch" },
      },
      metadata: {
        delivery: {
          platform: "telegram",
          project: "eliza-app",
          connectorAccountId: "bot:123456789",
          chatId: "123456",
        },
      },
      executionProfile: "notify-only",
    });
    expect(result).toMatchObject({
      verifiedUserFacing: true,
      turnComplete: true,
      userFacingEffectReceiptIds: ["shared-reminder:create:scheduled-log-1"],
      effectReceipts: [
        {
          receiptId: "shared-reminder:create:scheduled-log-1",
          outcome: "applied",
          operation: "shared.reminder.create",
          resource: {
            kind: "shared.reminder",
            id: "reminder-1",
            version: "scheduled-log-1",
          },
          idempotency: {
            key: "shared-reminder:message-1:create",
            replayed: false,
          },
          commit: {
            kind: "durable",
            id: "scheduled-log-1",
            committedAt: NOW,
          },
        },
      ],
    });
  });

  it("rejects a create without structural timing instead of guessing", async () => {
    const { options, scheduleWithResult } = harness();
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-2" } as Memory,
      undefined,
      { parameters: { operation: "create", reminderText: "Call mom someday" } },
    );

    expect(result).toMatchObject({ success: false });
    expect(scheduleWithResult).not.toHaveBeenCalled();
  });

  it("rejects reminder text above the connector-safe limit", async () => {
    const { options, scheduleWithResult } = harness();
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-long" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "x".repeat(2001),
          inMinutes: 2,
        },
      },
    );

    expect(result).toMatchObject({ success: false });
    expect(scheduleWithResult).not.toHaveBeenCalled();
  });

  it("returns the original durable receipt identity as a replayed no-op", async () => {
    const { options, scheduleWithResult } = harness();
    scheduleWithResult.mockImplementationOnce(
      async (input: ScheduledTaskInput) => ({
        task: scheduledTask({
          ...input,
          promptInstructions: "Persisted Stretch",
          output: {
            destination: "channel",
            target: "current_dm",
            fallback: { body: "Persisted Stretch" },
          },
        }),
        commit: {
          logId: "scheduled-log-1",
          taskId: "reminder-1",
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "scheduled" as const,
          rolledUp: false,
        },
        replayed: true,
      }),
    );
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-1" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "Call mom",
          inMinutes: 2,
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      text: "That reminder is already set on Aug 14, 2026 at 8:02 PM UTC: Persisted Stretch",
      verifiedUserFacing: true,
      turnComplete: true,
      effectReceipts: [
        {
          receiptId: "shared-reminder:create:scheduled-log-1",
          outcome: "noop",
          idempotency: {
            key: "shared-reminder:message-1:create",
            replayed: true,
          },
        },
      ],
    });
    expect(result?.text).not.toMatch(/reminder-1|scheduled|2026-08-14T/);
  });

  it("uses a persisted snooze override for replay copy", async () => {
    const { options, scheduleWithResult } = harness();
    scheduleWithResult.mockImplementationOnce(
      async (input: ScheduledTaskInput) => ({
        task: {
          ...scheduledTask({
            ...input,
            promptInstructions: "Persisted Stretch",
            trigger: {
              kind: "cron",
              expression: "0 9 * * 1",
              tz: "America/Los_Angeles",
            },
            output: {
              destination: "channel",
              target: "current_dm",
              fallback: { body: "Persisted Stretch" },
            },
          }),
          state: {
            status: "scheduled" as const,
            followupCount: 0,
            firedAt: "2026-08-14T20:32:59.999Z",
          },
        },
        commit: {
          logId: "scheduled-log-1",
          taskId: "reminder-1",
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "scheduled" as const,
          rolledUp: false,
        },
        replayed: true,
      }),
    );
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-replayed-snooze" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "Conflicting retry",
          inMinutes: 2,
        },
      },
    );

    expect(result?.text).toBe(
      "That reminder is already set on Aug 14, 2026 at 1:32:59.999 PM America/Los_Angeles (Aug 14, 2026 at 8:32:59.999 PM UTC): Persisted Stretch",
    );
    expect(result?.text).not.toMatch(/every Monday|9:00 AM|2026-08-14T/);
  });

  it("lists one-off, interval, and cron reminders without storage internals", async () => {
    const { options, list } = harness();
    const stored = [
      scheduledTask(
        reminderInput("Stretch", {
          kind: "once",
          atIso: "2026-08-14T20:02:00.000Z",
        }),
      ),
      {
        ...scheduledTask(
          reminderInput("Drink water", { kind: "interval", everyMinutes: 1 }),
        ),
        taskId: "reminder-2",
      },
      {
        ...scheduledTask(
          reminderInput("Weekly planning", {
            kind: "cron",
            expression: "0 9 * * 1",
            tz: "America/Los_Angeles",
          }),
        ),
        taskId: "reminder-3",
      },
      {
        ...scheduledTask(
          reminderInput("Already dismissed", {
            kind: "once",
            atIso: "2026-08-15T20:00:00.000Z",
          }),
        ),
        taskId: "reminder-4",
        state: { status: "dismissed" as const, followupCount: 0 },
      },
    ];
    list.mockImplementationOnce(async (filter) => {
      const statuses = Array.isArray(filter?.status)
        ? filter.status
        : [filter?.status];
      return stored.filter((task) => statuses.includes(task.state.status));
    });
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-list" } as Memory,
      undefined,
      { parameters: { operation: "list" } },
    );

    expect(result?.text).toBe(
      "Your reminders:\n" +
        "• Stretch — on Aug 14, 2026 at 8:02 PM UTC\n" +
        "• Drink water — every 1 minute\n" +
        "• Weekly planning — every Monday at 9:00 AM in America/Los_Angeles",
    );
    expect(result?.text).not.toMatch(
      /reminder-[1234]|scheduled|dismissed|2026-08-14T|0 9 \* \* 1/,
    );
    expect(result?.text).not.toContain("Already dismissed");
    expect(list).toHaveBeenCalledWith({
      kind: "reminder",
      ownerVisibleOnly: true,
      status: ["scheduled", "fired", "acknowledged"],
    });
    expect(result).toMatchObject({
      verifiedUserFacing: true,
      userFacingText:
        "Your reminders:\n" +
        "• Stretch — on Aug 14, 2026 at 8:02 PM UTC\n" +
        "• Drink water — every 1 minute\n" +
        "• Weekly planning — every Monday at 9:00 AM in America/Los_Angeles",
      turnComplete: true,
    });
    expect(result?.data).toMatchObject({
      tasks: [
        { taskId: "reminder-1" },
        { taskId: "reminder-2" },
        { taskId: "reminder-3" },
      ],
    });
  });

  it("lists effective snooze times for one-off and recurring reminders", async () => {
    const { options, list } = harness();
    list.mockResolvedValueOnce([
      {
        ...scheduledTask(
          reminderInput("Stretch", {
            kind: "once",
            atIso: "2026-08-14T20:02:00.000Z",
          }),
        ),
        state: {
          status: "scheduled" as const,
          followupCount: 0,
          firedAt: "2026-08-14T20:32:00.000Z",
        },
      },
      {
        ...scheduledTask(
          reminderInput("Weekly planning", {
            kind: "cron",
            expression: "0 9 * * 1",
            tz: "America/Los_Angeles",
          }),
        ),
        taskId: "reminder-2",
        state: {
          status: "scheduled" as const,
          followupCount: 0,
          firedAt: "2026-08-14T20:45:59.999Z",
        },
      },
    ]);
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-list-snoozed" } as Memory,
      undefined,
      { parameters: { operation: "list" } },
    );

    expect(result?.text).toBe(
      "Your reminders:\n" +
        "• Stretch — on Aug 14, 2026 at 8:32 PM UTC\n" +
        "• Weekly planning — on Aug 14, 2026 at 1:45:59.999 PM America/Los_Angeles (Aug 14, 2026 at 8:45:59.999 PM UTC)",
    );
    expect(result?.text).not.toMatch(
      /8:02 PM|every Monday|9:00 AM|2026-08-14T/,
    );
  });

  it("does not list or mutate a reminder pinned to another trusted destination", async () => {
    const { options, list, applyWithResult } = harness();
    const otherDestination = {
      ...scheduledTask(
        reminderInput("Private elsewhere", {
          kind: "once",
          atIso: "2026-08-14T20:02:00.000Z",
        }),
      ),
      metadata: {
        delivery: { ...PRIVATE_DELIVERY, chatId: "999999" },
      },
    };
    list.mockResolvedValue([otherDestination]);
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const listed = await action?.handler(
      {} as IAgentRuntime,
      { id: "list-other-destination" } as Memory,
      undefined,
      { parameters: { operation: "list" } },
    );
    const deleted = await action?.handler(
      {} as IAgentRuntime,
      { id: "delete-other-destination" } as Memory,
      undefined,
      { parameters: { operation: "delete", target: "Private elsewhere" } },
    );

    expect(listed?.text).toBe("You have no reminders.");
    expect(deleted?.text).toBe("You have no active reminders.");
    expect(applyWithResult).not.toHaveBeenCalled();
  });

  it("keeps lifecycle acknowledgements user-facing while structured data retains the task id", async () => {
    const { options, applyWithResult } = harness();
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const snoozed = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-snooze" } as Memory,
      undefined,
      {
        parameters: {
          operation: "snooze",
          taskId: "reminder-1",
          snoozeMinutes: 1,
        },
      },
    );
    expect(snoozed?.text).toBe("Reminder snoozed for 1 minute: Stretch");
    expect(snoozed?.data).toMatchObject({ task: { taskId: "reminder-1" } });
    expect(snoozed?.text).not.toContain("reminder-1");
    expect(snoozed).toMatchObject({
      verifiedUserFacing: true,
      userFacingText: "Reminder snoozed for 1 minute: Stretch",
      effectReceipts: [
        {
          receiptId: "shared-reminder:snooze:snooze-log-1",
          outcome: "applied",
          operation: "shared.reminder.snooze",
        },
      ],
      userFacingEffectReceiptIds: ["shared-reminder:snooze:snooze-log-1"],
      turnComplete: true,
    });
    expect(applyWithResult).toHaveBeenNthCalledWith(
      1,
      "reminder-1",
      "snooze",
      { minutes: 1 },
      {
        idempotencyKey: "shared-reminder:message-snooze:snooze:reminder-1",
      },
    );

    const completed = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-complete" } as Memory,
      undefined,
      { parameters: { operation: "complete", taskId: "reminder-1" } },
    );
    expect(completed?.text).toBe("Reminder completed: Stretch");
    expect(completed?.data).toMatchObject({ task: { taskId: "reminder-1" } });
    expect(completed?.text).not.toContain("reminder-1");
    expect(completed).toMatchObject({
      verifiedUserFacing: true,
      userFacingText: "Reminder completed: Stretch",
      effectReceipts: [
        {
          receiptId: "shared-reminder:complete:complete-log-1",
          outcome: "applied",
        },
      ],
      turnComplete: true,
    });

    const dismissed = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-dismiss" } as Memory,
      undefined,
      { parameters: { operation: "dismiss", taskId: "reminder-1" } },
    );
    expect(dismissed?.text).toBe("Reminder dismissed: Stretch");
    expect(dismissed).toMatchObject({
      verifiedUserFacing: true,
      userFacingText: "Reminder dismissed: Stretch",
      effectReceipts: [
        {
          receiptId: "shared-reminder:dismiss:dismiss-log-1",
          outcome: "applied",
        },
      ],
      turnComplete: true,
    });
  });

  it("reuses the durable lifecycle receipt on an idempotent replay", async () => {
    const { options, applyWithResult } = harness();
    const replayTask = scheduledTask(
      reminderInput("Stretch", {
        kind: "once",
        atIso: "2026-08-14T20:02:00.000Z",
      }),
    );
    const resultFor = (replayed: boolean) => ({
      task: replayTask,
      commit: {
        logId: "complete-log-stable",
        taskId: replayTask.taskId,
        agentId: "personal:user-1",
        occurredAtIso: NOW,
        transition: "completed" as const,
        rolledUp: false,
      },
      idempotencyKey:
        "shared-reminder:message-complete-retry:complete:reminder-1",
      replayed,
    });
    applyWithResult
      .mockResolvedValueOnce(resultFor(false))
      .mockResolvedValueOnce(resultFor(true));
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const invoke = () =>
      action?.handler(
        {} as IAgentRuntime,
        { id: "message-complete-retry" } as Memory,
        undefined,
        { parameters: { operation: "complete", taskId: "reminder-1" } },
      );

    const first = await invoke();
    const replay = await invoke();

    expect(first?.effectReceipts?.[0]).toMatchObject({
      receiptId: "shared-reminder:complete:complete-log-stable",
      outcome: "applied",
      idempotency: { replayed: false },
    });
    expect(replay?.effectReceipts?.[0]).toMatchObject({
      receiptId: "shared-reminder:complete:complete-log-stable",
      outcome: "noop",
      idempotency: { replayed: true },
    });
    expect(first?.userFacingEffectReceiptIds).toEqual(
      replay?.userFacingEffectReceiptIds,
    );
    expect(applyWithResult.mock.calls.map((call) => call[3])).toEqual([
      {
        idempotencyKey:
          "shared-reminder:message-complete-retry:complete:reminder-1",
      },
      {
        idempotencyKey:
          "shared-reminder:message-complete-retry:complete:reminder-1",
      },
    ]);
  });

  it("deduplicates the screenshot correction across distinct message ids and renders Paris time first", async () => {
    const { options, list, scheduleWithResult } = harness();
    let persisted: ScheduledTask | undefined;
    let durableCreates = 0;
    list.mockImplementation(async () => (persisted ? [persisted] : []));
    scheduleWithResult.mockImplementation(async (input: ScheduledTaskInput) => {
      const existing = persisted;
      if (existing && existing.idempotencyKey === input.idempotencyKey) {
        return {
          task: existing,
          commit: {
            logId: "semantic-create-log",
            taskId: existing.taskId,
            agentId: "personal:user-1",
            occurredAtIso: NOW,
            transition: "scheduled" as const,
            rolledUp: false,
          },
          replayed: true,
        };
      }
      durableCreates += 1;
      persisted = {
        taskId: "semantic-reminder-1",
        ...input,
        state: { status: "scheduled", followupCount: 0 },
      };
      return {
        task: persisted,
        commit: {
          logId: "semantic-create-log",
          taskId: persisted.taskId,
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "scheduled" as const,
          rolledUp: false,
        },
        replayed: false,
      };
    });
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const parameters = {
      operation: "create",
      reminderText: "add something to your todo",
      atIso: "2026-08-28T01:06:00.000Z",
      timezone: "Europe/Paris",
    };

    const first = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "screenshot-message-create",
        content: {
          text: "Can you remind me at 3:06 am (French time) to add smth to my todo?",
        },
      } as Memory,
      undefined,
      { parameters: { ...parameters, timezone: "europe/paris" } },
    );
    options.clockCorrection = true;
    const correction = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "screenshot-message-correction",
        content: { text: "3 06 no 1:06" },
      } as Memory,
      undefined,
      { parameters },
    );

    expect(durableCreates).toBe(1);
    expect(scheduleWithResult).toHaveBeenCalledTimes(2);
    expect(scheduleWithResult.mock.calls[0]?.[0]?.idempotencyKey).toBe(
      scheduleWithResult.mock.calls[1]?.[0]?.idempotencyKey,
    );
    expect(first?.text).toBe(
      "Got it — I'll remind you on Aug 28, 2026 at 3:06 AM Europe/Paris (Aug 28, 2026 at 1:06 AM UTC): add something to your todo",
    );
    expect(correction).toMatchObject({
      success: true,
      data: { operation: "update", replayed: true },
      effectReceipts: [{ outcome: "noop" }],
    });
    expect(correction?.text).toContain(
      "on Aug 28, 2026 at 3:06 AM Europe/Paris",
    );
  });

  it("replays a pre-patch active row instead of duplicating it when create adds display timezone", async () => {
    const { options, list, scheduleWithResult } = harness();
    const legacy = {
      ...scheduledTask(
        reminderInput("add something to your todo", {
          kind: "once" as const,
          atIso: "2026-08-28T01:06:00.000Z",
        }),
      ),
      taskId: "legacy-active-reminder",
      idempotencyKey: "shared-reminder:old-message:create",
      metadata: { delivery: PRIVATE_DELIVERY },
    };
    list.mockResolvedValue([legacy]);
    scheduleWithResult.mockResolvedValue({
      task: legacy,
      commit: {
        logId: "legacy-create-log",
        taskId: legacy.taskId,
        agentId: "personal:user-1",
        occurredAtIso: NOW,
        transition: "scheduled" as const,
        rolledUp: false,
      },
      replayed: true,
    });
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "new-message-same-firing" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          target: "add something to your todo",
          reminderText: "add something to your todo",
          atIso: "2026-08-28T01:06:00.000Z",
          timezone: "Europe/Paris",
        },
      },
    );

    expect(scheduleWithResult).toHaveBeenCalledTimes(1);
    expect(scheduleWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "shared-reminder:old-message:create",
      }),
    );
    expect(result).toMatchObject({
      success: true,
      data: { deduplicated: true, replayed: true },
      effectReceipts: [{ outcome: "noop" }],
    });
    expect(result?.text).toBe(
      "That reminder is already set on Aug 28, 2026 at 1:06 AM UTC: add something to your todo",
    );
  });

  it("coerces an adversarial planner operation into the trusted screenshot update", async () => {
    const { options, list, scheduleWithResult, applyWithResult } = harness();
    options.clockCorrection = true;
    const original = {
      ...scheduledTask(
        reminderInput("add something to your todo", {
          kind: "once" as const,
          atIso: "2026-08-28T00:06:00.000Z",
        }),
      ),
      taskId: "clock-correction-original",
    };
    list.mockResolvedValue([original]);
    scheduleWithResult.mockImplementation(
      async (input: ScheduledTaskInput) => ({
        task: {
          taskId: "clock-correction-replacement",
          ...input,
          state: { status: "scheduled" as const, followupCount: 0 },
        },
        commit: {
          logId: "clock-correction-create-log",
          taskId: "clock-correction-replacement",
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "scheduled" as const,
          rolledUp: false,
        },
        replayed: false,
      }),
    );
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "screenshot-clock-correction",
        content: { text: "3 06 no 1:06" },
      } as Memory,
      undefined,
      {
        parameters: {
          operation: "delete",
          reminderText: "add something to your todo",
          atIso: "2026-08-28T01:06:00.000Z",
          timezone: "Europe/Paris",
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      data: { operation: "update" },
    });
    expect(result?.effectReceipts?.map((receipt) => receipt.operation)).toEqual(
      ["shared.reminder.create", "shared.reminder.dismiss"],
    );
    expect(applyWithResult).toHaveBeenCalledWith(
      "clock-correction-original",
      "dismiss",
      { reason: "replaced by reminder update" },
      expect.any(Object),
    );
  });

  it("does not overwrite an unrelated sole reminder from raw correction language", async () => {
    const { options, list, scheduleWithResult, applyWithResult } = harness();
    list.mockResolvedValue([
      scheduledTask(
        reminderInput("Take meds", {
          kind: "once",
          atIso: "2026-08-28T00:30:00.000Z",
        }),
      ),
    ]);
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "initial-request-with-correction-words",
        content: {
          text: "Remind me at 3:06, not 1:06, to call mom",
        },
      } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "Call mom",
          atIso: "2026-08-28T01:06:00.000Z",
          timezone: "Europe/Paris",
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      data: { operation: "create" },
    });
    expect(scheduleWithResult).toHaveBeenCalledTimes(1);
    expect(applyWithResult).not.toHaveBeenCalled();
  });

  it.each([
    ["list" as const, "List my reminders"],
    ["create" as const, "Create a reminder to call mom"],
  ])(
    "prevents planner delete from overriding trusted %s intent",
    async (operationIntent, text) => {
      const { options, list, applyWithResult, scheduleWithResult } = harness();
      options.operationIntent = operationIntent;
      const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

      const result = await action?.handler(
        {} as IAgentRuntime,
        { id: `confused-${operationIntent}`, content: { text } } as Memory,
        undefined,
        { parameters: { operation: "delete" } },
      );

      expect(result).toMatchObject({
        success: false,
        verifiedUserFacing: true,
        turnComplete: true,
        data: {
          operation: operationIntent,
          failureCode: "REMINDER_OPERATION_MISMATCH",
        },
      });
      expect(list).not.toHaveBeenCalled();
      expect(applyWithResult).not.toHaveBeenCalled();
      expect(scheduleWithResult).not.toHaveBeenCalled();
    },
  );

  it("rejects offset-less atIso values instead of guessing the Worker timezone", async () => {
    const { options, scheduleWithResult } = harness();
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "offsetless-at-iso" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "Stretch",
          atIso: "2026-08-28T03:06:00",
          timezone: "Europe/Paris",
        },
      },
    );

    expect(result).toMatchObject({ success: false, verifiedUserFacing: true });
    expect(result?.text).toContain("explicit Z or ±HH:MM offset");
    expect(scheduleWithResult).not.toHaveBeenCalled();
  });

  it("canonicalizes cron timezone casing before semantic deduplication", async () => {
    const { options, list, scheduleWithResult } = harness();
    let persisted: ScheduledTask | undefined;
    let durableCreates = 0;
    list.mockImplementation(async () => (persisted ? [persisted] : []));
    scheduleWithResult.mockImplementation(async (input: ScheduledTaskInput) => {
      const existing = persisted;
      if (existing && existing.idempotencyKey === input.idempotencyKey) {
        return {
          task: existing,
          commit: {
            logId: "cron-semantic-log",
            taskId: existing.taskId,
            agentId: "personal:user-1",
            occurredAtIso: NOW,
            transition: "scheduled" as const,
            rolledUp: false,
          },
          replayed: true,
        };
      }
      durableCreates += 1;
      persisted = {
        taskId: "cron-semantic-reminder",
        ...input,
        state: { status: "scheduled", followupCount: 0 },
      };
      return {
        task: persisted,
        commit: {
          logId: "cron-semantic-log",
          taskId: persisted.taskId,
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "scheduled" as const,
          rolledUp: false,
        },
        replayed: false,
      };
    });
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const invoke = (id: string, timezone: string) =>
      action?.handler({} as IAgentRuntime, { id } as Memory, undefined, {
        parameters: {
          operation: "create",
          reminderText: "Daily stretch",
          cronExpression: "6 3 * * *",
          timezone,
        },
      });

    await invoke("cron-lowercase", "europe/paris");
    const replay = await invoke("cron-canonical", "Europe/Paris");

    expect(durableCreates).toBe(1);
    expect(scheduleWithResult.mock.calls[0]?.[0]?.trigger).toEqual({
      kind: "cron",
      expression: "6 3 * * *",
      tz: "Europe/Paris",
    });
    expect(scheduleWithResult.mock.calls[0]?.[0]?.idempotencyKey).toBe(
      scheduleWithResult.mock.calls[1]?.[0]?.idempotencyKey,
    );
    expect(replay).toMatchObject({
      success: true,
      data: { deduplicated: true, replayed: true },
    });
  });

  it("keeps relative scheduling idempotent across a delayed retry of the same message", async () => {
    const { options, list, scheduleWithResult } = harness();
    let currentTime = Date.parse(NOW);
    options.now = () => new Date(currentTime);
    let persisted: ScheduledTask | undefined;
    let durableCreates = 0;
    list.mockImplementation(async () => (persisted ? [persisted] : []));
    scheduleWithResult.mockImplementation(async (input: ScheduledTaskInput) => {
      const existing = persisted;
      if (existing && existing.idempotencyKey === input.idempotencyKey) {
        return {
          task: existing,
          commit: {
            logId: "relative-retry-log",
            taskId: existing.taskId,
            agentId: "personal:user-1",
            occurredAtIso: NOW,
            transition: "scheduled" as const,
            rolledUp: false,
          },
          replayed: true,
        };
      }
      durableCreates += 1;
      persisted = {
        taskId: `relative-retry-${durableCreates}`,
        ...input,
        state: { status: "scheduled", followupCount: 0 },
      };
      return {
        task: persisted,
        commit: {
          logId: `relative-retry-log-${durableCreates}`,
          taskId: persisted.taskId,
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "scheduled" as const,
          rolledUp: false,
        },
        replayed: false,
      };
    });
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const invoke = (id: string) =>
      action?.handler(
        {} as IAgentRuntime,
        {
          id,
          content: { text: "Remind me in 2 minutes to stretch" },
        } as Memory,
        undefined,
        {
          parameters: {
            operation: "create",
            reminderText: "Stretch",
            inMinutes: 2,
          },
        },
      );

    await invoke("same-relative-message");
    currentTime += 5_000;
    const replay = await invoke("same-relative-message");

    expect(durableCreates).toBe(1);
    expect(scheduleWithResult.mock.calls[0]?.[0]?.idempotencyKey).toBe(
      "shared-reminder:same-relative-message:create",
    );
    expect(scheduleWithResult.mock.calls[1]?.[0]?.idempotencyKey).toBe(
      "shared-reminder:same-relative-message:create",
    );
    expect(replay).toMatchObject({
      success: true,
      data: { deduplicated: true, replayed: true },
    });

    if (!persisted) throw new Error("Expected the first persisted reminder");
    persisted.state = { status: "dismissed", followupCount: 0 };
    currentTime += 5_000;
    const terminalReplay = await invoke("same-relative-message");
    expect(terminalReplay).toMatchObject({
      success: false,
      data: { replayedTerminalRequest: true },
    });
    expect(durableCreates).toBe(1);

    await invoke("different-relative-message");
    expect(durableCreates).toBe(2);
  });

  it("renders zoned sub-second instants with an explicit seconds field", async () => {
    const { options } = harness();
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "zoned-sub-second" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "Stretch",
          atIso: "2026-08-14T20:00:00.006Z",
          timezone: "Europe/Paris",
        },
      },
    );

    expect(result?.text).toContain(
      "10:00:00.006 PM Europe/Paris (Aug 14, 2026 at 8:00:00.006 PM UTC)",
    );
  });

  it("deletes exact semantic duplicates by visible title and returns every durable receipt", async () => {
    const { options, list, applyWithResult } = harness();
    const tasks = ["duplicate-a", "duplicate-b"].map((taskId) => ({
      ...scheduledTask(
        reminderInput("Stretch", {
          kind: "once" as const,
          atIso: "2026-08-28T01:06:00.000Z",
        }),
      ),
      taskId,
      idempotencyKey: `semantic-${taskId}`,
    }));
    list.mockResolvedValue(tasks);
    applyWithResult.mockImplementation(
      async (taskId, _operation, _payload, input) => ({
        task: {
          ...(tasks.find((task) => task.taskId === taskId) ?? tasks[0]),
          state: { status: "dismissed" as const, followupCount: 0 },
        },
        commit: {
          logId: `dismiss-${taskId}`,
          taskId,
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "dismissed" as const,
          rolledUp: false,
        },
        idempotencyKey: input.idempotencyKey,
        replayed: false,
      }),
    );
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "screenshot-delete-by-title",
        content: { text: "Remove the reminder Stretch" },
      } as Memory,
      undefined,
      { parameters: { operation: "delete", target: "Stretch" } },
    );

    expect(result?.text).toBe("Deleted 2 identical reminders: Stretch");
    expect(result?.text).not.toMatch(/duplicate-[ab]/);
    expect(result?.effectReceipts).toHaveLength(2);
    expect(result?.userFacingEffectReceiptIds).toEqual([
      "shared-reminder:dismiss:dismiss-duplicate-a",
      "shared-reminder:dismiss:dismiss-duplicate-b",
    ]);
    expect(applyWithResult).toHaveBeenCalledTimes(2);
  });

  it("resolves the exact screenshot delete phrase to its visible reminder title", async () => {
    const { options, list, applyWithResult } = harness();
    options.operationIntent = "delete";
    const task = {
      ...scheduledTask(
        reminderInput("add something to your todo", {
          kind: "once" as const,
          atIso: "2026-08-28T01:06:00.000Z",
        }),
      ),
      taskId: "screenshot-visible-title",
    };
    list.mockResolvedValue([task]);
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "screenshot-full-delete-command",
        content: {
          text: "Remove the reminder add something in my todo",
        },
      } as Memory,
      undefined,
      {
        parameters: {
          operation: "list",
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      data: { operation: "delete", affectedCount: 1 },
    });
    expect(applyWithResult).toHaveBeenCalledWith(
      "screenshot-visible-title",
      "dismiss",
      undefined,
      expect.any(Object),
    );
  });

  it("clarifies instead of mutating when target-only todo wording matches two close titles", async () => {
    const { options, list, applyWithResult } = harness();
    list.mockResolvedValue(
      ["add something to your todo", "add something in my todo"].map(
        (title, index) => ({
          ...scheduledTask(
            reminderInput(title, {
              kind: "once" as const,
              atIso: "2026-08-28T01:06:00.000Z",
            }),
          ),
          taskId: `close-todo-title-${index}`,
        }),
      ),
    );
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "ambiguous-screenshot-target" } as Memory,
      undefined,
      {
        parameters: {
          operation: "delete",
          target: "Remove the reminder add something in my todo",
        },
      },
    );

    expect(result).toMatchObject({ success: false, verifiedUserFacing: true });
    expect(result?.text).toContain("More than one reminder matches");
    expect(applyWithResult).not.toHaveBeenCalled();
  });

  it.each([
    ["Pay $5", "Pay 5"],
    ["Review C++", "Review C#"],
  ])(
    "keeps symbol-distinct reminder titles separate: %s vs %s",
    async (selectedTitle, otherTitle) => {
      const { options, list, applyWithResult } = harness();
      const tasks = [selectedTitle, otherTitle].map((title, index) => ({
        ...scheduledTask(
          reminderInput(title, {
            kind: "once" as const,
            atIso: "2026-08-28T01:06:00.000Z",
          }),
        ),
        taskId: `symbol-${index}`,
      }));
      list.mockResolvedValue(tasks);
      const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

      await action?.handler(
        {} as IAgentRuntime,
        { id: `delete-symbol-${selectedTitle}` } as Memory,
        undefined,
        { parameters: { operation: "delete", target: selectedTitle } },
      );

      expect(applyWithResult).toHaveBeenCalledTimes(1);
      expect(applyWithResult.mock.calls[0]?.[0]).toBe("symbol-0");
    },
  );

  it("returns partial duplicate-delete receipts when one dismissal cannot be verified", async () => {
    const { options, list, applyWithResult } = harness();
    const durableFailure = new Error("injected second dismiss failure");
    const reportError = vi.fn();
    const tasks = ["partial-a", "partial-b"].map((taskId) => ({
      ...scheduledTask(
        reminderInput("Stretch", {
          kind: "once" as const,
          atIso: "2026-08-28T01:06:00.000Z",
        }),
      ),
      taskId,
    }));
    list.mockResolvedValue(tasks);
    applyWithResult
      .mockResolvedValueOnce({
        task: tasks[0],
        commit: {
          logId: "partial-dismiss-a",
          taskId: "partial-a",
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "dismissed" as const,
          rolledUp: false,
        },
        idempotencyKey: "partial-dismiss-a-key",
        replayed: false,
      })
      .mockRejectedValueOnce(durableFailure);
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      { reportError } as unknown as IAgentRuntime,
      { id: "partial-delete" } as Memory,
      undefined,
      { parameters: { operation: "delete", target: "Stretch" } },
    );

    expect(result).toMatchObject({
      success: false,
      data: { affectedCount: 1, failedCount: 1 },
      effectReceipts: [
        { receiptId: "shared-reminder:dismiss:partial-dismiss-a" },
      ],
    });
    expect(result?.text).toContain("Deleted 1 reminder");
    expect(result?.text).toContain("couldn't verify 1 other matching reminder");
    expect(reportError).toHaveBeenCalledWith(
      "SharedReminders.lifecycleMutation",
      durableFailure,
      { operation: "delete", phase: "dismiss", failedCount: 1 },
    );
  });

  it("asks for schedule clarification when the same visible title is not an exact duplicate", async () => {
    const { options, list, applyWithResult } = harness();
    list.mockResolvedValue([
      scheduledTask(
        reminderInput("Stretch", {
          kind: "once",
          atIso: "2026-08-28T01:06:00.000Z",
        }),
      ),
      {
        ...scheduledTask(
          reminderInput("Stretch", {
            kind: "once",
            atIso: "2026-08-28T02:06:00.000Z",
          }),
        ),
        taskId: "reminder-2",
      },
    ]);
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "ambiguous-delete" } as Memory,
      undefined,
      { parameters: { operation: "delete", target: "Stretch" } },
    );

    expect(result).toMatchObject({
      success: false,
      verifiedUserFacing: true,
      turnComplete: true,
    });
    expect(result?.text).toContain("More than one reminder matches");
    expect(result?.text).toContain("1:06 AM UTC");
    expect(result?.text).toContain("2:06 AM UTC");
    expect(result?.text).not.toMatch(/reminder-[12]/);
    expect(applyWithResult).not.toHaveBeenCalled();
  });

  it("requires a second explicit confirmation before clearing and accepts French confirmation", async () => {
    const { options, list, applyWithResult } = harness();
    const tasks = ["clear-a", "clear-b"].map((taskId) => ({
      ...scheduledTask(
        reminderInput(`Reminder ${taskId}`, {
          kind: "once" as const,
          atIso: "2026-08-28T01:06:00.000Z",
        }),
      ),
      taskId,
    }));
    list.mockResolvedValue(tasks);
    applyWithResult.mockImplementation(
      async (taskId, _operation, _payload, input) => ({
        task: {
          ...(tasks.find((task) => task.taskId === taskId) ?? tasks[0]),
          state: { status: "dismissed" as const, followupCount: 0 },
        },
        commit: {
          logId: `clear-${taskId}`,
          taskId,
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "dismissed" as const,
          rolledUp: false,
        },
        idempotencyKey: input.idempotencyKey,
        replayed: false,
      }),
    );
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    options.clearAllIntent = true;

    const initial = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "screenshot-clear-initial",
        content: { text: "Can you clear the list?" },
      } as Memory,
      undefined,
      { parameters: { operation: "delete" } },
    );
    expect(initial).toMatchObject({
      success: false,
      data: { requiresConfirmation: true },
    });
    expect(applyWithResult).not.toHaveBeenCalled();

    const longClearText = `Clear all my reminders because ${"I no longer need this scheduled item ".repeat(75)}`;
    expect(longClearText.length).toBeGreaterThan(2_100);
    expect(longClearText.length).toBeLessThanOrEqual(4_096);
    const longInitial = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "long-clear-initial",
        content: { text: longClearText },
      } as Memory,
      undefined,
      { parameters: { operation: "delete" } },
    );
    expect(longInitial).toMatchObject({
      success: false,
      data: { requiresConfirmation: true },
    });
    expect(applyWithResult).not.toHaveBeenCalled();

    const unchallengedExplicitConfirmation = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "direct-clear-without-challenge",
        content: { text: "yes, clear all reminders" },
      } as Memory,
      undefined,
      { parameters: { operation: "delete", confirmed: true } },
    );
    expect(unchallengedExplicitConfirmation).toMatchObject({
      success: false,
      data: { requiresConfirmation: true },
    });
    expect(applyWithResult).not.toHaveBeenCalled();

    options.clearConfirmationChallenge = true;
    const bareConfirmation = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "screenshot-clear-confirmed",
        content: { text: "Oui, je confirme, vas-y" },
      } as Memory,
      undefined,
      { parameters: { operation: "delete", confirmed: true } },
    );
    expect(bareConfirmation).toMatchObject({
      success: false,
      data: { requiresConfirmation: true },
    });
    expect(applyWithResult).not.toHaveBeenCalled();

    const doItConfirmed = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "do-it-clear-confirmed",
        content: { text: "Do it, clear all reminders" },
      } as Memory,
      undefined,
      { parameters: { operation: "delete", confirmed: true } },
    );
    expect(doItConfirmed).toMatchObject({
      success: true,
      text: "Cleared 2 reminders.",
      data: { operation: "clear", dismissedCount: 2, failedCount: 0 },
    });
    expect(applyWithResult).toHaveBeenCalledTimes(2);
    applyWithResult.mockClear();

    const confirmed = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "screenshot-clear-explicit-confirmed",
        content: {
          text: "Oui, je confirme, vas-y, efface tous mes rappels",
        },
      } as Memory,
      undefined,
      { parameters: { operation: "delete", confirmed: true } },
    );
    expect(confirmed).toMatchObject({
      success: true,
      text: "Cleared 2 reminders.",
      data: { dismissedCount: 2, failedCount: 0 },
    });
    expect(confirmed?.effectReceipts).toHaveLength(2);
  });

  it("keeps a targeted delete targeted even after a clear challenge", async () => {
    const { options, applyWithResult } = harness();
    options.clearConfirmationChallenge = true;
    options.clearAllIntent = false;
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "targeted-delete-after-clear-challenge",
        content: { text: "Remove the reminder Stretch" },
      } as Memory,
      undefined,
      { parameters: { operation: "delete", target: "Stretch" } },
    );

    expect(result).toMatchObject({
      success: true,
      data: { operation: "delete", affectedCount: 1 },
    });
    expect(applyWithResult).toHaveBeenCalledTimes(1);
  });

  it("persists a timezone-only update as a receipt-backed replacement plus dismissal", async () => {
    const { options, list, scheduleWithResult, applyWithResult } = harness();
    const original = {
      ...scheduledTask(
        reminderInput("Stretch", {
          kind: "once" as const,
          atIso: "2026-08-28T01:06:00.000Z",
        }),
      ),
      taskId: "update-original",
      idempotencyKey: "update-original-key",
      metadata: {
        delivery: PRIVATE_DELIVERY,
        pendingDispatch: { attempt: 2 },
        escalationCursor: 1,
        applyReceipts: { stale: true },
      },
    };
    const duplicate = {
      ...original,
      taskId: "update-duplicate",
      idempotencyKey: "update-duplicate-key",
    };
    list.mockResolvedValue([original, duplicate]);
    scheduleWithResult.mockImplementation(
      async (input: ScheduledTaskInput) => ({
        task: {
          taskId: "update-replacement",
          ...input,
          state: { status: "scheduled" as const, followupCount: 0 },
        },
        commit: {
          logId: "update-create-log",
          taskId: "update-replacement",
          agentId: "personal:user-1",
          occurredAtIso: NOW,
          transition: "scheduled" as const,
          rolledUp: false,
        },
        replayed: false,
      }),
    );
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "update-by-title",
        content: { text: "Actually use French time for the Stretch reminder" },
      } as Memory,
      undefined,
      {
        parameters: {
          operation: "update",
          target: "Stretch",
          timezone: "Europe/Paris",
        },
      },
    );

    expect(result?.text).toBe(
      "Updated reminder: Stretch — on Aug 28, 2026 at 3:06 AM Europe/Paris (Aug 28, 2026 at 1:06 AM UTC)",
    );
    expect(scheduleWithResult.mock.calls[0]?.[0]?.metadata).toEqual({
      delivery: PRIVATE_DELIVERY,
      displayTimezone: "Europe/Paris",
    });
    expect(result?.effectReceipts).toHaveLength(3);
    expect(result?.effectReceipts?.map((receipt) => receipt.operation)).toEqual(
      [
        "shared.reminder.create",
        "shared.reminder.dismiss",
        "shared.reminder.dismiss",
      ],
    );
    expect(applyWithResult).toHaveBeenCalledWith(
      "update-original",
      "dismiss",
      { reason: "replaced by reminder update" },
      expect.objectContaining({
        idempotencyKey:
          "shared-reminder:update-by-title:update-dismiss:update-original",
      }),
    );
    expect(applyWithResult).toHaveBeenCalledWith(
      "update-duplicate",
      "dismiss",
      { reason: "replaced by reminder update" },
      expect.objectContaining({
        idempotencyKey:
          "shared-reminder:update-by-title:update-dismiss:update-duplicate",
      }),
    );
  });

  it("returns a truthful visible failure when the durable lifecycle mutation fails", async () => {
    const { options, applyWithResult } = harness();
    const durableFailure = new Error("injected durable apply failure");
    const reportError = vi.fn();
    applyWithResult.mockRejectedValueOnce(durableFailure);
    const callback = vi.fn();
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      { reportError } as unknown as IAgentRuntime,
      { id: "message-dismiss-failure" } as Memory,
      undefined,
      { parameters: { operation: "dismiss", taskId: "reminder-1" } },
      callback,
    );
    expect(result).toMatchObject({
      success: false,
      verifiedUserFacing: true,
      turnComplete: true,
      data: { failureCode: "REMINDER_MUTATION_UNVERIFIED" },
    });
    expect(result?.text).toContain("won't claim it succeeded");
    expect(callback).toHaveBeenCalledWith({ text: result?.text });
    expect(reportError).toHaveBeenCalledWith(
      "SharedReminders.lifecycleMutation",
      durableFailure,
      { operation: "dismiss", phase: "dismiss", failedCount: 1 },
    );
    expect(reportError).toHaveBeenCalledWith(
      "SharedReminders.handler",
      durableFailure,
      { operation: "dismiss", phase: "durable-operation" },
    );
  });

  it("still returns the grounded failure when diagnostic reporting throws", async () => {
    const { options, applyWithResult } = harness();
    applyWithResult.mockRejectedValueOnce(new Error("durable failure"));
    const callback = vi.fn();
    const reportError = vi.fn(() => {
      throw new Error("diagnostic reporter failure");
    });
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const result = await action?.handler(
      { reportError } as unknown as IAgentRuntime,
      { id: "message-report-error-failure" } as Memory,
      undefined,
      { parameters: { operation: "dismiss", target: "Stretch" } },
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      verifiedUserFacing: true,
      turnComplete: true,
    });
    expect(callback).toHaveBeenCalledWith({ text: result?.text });
  });

  it("states exact millisecond delays and rejects sub-millisecond model durations", async () => {
    const { options, scheduleWithResult } = harness();
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];

    const created = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-six-ms" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "Stretch",
          inMinutes: 0.0001,
        },
      },
    );
    expect(created?.text).toBe(
      "Got it — I'll remind you in 6 milliseconds: Stretch",
    );
    expect(scheduleWithResult.mock.calls[0]?.[0]).toMatchObject({
      trigger: { kind: "once", atIso: "2026-08-14T20:00:00.006Z" },
    });

    const snoozed = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-snooze-six-ms" } as Memory,
      undefined,
      {
        parameters: {
          operation: "snooze",
          taskId: "reminder-1",
          snoozeMinutes: 0.0001,
        },
      },
    );
    expect(snoozed?.text).toBe("Reminder snoozed for 6 milliseconds: Stretch");

    const rejected = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-sub-ms" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "Stretch",
          inMinutes: 0.000001,
        },
      },
    );
    expect(rejected).toMatchObject({
      success: false,
      text: "Reminder delay must resolve to a positive whole millisecond.",
    });
    expect(scheduleWithResult).toHaveBeenCalledTimes(1);
  });
});
