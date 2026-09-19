/**
 * Exercises core's inactive-field schema through the real response handler and
 * AI SDK transport. The rejecting provider fixture reproduces the structured-enum
 * admission failure; accepted calls preserve the complete prompt and tool result.
 */
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../packages/core/src/database/inMemoryAdapter";
import { AgentRuntime } from "../../../packages/core/src/runtime";
import { withInactiveArrayFields } from "../../../packages/core/src/services/message/inactive-field-schema";
import type { JSONSchema } from "../../../packages/core/src/types/model";
import { handleResponseHandler } from "../models/text";

afterEach(() => vi.restoreAllMocks());

it("admits an inactive array without losing the prompt or weakening the active tool", async () => {
  const bodies: Array<{
    messages: Array<{ role: string; content: string }>;
    tools: Array<{ function: { parameters: JSONSchema } }>;
  }> = [];
  const returned = { replyText: "Complete reply 🧭", threadOps: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    if (url.hostname !== "schema.fixture.invalid") throw new Error("Unexpected provider endpoint");
    if (typeof init?.body !== "string") throw new Error("Missing serialized SDK request");
    const body: (typeof bodies)[number] = JSON.parse(init.body);
    bodies.push(body);
    const field = body.tools[0].function.parameters.properties?.threadOps;
    if (!field) throw new Error("Missing threadOps contract");
    const rejected = Array.isArray(field.enum) && field.enum.some(Array.isArray);
    return new Response(
      JSON.stringify(
        rejected
          ? {
              error: {
                message: "Invalid schema for function HANDLE_RESPONSE: structured enum",
                type: "invalid_request_error",
                code: "invalid_function_parameters",
              },
            }
          : {
              id: "inactive-array-wire",
              object: "chat.completion",
              created: 1,
              model: "fixture",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-response",
                        type: "function",
                        function: { name: "HANDLE_RESPONSE", arguments: JSON.stringify(returned) },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            }
      ),
      { status: rejected ? 400 : 200, headers: { "content-type": "application/json" } }
    );
  });
  const runtime = new AgentRuntime({
    character: {
      name: "InactiveArrayWire",
      bio: "test",
      settings: {
        ELIZA_PROVIDER: "openai",
        OPENAI_API_KEY: "fixture-key",
        OPENAI_BASE_URL: "https://schema.fixture.invalid/v1",
      },
    },
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
  });
  try {
    const prompt = `${"Preserve complete user context 🧭.\n".repeat(500)}Final instruction: reply with the complete answer.`;
    const active: JSONSchema = {
      type: "object",
      additionalProperties: false,
      required: ["replyText", "threadOps"],
      properties: {
        replyText: { type: "string" },
        threadOps: { type: "array", items: { type: "string" } },
      },
    };
    const call = (parameters: JSONSchema) =>
      handleResponseHandler(runtime, {
        model: "fixture",
        prompt,
        tools: [{ name: "HANDLE_RESPONSE", description: "Respond", parameters }],
        toolChoice: "required",
      });
    await expect(
      call({
        ...active,
        properties: {
          ...active.properties,
          threadOps: { type: "array", items: { type: "string" }, enum: [[]] },
        },
      })
    ).rejects.toThrow(/structured enum/);
    expect(bodies).toHaveLength(1);
    const result = await call(withInactiveArrayFields(active, ["threadOps"]));
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error("Expected native tool result");
    expect(await result.toolCalls).toEqual([
      expect.objectContaining({ toolName: "HANDLE_RESPONSE", input: returned }),
    ]);
    expect(bodies).toHaveLength(2);
    for (const body of bodies)
      expect(body.messages.find((message) => message.role === "user")?.content).toBe(prompt);
    const wire = bodies[1].tools[0].function.parameters;
    expect(wire.required).toEqual(active.required);
    expect(wire.properties?.replyText).toEqual(active.properties?.replyText);
    expect(wire.properties?.threadOps?.description).toContain("at most 0 items");
    expect(active.properties?.threadOps).toEqual({ type: "array", items: { type: "string" } });
  } finally {
    await runtime.stop();
  }
});
