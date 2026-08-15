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
  schedule: ReturnType<typeof vi.fn>;
} {
  const schedule = vi.fn(async (input: ScheduledTaskInput) =>
    scheduledTask(input),
  );
  const runner: ScheduledTaskRunner = {
    schedule,
    list: vi.fn(async () => []),
    apply: vi.fn(async () => {
      throw new Error("not used");
    }),
    pipeline: vi.fn(async () => []),
  };
  return {
    schedule,
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
  it("creates one canonical task and pins delivery to the trusted current DM", async () => {
    const { options, schedule } = harness();
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
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[0]).toMatchObject({
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
  });

  it("rejects a create without structural timing instead of guessing", async () => {
    const { options, schedule } = harness();
    const [action] = createSharedRemindersEdgePlugin(options).actions ?? [];
    const result = await action?.handler(
      {} as IAgentRuntime,
      { id: "message-2" } as Memory,
      undefined,
      { parameters: { operation: "create", reminderText: "Call mom someday" } },
    );

    expect(result).toMatchObject({ success: false });
    expect(schedule).not.toHaveBeenCalled();
  });
});
