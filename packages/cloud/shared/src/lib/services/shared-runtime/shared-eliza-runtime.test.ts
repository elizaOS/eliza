/**
 * Exercises the production Shared model adapter through the real AgentRuntime
 * message pipeline while a deterministic HTTP boundary stands in for Cerebras.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ScheduledTaskRunner } from "@elizaos/plugin-scheduling/edge";

const scheduledInputs: Array<Record<string, unknown>> = [];
const reminderRunner = {
  async schedule(input: Record<string, unknown>) {
    scheduledInputs.push(input);
    return {
      taskId: "shared-reminder-1",
      ...input,
      state: { status: "scheduled", followupCount: 0 },
    };
  },
  async list() {
    return [];
  },
  async apply() {
    throw new Error("Reminder mutation is outside this runtime planning test");
  },
  async pipeline() {
    return [];
  },
} satisfies ScheduledTaskRunner;

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

beforeEach(() => {
  scheduledInputs.length = 0;
  process.env.CEREBRAS_API_KEY = "shared-runtime-test-key";
  process.env.NODE_ENV = "production";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_CEREBRAS_KEY === undefined) delete process.env.CEREBRAS_API_KEY;
  else process.env.CEREBRAS_API_KEY = ORIGINAL_CEREBRAS_KEY;
});

describe("Shared Eliza Workerd runtime", () => {
  test("runs HANDLE_RESPONSE through AgentRuntime and preserves native usage", async () => {
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-shared-runtime",
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
                    id: "shared-handle-response",
                    type: "function",
                    function: {
                      name: "HANDLE_RESPONSE",
                      arguments: JSON.stringify({
                        shouldRespond: "RESPOND",
                        thought: "The genuine Shared runtime handled this turn.",
                        contexts: ["simple"],
                        intents: [],
                        candidateActionNames: [],
                        replyText: "hello from the genuine Shared runtime",
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
          usage: {
            prompt_tokens: 41,
            completion_tokens: 17,
            total_tokens: 58,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const { runSharedAgentTurn } = await import("./run-shared-agent-turn");
    let dispatches = 0;
    const result = await runSharedAgentTurn({
      character: {
        name: "Shared Eliza",
        system: "You are Eliza.",
        model: "gemma-4-31b",
      },
      history: [],
      message: "say hello",
      messageIds: {
        user: "c92f5aaa-59ce-40a6-994b-e9e16dc85198",
        assistant: "f492130b-2fc6-4b2b-bdca-51f441b0483d",
      },
      onProviderDispatch: async () => {
        dispatches += 1;
      },
      execution: {
        engine: "eliza-runtime",
        agentKey: "personal:39e40424-28eb-41fc-8844-63d16e84e14f",
      },
    });

    expect(result.reply).toBe("hello from the genuine Shared runtime");
    expect(result.model).toBe("gemma-4-31b");
    expect(result.degraded).toBe(false);
    expect(result.usage).toEqual({
      promptTokens: 41,
      completionTokens: 17,
      totalTokens: 58,
      inputTokens: 41,
      outputTokens: 17,
    });
    expect(result.history.map((message) => message.content)).toEqual([
      "say hello",
      "hello from the genuine Shared runtime",
    ]);
    expect(dispatches).toBe(1);
    expect(requests).toHaveLength(1);
    expect(
      (requests[0].tools as Array<{ function?: { name?: string } }>).some(
        (tool) => tool.function?.name === "HANDLE_RESPONSE",
      ),
    ).toBe(true);
  });

  test("plans WEB_SEARCH and grounds the final reply in the free search result", async () => {
    const modelRequests: Array<Record<string, unknown>> = [];
    const searchRequests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "https://search.parallel.ai/mcp") {
        searchRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          jsonrpc: "2.0",
          id: "shared-web-search",
          result: {
            content: [
              {
                type: "text",
                text: "ElizaOS launched a new public release today. Source: https://elizaos.ai/news",
              },
            ],
          },
        });
      }

      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      modelRequests.push(request);
      const call = modelRequests.length;
      if (call === 1) {
        return Response.json({
          id: "chatcmpl-shared-search-stage-one",
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
                    id: "shared-search-handle-response",
                    type: "function",
                    function: {
                      name: "HANDLE_RESPONSE",
                      arguments: JSON.stringify({
                        shouldRespond: "RESPOND",
                        thought: "Current information requires public web search.",
                        contexts: ["web"],
                        intents: [],
                        candidateActionNames: ["WEB_SEARCH"],
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
      if (call === 2) {
        return Response.json({
          id: "chatcmpl-shared-search-plan",
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
                    id: "shared-search-action",
                    type: "function",
                    function: {
                      name: "WEB_SEARCH",
                      arguments: JSON.stringify({ query: "latest ElizaOS news" }),
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
        id: "chatcmpl-shared-search-finish",
        object: "chat.completion",
        created: 0,
        model: "gemma-4-31b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                call === 5
                  ? "A new ElizaOS public release was announced today, according to the project news page."
                  : JSON.stringify({
                      success: true,
                      decision: "FINISH",
                      thought: "Answer from the public result.",
                      messageToUser:
                        "A new ElizaOS public release was announced today, according to the project news page.",
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
      message: "What is the latest ElizaOS news?",
      messageIds: {
        user: "6328e4cb-4a1f-4d9c-a2fd-769e5fd33aa1",
        assistant: "059e33bc-8215-49f4-841f-7642e7505bc7",
      },
      execution: {
        engine: "eliza-runtime",
        agentKey: "personal:b55d99d0-ae38-4c7c-8791-7443e5de8ebc",
      },
    });

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: { objective: "latest ElizaOS news" },
      },
    });
    expect(result.reply).toBe(
      "A new ElizaOS public release was announced today, according to the project news page.",
    );
    expect(modelRequests).toHaveLength(3);
    expect(result.usage).toMatchObject({
      promptTokens: 120,
      completionTokens: 36,
      totalTokens: 156,
    });
  });

  test("plans REMINDERS through the genuine plugin and pins the current private chat", async () => {
    const modelRequests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      modelRequests.push(request);
      const call = modelRequests.length;
      if (call === 1) {
        return Response.json({
          id: "chatcmpl-shared-reminder-stage-one",
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
                    id: "shared-reminder-handle-response",
                    type: "function",
                    function: {
                      name: "HANDLE_RESPONSE",
                      arguments: JSON.stringify({
                        shouldRespond: "RESPOND",
                        thought: "The user asked for a reminder.",
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
      if (call === 2) {
        return Response.json({
          id: "chatcmpl-shared-reminder-plan",
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
                    id: "shared-reminder-action",
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
        id: "chatcmpl-shared-reminder-finish",
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
                messageToUser: "i'll remind you in two minutes",
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
      message: "remind me in two minutes to stand up and stretch",
      messageIds: {
        user: "7d734b8f-1ac5-456a-8bf3-9cd61dd546ef",
        assistant: "83de2c02-ec48-48d6-a734-c665b27d23cf",
      },
      execution: {
        engine: "eliza-runtime",
        agentKey: "personal:a26524f1-c4f1-493b-a97e-8be161284a10",
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

    expect(result.reply).toBe("i'll remind you in two minutes");
    expect(scheduledInputs).toHaveLength(1);
    expect(scheduledInputs[0]).toMatchObject({
      kind: "reminder",
      promptInstructions: "stand up and stretch",
      trigger: { kind: "once" },
      output: { destination: "channel", target: "current_dm" },
      metadata: {
        delivery: {
          platform: "telegram",
          project: "eliza-app",
          chatId: "123456789",
        },
      },
    });
    expect(modelRequests).toHaveLength(4);
    expect(
      (modelRequests[1].tools as Array<{ function?: { name?: string } }>).some(
        (tool) => tool.function?.name === "REMINDERS",
      ),
    ).toBe(true);
  });
});
