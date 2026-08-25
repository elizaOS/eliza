/** Drives the genuine Shared AgentRuntime reminder action with a fixed clock and deterministic model boundary. */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { ChannelType } from "@elizaos/core/edge";
import type { ScheduledTaskRunner } from "@elizaos/plugin-scheduling/edge";

const NOW = "2026-08-16T04:48:56.509Z";
const scheduledInputs: Array<Record<string, unknown>> = [];
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

const reminderRunner = {
  async scheduleWithResult(input: Record<string, unknown>) {
    scheduledInputs.push(input);
    const task = {
      taskId: "shared-reminder-relative-delay-1",
      ...input,
      state: { status: "scheduled" as const, followupCount: 0 },
    };
    return {
      task,
      commit: {
        logId: "shared-reminder-relative-delay-log-1",
        taskId: task.taskId,
        agentId: "personal:a26524f1-c4f1-493b-a97e-8be161284a10",
        occurredAtIso: NOW,
        transition: "scheduled" as const,
        rolledUp: false,
      },
      replayed: false,
    };
  },
  async schedule(input: Record<string, unknown>) {
    return (await this.scheduleWithResult(input)).task;
  },
  async list() {
    return [];
  },
  async apply() {
    throw new Error("Reminder mutation is outside this runtime creation proof");
  },
  async applyWithResult() {
    throw new Error("Reminder mutation is outside this runtime creation proof");
  },
  async pipeline() {
    return [];
  },
} satisfies ScheduledTaskRunner;

beforeEach(() => {
  scheduledInputs.length = 0;
  setSystemTime(new Date(NOW));
  process.env.CEREBRAS_API_KEY = "shared-runtime-relative-delay-test-key";
  process.env.NODE_ENV = "production";
});

afterEach(() => {
  setSystemTime();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_CEREBRAS_KEY === undefined) delete process.env.CEREBRAS_API_KEY;
  else process.env.CEREBRAS_API_KEY = ORIGINAL_CEREBRAS_KEY;
});

describe("Shared reminder relative-delay runtime authority", () => {
  test.each([
    {
      label: "persists literal one minute even when the planner emits two",
      message: "Remind me in 1 minute: stand up and stretch.",
      atIso: "2026-08-16T04:49:56.509Z",
    },
    {
      label: "persists a compound duration as one exact delay",
      message: "Remind me to stretch in 1 minute and 30 seconds.",
      atIso: "2026-08-16T04:50:26.509Z",
    },
    {
      label: "persists the final explicit duration revision",
      message: "Remind me in 1 minute, actually make that 2 minutes.",
      atIso: "2026-08-16T04:50:56.509Z",
    },
    {
      label: "rejects a negated command before scheduler persistence",
      message: "I do not want you to remind me in 1 minute.",
      atIso: undefined,
    },
    {
      label: "rejects a later cancellation before scheduler persistence",
      message: "Remind me in 1 minute, actually do not remind me.",
      atIso: undefined,
    },
    {
      label: "rejects a cancellation synonym before scheduler persistence",
      message: "Remind me in 1 minute. Please, actually cancel that.",
      atIso: undefined,
    },
  ])("$label", async ({ message, atIso }) => {
    let modelCall = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      JSON.parse(String(init?.body));
      modelCall += 1;
      if (modelCall === 1) {
        return Response.json({
          id: "chatcmpl-relative-delay-stage-one",
          object: "chat.completion",
          created: 0,
          model: "gemma-4-31b",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "relative-delay-handle-response",
                    type: "function",
                    function: {
                      name: "HANDLE_RESPONSE",
                      arguments: JSON.stringify({
                        shouldRespond: "RESPOND",
                        thought: "The user requested a reminder.",
                        contexts: ["reminders"],
                        intents: [],
                        candidateActionNames: ["REMINDERS"],
                        requiresTool: true,
                        replyText: "",
                        replyEffectStatus: "none",
                        facts: [],
                        relationships: [],
                        addressedTo: [],
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
        });
      }
      if (modelCall === 2) {
        return Response.json({
          id: "chatcmpl-relative-delay-plan",
          object: "chat.completion",
          created: 0,
          model: "gemma-4-31b",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "relative-delay-reminder-action",
                    type: "function",
                    function: {
                      name: "REMINDERS",
                      arguments: JSON.stringify({
                        operation: "create",
                        reminderText: "stand up and stretch",
                        inMinutes: 2,
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        });
      }
      return Response.json({
        id: "chatcmpl-relative-delay-finish",
        object: "chat.completion",
        created: 0,
        model: "gemma-4-31b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                success: true,
                decision: "FINISH",
                thought: "The reminder is stored.",
                messageToUser: "Reminder saved.",
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 14, total_tokens: 64 },
      });
    }) as typeof fetch;

    const { runSharedAgentTurn } = await import("./run-shared-agent-turn");
    const result = await runSharedAgentTurn({
      character: {
        name: "Shared Eliza",
        system: "You are Eliza.",
        model: "gemma-4-31b",
      },
      history: [],
      message,
      messageIds: {
        user: "7d734b8f-1ac5-456a-8bf3-9cd61dd546ef",
        assistant: "83de2c02-ec48-48d6-a734-c665b27d23cf",
      },
      execution: {
        channel: { type: ChannelType.DM, source: "shared-runtime" },
        agentKey: "personal:a26524f1-c4f1-493b-a97e-8be161284a10",
        roomKey: "personal:a26524f1-c4f1-493b-a97e-8be161284a10",
        reminders: {
          runner: reminderRunner,
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            chatId: "123456789",
          },
        },
      },
    });

    if (atIso === undefined) {
      expect(modelCall).toBeGreaterThanOrEqual(3);
      expect(result.actionResults?.[0]?.success).toBe(false);
      expect(scheduledInputs).toHaveLength(0);
    } else {
      // Two model calls, not three: the REMINDERS action returns a verified
      // user-facing confirmation (`verifiedUserFacing: true`), and the planner
      // loop finishes deterministically by echoing that verbatim text instead
      // of spending a third model call on the completion evaluator.
      expect(modelCall).toBe(2);
      expect(result.actionResults?.[0]?.success).toBe(true);
      expect(scheduledInputs).toHaveLength(1);
      expect(scheduledInputs[0]?.trigger).toEqual({ kind: "once", atIso });
    }
  });
});
