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

function harness(): {
  options: SharedRemindersEdgePluginOptions;
  scheduleWithResult: ReturnType<typeof vi.fn>;
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
  const runner: ScheduledTaskRunner = {
    scheduleWithResult,
    schedule: vi.fn(async (input: ScheduledTaskInput) => scheduledTask(input)),
    list: vi.fn(async () => []),
    apply: vi.fn(async () => {
      throw new Error("not used");
    }),
    pipeline: vi.fn(async () => []),
  };
  return {
    scheduleWithResult,
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
        task: scheduledTask(input),
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
          reminderText: "Stretch",
          inMinutes: 2,
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
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
  });
});
