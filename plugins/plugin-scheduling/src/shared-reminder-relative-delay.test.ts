/** Verifies user-authored relative delays and their action-level authority without a model stub. */

import type { IAgentRuntime, Memory } from "@elizaos/core/edge";
import { describe, expect, it, vi } from "vitest";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRunner,
} from "./scheduled-task/types.js";
import { resolveExplicitSharedReminderDelay } from "./shared-reminder-relative-delay.js";
import { createSharedRemindersEdgePlugin } from "./shared-reminders.js";

const NOW = "2026-08-16T04:48:56.509Z";

describe("explicit Shared reminder relative delay", () => {
  it.each([
    ["Remind me in 1 minute: stretch.", 60_000],
    ["Please remind me in 2 minutes to stretch.", 120_000],
    ["Please remind me in two minutes to stretch.", 120_000],
    ["Set a reminder in 90 seconds to check the oven.", 90_000],
    ["Create me a reminder in 2 hours to call mom.", 7_200_000],
    ["Add a reminder in 1.5 hours to leave.", 5_400_000],
    ["In one minute, remind me to stand up.", 60_000],
    ["In an hour remind me to leave.", 3_600_000],
    ["Remind me to stretch in 1 minute.", 60_000],
    ["Set a reminder to call mom in two hours.", 7_200_000],
  ])("resolves %s", (text, milliseconds) => {
    expect(resolveExplicitSharedReminderDelay(text)).toEqual({
      kind: "resolved",
      milliseconds,
    });
  });

  it.each([
    "Remind me in 0 minutes to stretch.",
    "Remind me in -1 minute to stretch.",
    "Remind me in 0.0001 seconds to stretch.",
    "Remind me in banana minutes to stretch.",
    "Remind me in 1e3 minutes to stretch.",
    "Remind me in 999999999999999 hours to stretch.",
  ])("fails closed for invalid delay %s", (text) => {
    expect(resolveExplicitSharedReminderDelay(text)).toMatchObject({
      kind: "invalid",
    });
  });

  it.each([
    'Use the example "remind me in 2 minutes" in the documentation.',
    "For example: remind me in 2 minutes.",
    "Remind me tomorrow to stretch for five minutes.",
    "Remind me at 3pm to check in with the team for 30 minutes.",
  ])(
    "does not treat quoted, example, or body duration text as timing: %s",
    (text) => {
      expect(resolveExplicitSharedReminderDelay(text)).toEqual({
        kind: "absent",
      });
    },
  );

  it.each([
    "Do not remind me in 1 minute.",
    "Don't remind me in 1 minute.",
    "Never remind me in 1 minute.",
  ])("fails closed for a negated reminder command: %s", (text) => {
    expect(resolveExplicitSharedReminderDelay(text)).toEqual({
      kind: "invalid",
      reason: "A negated reminder command cannot create a reminder.",
    });
  });

  it("rejects multiple relative reminder directives", () => {
    expect(
      resolveExplicitSharedReminderDelay(
        "Remind me in 1 minute to stretch, then remind me in 2 hours to leave.",
      ),
    ).toEqual({
      kind: "invalid",
      reason: "Use exactly one relative delay for a reminder.",
    });
  });

  it.each([
    "Remind me in 1 minute and 30 seconds to stretch.",
    "Remind me in 1 minute and in 2 hours to stretch.",
    "Remind me in 1 minute or in 2 minutes to stretch.",
  ])(
    "rejects compound relative delays instead of truncating them: %s",
    (text) => {
      expect(resolveExplicitSharedReminderDelay(text)).toMatchObject({
        kind: "invalid",
      });
    },
  );

  it("uses the authenticated utterance instead of a conflicting planner delay", async () => {
    const scheduleWithResult = vi.fn(async (input: ScheduledTaskInput) => ({
      task: {
        taskId: "reminder-1",
        ...input,
        state: { status: "scheduled", followupCount: 0 },
      } satisfies ScheduledTask,
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
      schedule: vi.fn(),
      list: vi.fn(async () => []),
      apply: vi.fn(),
      pipeline: vi.fn(async () => []),
    };
    const [action] =
      createSharedRemindersEdgePlugin({
        runner,
        agentId: "personal:user-1",
        delivery: {
          platform: "telegram",
          project: "eliza-app",
          chatId: "123456",
        },
        now: () => new Date(NOW),
      }).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "message-1",
        content: { text: "Remind me in 1 minute: stretch." },
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

    expect(result?.success).toBe(true);
    expect(scheduleWithResult).toHaveBeenCalledOnce();
    expect(scheduleWithResult.mock.calls[0]?.[0].trigger).toEqual({
      kind: "once",
      atIso: "2026-08-16T04:49:56.509Z",
    });
  });

  it.each([
    [
      "an ambiguous utterance",
      "Remind me in 1 minute, then remind me in 2 minutes.",
    ],
    ["a negated command", "Do not remind me in 1 minute."],
  ])("rejects %s before persistence", async (_label, text) => {
    const scheduleWithResult = vi.fn(async (_input: ScheduledTaskInput) => {
      throw new Error("Ambiguous reminder must not be scheduled");
    });
    const runner: ScheduledTaskRunner = {
      scheduleWithResult,
      schedule: vi.fn(async () => {
        throw new Error("Ambiguous reminder must not be scheduled");
      }),
      list: vi.fn(async () => []),
      apply: vi.fn(async () => {
        throw new Error("Ambiguous reminder must not be mutated");
      }),
      pipeline: vi.fn(async () => []),
    };
    const [action] =
      createSharedRemindersEdgePlugin({
        runner,
        agentId: "personal:user-1",
        delivery: {
          platform: "discord",
          discordUserId: "123456789012345678",
        },
        now: () => new Date(NOW),
      }).actions ?? [];

    const result = await action?.handler(
      {} as IAgentRuntime,
      {
        id: "message-2",
        content: { text },
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

    expect(result).toMatchObject({ success: false });
    expect(scheduleWithResult).not.toHaveBeenCalled();
  });
});
