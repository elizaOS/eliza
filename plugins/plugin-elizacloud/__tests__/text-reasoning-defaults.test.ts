import { buildPlannerToolsFromActions, type IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleResponseHandler, normalizeNativeTools } from "../src/models/text";

afterEach(() => vi.restoreAllMocks());

describe("Cerebras Cloud reasoning controls", () => {
  it.each([
    [undefined, undefined, "high"],
    ["low", undefined, "low"],
    ["none", undefined, "none"],
    ["high", "off", "none"],
  ] as const)(
    "preserves effort %s and thinking %s on the wire",
    async (effort, thinking, expected) => {
      const settings: Record<string, string | undefined> = {
        ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
        ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "qwen-3.8-27b",
        ELIZAOS_CLOUD_REASONING_EFFORT: effort,
      };
      const runtime = {
        character: { name: "Reasoning test", bio: [] },
        getSetting: (key: string) => settings[key],
        emitEvent: vi.fn(),
      } as unknown as IAgentRuntime;
      const requests: Record<string, unknown>[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: "synthetic-response",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        });
      });
      await handleResponseHandler(runtime, {
        messages: [{ role: "user", content: "Reply ok" }],
        providerOptions: { eliza: thinking ? { thinking } : {} },
        stream: false,
      } as never);
      expect(requests).toHaveLength(1);
      expect(requests[0].reasoning_effort).toBe(expected);
      expect(requests[0]).not.toHaveProperty("max_tokens");
      expect(requests[0]).not.toHaveProperty("max_completion_tokens");
    }
  );
});

describe("Cloud native tool strictness", () => {
  const parameters = {
    type: "object",
    additionalProperties: false,
    properties: { replyText: { type: "array", items: { type: "string" } } },
    required: ["replyText"],
  };

  it.each([
    ["flat true", { name: "HANDLE_RESPONSE", strict: true }, true],
    ["flat false", { name: "HANDLE_RESPONSE", strict: false }, false],
    ["nested true", { function: { name: "HANDLE_RESPONSE", strict: true } }, true],
    [
      "nested false overrides flat true",
      {
        strict: true,
        function: { name: "HANDLE_RESPONSE", strict: false },
      },
      false,
    ],
    [
      "invalid nested falls back to flat boolean",
      {
        strict: true,
        function: { name: "HANDLE_RESPONSE", strict: "true" },
      },
      true,
    ],
    ["absent", { name: "HANDLE_RESPONSE" }, undefined],
    ["invalid string", { name: "HANDLE_RESPONSE", strict: "true" }, undefined],
    ["invalid number", { name: "HANDLE_RESPONSE", strict: 0 }, undefined],
    [
      "invalid nested and flat",
      {
        strict: "false",
        function: { name: "HANDLE_RESPONSE", strict: 1 },
      },
      undefined,
    ],
  ] as const)("%s preserves only explicit boolean strictness", (_label, tool, expected) => {
    const input = { ...tool, parameters };
    const before = structuredClone(input);
    const normalized = normalizeNativeTools([input]) as Array<{
      type: string;
      function: { name: string; parameters: unknown; strict?: boolean };
    }>;
    expect(normalized).toHaveLength(1);
    expect(normalized[0].type).toBe("function");
    expect(normalized[0].function.name).toBe("HANDLE_RESPONSE");
    expect(normalized[0].function.parameters).toBe(parameters);
    if (expected === undefined) {
      expect(normalized[0].function).not.toHaveProperty("strict");
    } else {
      expect(normalized[0].function.strict).toBe(expected);
    }
    expect(input).toEqual(before);
  });

  it("omits strict true for core action tools with optional parameters", () => {
    const [tool] = buildPlannerToolsFromActions([
      {
        name: "SEARCH_NOTES",
        description: "Search notes.",
        parameters: [
          {
            name: "query",
            description: "Search text.",
            required: false,
            schema: { type: "string" },
          },
        ],
      },
    ]);
    expect(tool.strict).toBe(true);
    const normalized = normalizeNativeTools([tool]) as Array<{
      function: { name: string; parameters: unknown; strict?: boolean };
    }>;
    expect(normalized[0].function.name).toBe("SEARCH_NOTES");
    expect(normalized[0].function.parameters).toBe(tool.parameters);
    expect(normalized[0].function).not.toHaveProperty("strict");
  });

  it.each([
    [
      "nested optional property",
      {
        ...parameters,
        properties: {
          replyText: {
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "string" } },
            required: [],
          },
        },
      },
    ],
    ["open object", { ...parameters, additionalProperties: true }],
    ["missing additionalProperties", { type: "object", properties: {}, required: [] }],
  ])("omits strict true for a %s schema but keeps strict false", (_label, schema) => {
    const normalized = normalizeNativeTools([
      { name: "STRICT_TOOL", parameters: schema, strict: true },
      { name: "LOOSE_TOOL", parameters: schema, strict: false },
    ]) as Array<{ function: { strict?: boolean } }>;
    expect(normalized[0].function).not.toHaveProperty("strict");
    expect(normalized[1].function.strict).toBe(false);
  });

  it("preserves nested schema and strictness in a named tool set", () => {
    const normalized = normalizeNativeTools({
      HANDLE_RESPONSE: { function: { strict: false, parameters } },
    });
    expect(normalized).toEqual([
      {
        type: "function",
        function: { name: "HANDLE_RESPONSE", parameters, strict: false },
      },
    ]);
  });
});

describe("Cloud native tool strictness on the SDK request", () => {
  const parameters = {
    type: "object",
    additionalProperties: false,
    properties: {
      replyText: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["text", "source"] },
            value: { type: "string" },
          },
          required: ["kind", "value"],
        },
      },
    },
    required: ["replyText"],
  };

  it.each([
    ["flat true", { name: "HANDLE_RESPONSE", parameters, strict: true }, true],
    [
      "nested false",
      {
        strict: true,
        function: { name: "HANDLE_RESPONSE", parameters, strict: false },
      },
      false,
    ],
    ["absent", { name: "HANDLE_RESPONSE", parameters }, undefined],
  ] as const)("%s survives the handler and SDK serialization", async (_label, tool, strict) => {
    const settings: Record<string, string> = {
      ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
      ELIZAOS_CLOUD_BASE_URL: "https://cloud-sdk-test.invalid/api/v1",
      ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "qwen-3.8-27b",
    };
    const runtime = {
      character: { name: "Strict wire test", bio: [] },
      getSetting: (key: string) => settings[key],
      emitEvent: vi.fn(),
    } as unknown as IAgentRuntime;
    const before = structuredClone(tool);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({
        id: "synthetic-strict-response",
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "synthetic-call",
                  type: "function",
                  function: {
                    name: "HANDLE_RESPONSE",
                    arguments: JSON.stringify({
                      replyText: [{ kind: "text", value: "Hello." }],
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      });
    });

    await handleResponseHandler(runtime, {
      messages: [{ role: "user", content: "Hello." }],
      tools: [tool],
      toolChoice: "required",
      stream: false,
    } as never);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://cloud-sdk-test.invalid/api/v1/chat/completions");
    expect(requests[0].body.model).toBe("qwen-3.8-27b");
    expect(requests[0].body.tool_choice).toBe("required");
    const tools = requests[0].body.tools as Array<{
      type: string;
      function: { name: string; parameters: unknown; strict?: boolean };
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("HANDLE_RESPONSE");
    expect(tools[0].function.parameters).toEqual(parameters);
    if (strict === undefined) {
      expect(tools[0].function).not.toHaveProperty("strict");
    } else {
      expect(tools[0].function.strict).toBe(strict);
    }
    expect(tool).toEqual(before);
  });
});
