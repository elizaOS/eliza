/**
 * Exercises the production Shared model adapter through the real AgentRuntime
 * message pipeline while a deterministic HTTP boundary stands in for Cerebras.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

beforeEach(() => {
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
});
