/**
 * Verifies the Shared reminder group-destination contract: parse round-trips
 * for trusted group deliveries, rejection of malformed or redirected group
 * targets, the group-facing action copy, and the dispatch-policy outcome for a
 * binding that is no longer active. Deterministic, mocked runner harness.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core/edge";
import { describe, expect, it, vi } from "vitest";
import { decideDispatchPolicy } from "./dispatch-policy.js";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRunner,
} from "./scheduled-task/types.js";
import {
  createSharedRemindersEdgePlugin,
  isSharedGroupReminderDelivery,
  parseSharedReminderDelivery,
  SHARED_REMINDER_MAX_TEXT_LENGTH,
  type SharedReminderDelivery,
  type SharedRemindersEdgePluginOptions,
  sharedGroupReminderMessageText,
  sharedReminderMaxBodyLength,
} from "./shared-reminders.js";

const NOW = "2026-08-14T20:00:00.000Z";
const BINDING_ID = "8b8f2c69-6a3e-4a0f-9be1-1f8f6a3e4a0f";

const telegramGroupDelivery = {
  platform: "telegram",
  kind: "group",
  project: "eliza-app",
  chatId: "-100123456789",
  groupBindingId: BINDING_ID,
  ownerLabel: "Nubs",
} as const;

const blooioGroupDelivery = {
  platform: "blooio",
  kind: "group",
  project: "eliza-app",
  chatId: "chat_group_123",
  groupBindingId: BINDING_ID,
  ownerLabel: "Nubs",
} as const;

function scheduledTask(input: ScheduledTaskInput): ScheduledTask {
  return {
    taskId: "reminder-1",
    ...input,
    state: { status: "scheduled", followupCount: 0 },
  };
}

function harness(delivery: SharedReminderDelivery): {
  options: SharedRemindersEdgePluginOptions;
  scheduleWithResult: ReturnType<typeof vi.fn>;
} {
  const scheduleWithResult = vi.fn(async (input: ScheduledTaskInput) => ({
    task: scheduledTask(input),
    commit: { logId: "scheduled-log-1", occurredAtIso: NOW },
    replayed: false,
  }));
  const runner = {
    scheduleWithResult,
    list: vi.fn(async () => []),
    applyWithResult: vi.fn(),
    pipeline: vi.fn(async () => []),
  } as unknown as ScheduledTaskRunner;
  return {
    scheduleWithResult,
    options: {
      runner,
      agentId: "personal:user-1",
      delivery,
      now: () => new Date(NOW),
    },
  };
}

describe("Shared group reminder delivery parsing", () => {
  it("round-trips trusted Telegram and Blooio group destinations", () => {
    expect(parseSharedReminderDelivery(telegramGroupDelivery)).toEqual(
      telegramGroupDelivery,
    );
    expect(parseSharedReminderDelivery(blooioGroupDelivery)).toEqual(
      blooioGroupDelivery,
    );
    expect(isSharedGroupReminderDelivery(telegramGroupDelivery)).toBe(true);
    expect(
      isSharedGroupReminderDelivery({
        platform: "telegram",
        project: "eliza-app",
        chatId: "123456",
      }),
    ).toBe(false);
  });

  it("rejects malformed or platform-mismatched group destinations", () => {
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        chatId: "@channelname",
      }),
    ).toBeUndefined();
    expect(
      parseSharedReminderDelivery({
        ...blooioGroupDelivery,
        chatId: "+15551234567",
      }),
    ).toBeUndefined();
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        chatId: "chat_group_123",
      }),
    ).toBeUndefined();
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        groupBindingId: "not-a-uuid",
      }),
    ).toBeUndefined();
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        ownerLabel: "   ",
      }),
    ).toBeUndefined();
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        ownerLabel: "x".repeat(129),
      }),
    ).toBeUndefined();
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        platform: "discord",
      }),
    ).toBeUndefined();
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        project: "bad project!",
      }),
    ).toBeUndefined();
  });

  it("strips Markdown formatting and link syntax from the owner label", () => {
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        ownerLabel: "[Nubs](https://evil.example)",
      }),
    ).toMatchObject({ ownerLabel: "Nubshttps://evil.example" });
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        ownerLabel: "*bold*  _sneaky_ `code`",
      }),
    ).toMatchObject({ ownerLabel: "bold sneaky code" });
    expect(
      parseSharedReminderDelivery({
        ...telegramGroupDelivery,
        ownerLabel: "*_`[]()",
      }),
    ).toMatchObject({ ownerLabel: "the group owner" });
  });

  it("still parses the existing private-chat destinations unchanged", () => {
    expect(
      parseSharedReminderDelivery({
        platform: "telegram",
        project: "eliza-app",
        chatId: "123456",
      }),
    ).toEqual({ platform: "telegram", project: "eliza-app", chatId: "123456" });
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
    ).toEqual({ platform: "discord", discordUserId: "123456789012345678" });
  });
});

describe("Shared group reminder action", () => {
  it("pins a group-created reminder to its trusted group destination", async () => {
    const { options, scheduleWithResult } = harness(telegramGroupDelivery);
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-1" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "Stand-up starts",
          inMinutes: 5,
          chatId: "attacker-chat",
          platform: "discord",
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toBe(
      "Got it — I'll remind this group in 5 minutes: Stand-up starts",
    );
    expect(action?.description).toContain("this linked group chat");
    expect(scheduleWithResult).toHaveBeenCalledTimes(1);
    expect(scheduleWithResult.mock.calls[0]?.[0]?.metadata).toEqual({
      delivery: telegramGroupDelivery,
    });
  });

  it("reserves the fire-time owner prefix inside the connector text budget", async () => {
    const budget = sharedReminderMaxBodyLength(telegramGroupDelivery);
    expect(budget).toBe(
      SHARED_REMINDER_MAX_TEXT_LENGTH -
        "Reminder for this group from Nubs: ".length,
    );
    expect(
      sharedGroupReminderMessageText(telegramGroupDelivery, "x".repeat(budget))
        .length,
    ).toBe(SHARED_REMINDER_MAX_TEXT_LENGTH);
    expect(
      sharedReminderMaxBodyLength({
        platform: "telegram",
        project: "eliza-app",
        chatId: "123456",
      }),
    ).toBe(SHARED_REMINDER_MAX_TEXT_LENGTH);

    const { options, scheduleWithResult } = harness(telegramGroupDelivery);
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const rejected = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-2" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "x".repeat(budget + 1),
          inMinutes: 5,
        },
      },
    );
    expect(rejected?.success).toBe(false);
    expect(rejected?.text).toBe(
      `Reminder text must be ${budget} characters or fewer.`,
    );
    expect(scheduleWithResult).not.toHaveBeenCalled();

    const accepted = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-3" } as Memory,
      undefined,
      {
        parameters: {
          operation: "create",
          reminderText: "x".repeat(budget),
          inMinutes: 5,
        },
      },
    );
    expect(accepted?.success).toBe(true);
    expect(scheduleWithResult).toHaveBeenCalledTimes(1);
  });

  it("refuses to build the action from an unparseable group destination", () => {
    const { options } = harness({
      ...telegramGroupDelivery,
      groupBindingId: "not-a-uuid",
    } as unknown as SharedReminderDelivery);
    expect(() => createSharedRemindersEdgePlugin(options)).toThrow(
      "Shared reminders require a trusted server-owned destination",
    );
  });
});

describe("group dispatch failure policy", () => {
  it("keeps an inactive-binding failure visible and terminal for a reminder ladder", () => {
    const failure = {
      ok: false as const,
      reason: "unknown_recipient" as const,
      userActionable: true,
      acceptance: "not_accepted" as const,
      message: "This group is no longer linked to Eliza.",
    };
    // Step 0 surfaces the degradation to the owner; the final ladder step has
    // nowhere left to advance, so the runner settles the task as failed
    // rather than recording a silent fire.
    expect(
      decideDispatchPolicy(failure, { currentStepIndex: 0, totalSteps: 2 }),
    ).toMatchObject({ kind: "surface_degraded", reason: "unknown_recipient" });
    expect(
      decideDispatchPolicy(failure, { currentStepIndex: 1, totalSteps: 2 }),
    ).toMatchObject({ kind: "surface_degraded", reason: "unknown_recipient" });
  });
});
