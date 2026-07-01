/**
 * Offline unit coverage for the non-streaming planner tool-call contract.
 *
 * The real cerebras `/chat/completions` (non-streaming) response carries the
 * planner's decision as `choices[0].message.tool_calls[]`, where each entry is
 * an OpenAI-shaped `{ id, type:"function", function:{ name, arguments } }` and
 * `arguments` is a JSON *string*. `extractNativeToolCalls` (in
 * `src/models/text.ts`) is the private parser that turns that wire shape into
 * the runtime's `{ toolName, input }` tool calls — the thing the action planner
 * actually consumes.
 *
 * Until now that contract was only checked by the LIVE suite in
 * `text-native-plumbing.test.ts`, which is `it.skip`-ped whenever
 * `ELIZAOS_CLOUD_API_KEY` is unset (CI default) — so the parser was never
 * CI-tested against a representative cerebras body. This drives the same
 * non-streaming planner path with a mocked `globalThis.fetch` (same technique
 * as `text-cerebras-response-format.test.ts`) and pins the parse result.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleActionPlanner } from "../../src/models/text";

type RuntimeFixture = Pick<IAgentRuntime, "character" | "emitEvent" | "getSetting"> &
  Partial<IAgentRuntime>;

function runtime(): IAgentRuntime {
  const settings: Record<string, string | undefined> = {
    ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
  };
  const fixture: RuntimeFixture = {
    character: { name: "Eliza", bio: [] },
    getSetting: (key: string) => settings[key],
    emitEvent: vi.fn(),
  };
  return fixture as IAgentRuntime;
}

/**
 * A representative real cerebras NON-streaming `/chat/completions` body: the
 * planner's tool decision lands in `message.tool_calls[0]` as an OpenAI-shaped
 * function call whose `arguments` is a JSON *string* (not an object).
 */
function cerebrasToolCallResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-oss-120b",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc123",
                type: "function",
                function: {
                  name: "PLAN_ACTIONS",
                  arguments: JSON.stringify({
                    actions: [{ action: "REPLY", thought: "greet the user" }],
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

const PLANNER_PARAMS = {
  prompt: "fallback prompt",
  system: "You are a planner. You MUST call the PLAN_ACTIONS tool.",
  messages: [{ role: "user", content: "Plan one REPLY action." }],
  tools: [
    {
      type: "function",
      function: {
        name: "PLAN_ACTIONS",
        description: "Plan actions",
        parameters: {
          type: "object",
          properties: { actions: { type: "array" } },
          required: ["actions"],
        },
      },
    },
  ],
  toolChoice: { type: "tool", toolName: "PLAN_ACTIONS" },
};

describe("non-streaming planner tool-call shape (offline)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses cerebras choices[0].message.tool_calls into { toolName, input }", async () => {
    let chatCompletionsHit = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/chat/completions")) {
          chatCompletionsHit = true;
          return cerebrasToolCallResponse();
        }
        throw new Error(`unexpected fetch to ${url}`);
      }
    );

    const result = await handleActionPlanner(runtime(), PLANNER_PARAMS as never);

    // The planner path must hit the native /chat/completions route, not /responses.
    expect(chatCompletionsHit).toBe(true);

    // tools/toolChoice make this a native call that returns the rich result
    // object (not a bare string), with parsed tool calls.
    expect(result).toBeTypeOf("object");
    expect(result).not.toBeNull();
    const toolCalls = (result as { toolCalls?: Array<{ toolName: string; input: unknown }> })
      .toolCalls;
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls).toHaveLength(1);

    const call = toolCalls?.[0];
    // The toolName comes from the OpenAI `function.name`.
    expect(call?.toolName).toBe("PLAN_ACTIONS");
    // The JSON-string `arguments` is parsed into a real object (the planner
    // consumes `input`, not a raw string).
    expect(call?.input).toEqual({
      actions: [{ action: "REPLY", thought: "greet the user" }],
    });
  });
});
