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
    metadata: {},
    executionProfile: "notify-only",
  };
}

function harness(): {
  options: SharedRemindersEdgePluginOptions;
  scheduleWithResult: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
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
  const list = vi.fn(async () => [] as ScheduledTask[]);
  const apply = vi.fn(async () => {
    throw new Error("not used");
  });
  const runner: ScheduledTaskRunner = {
    scheduleWithResult,
    schedule: vi.fn(async (input: ScheduledTaskInput) => scheduledTask(input)),
    list,
    apply,
    pipeline: vi.fn(async () => []),
  };
  return {
    scheduleWithResult,
    list,
    apply,
    options: {
      runner,
      agentId: "personal:user-1",
      delivery: {
        platform: "telegram",
        project: "eliza-app",
        chatId: "123456",
      },
      now: () => new Date(NOW),
    },
  };
}

describe("Shared reminders edge plugin", () => {
  it("accepts only trusted private Telegram, Blooio, and Discord destinations", () => {
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

  it("keeps lifecycle acknowledgements user-facing while structured data retains the task id", async () => {
    const { options, apply } = harness();
    apply.mockImplementation(async (_taskId: string, operation: string) =>
      scheduledTask(
        reminderInput(
          "Stretch",
          operation === "snooze"
            ? { kind: "once", atIso: "2026-08-14T20:10:00.000Z" }
            : { kind: "once", atIso: "2026-08-14T20:02:00.000Z" },
        ),
      ),
    );
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

    const completed = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-complete" } as Memory,
      undefined,
      { parameters: { operation: "complete", taskId: "reminder-1" } },
    );
    expect(completed?.text).toBe("Reminder completed: Stretch");
    expect(completed?.data).toMatchObject({ task: { taskId: "reminder-1" } });
    expect(completed?.text).not.toContain("reminder-1");

    const dismissed = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-dismiss" } as Memory,
      undefined,
      { parameters: { operation: "dismiss", taskId: "reminder-1" } },
    );
    expect(dismissed?.text).toBe("Reminder dismissed: Stretch");
  });

  it("states exact millisecond delays and rejects sub-millisecond model durations", async () => {
    const { options, scheduleWithResult, apply } = harness();
    apply.mockResolvedValueOnce(
      scheduledTask(
        reminderInput("Stretch", {
          kind: "once",
          atIso: "2026-08-14T20:00:00.006Z",
        }),
      ),
    );
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
