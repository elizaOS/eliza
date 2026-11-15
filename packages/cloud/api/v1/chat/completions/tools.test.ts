import { describe, expect, spyOn, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import { type ChatCompletionTool, convertTools } from "./tools";

const schema = {
  type: "object",
  properties: {
    nested: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    items: {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  },
  required: ["nested", "items"],
  additionalProperties: false,
};
function tools(flags: Array<boolean | undefined>): ChatCompletionTool[] {
  return flags.map((strict, i) => ({
    type: "function",
    function: {
      name: `tool_${i}`,
      description: `Tool ${i}`,
      parameters: schema,
      ...(strict === undefined ? {} : { strict }),
    },
  }));
}
async function wire(
  input: ChatCompletionTool[] | undefined,
  streaming: boolean,
) {
  const response = streaming
    ? new Response(
        'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
          'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      )
    : Response.json({
        id: "test",
        object: "chat.completion",
        created: 0,
        model: "test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);
  try {
    const provider = createOpenAI({
      apiKey: "test-not-a-real-key",
      baseURL: "https://provider.invalid/v1",
      fetch: globalThis.fetch,
    });
    const options = {
      model: provider.chat("qwen-3.8-27b"),
      prompt: "test",
      tools: convertTools(input),
      maxRetries: 0,
    };
    if (streaming) await streamText(options).text;
    else await generateText(options);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
  } finally {
    fetchSpy.mockRestore();
  }
}
describe("tool strictness through the actual OpenAI chat adapter fetch body", () => {
  for (const streaming of [false, true]) {
    for (const flags of [
      [true],
      [false],
      [undefined],
      [true, true],
      [true, false, undefined],
      [false, false, false],
    ] as Array<Array<boolean | undefined>>) {
      test(`${streaming ? "stream" : "generate"}: ${JSON.stringify(flags)}`, async () => {
        const body = await wire(tools(flags), streaming);
        expect(body.tools).toHaveLength(flags.length);
        for (const [i, strict] of flags.entries()) {
          expect(body.tools[i].function.name).toBe(`tool_${i}`);
          expect(body.tools[i].function.description).toBe(`Tool ${i}`);
          expect(body.tools[i].function.parameters).toEqual(schema);
          if (strict === undefined)
            expect(Object.hasOwn(body.tools[i].function, "strict")).toBe(false);
          else expect(body.tools[i].function.strict).toBe(strict);
        }
      });
    }
    test(`${streaming ? "stream" : "generate"}: absent and empty tools stay absent`, async () => {
      for (const input of [undefined, []]) {
        const body = await wire(input, streaming);
        expect(Object.hasOwn(body, "tools")).toBe(false);
      }
    });
  }
  test("runtime non-boolean strict values are not coerced or emitted", () => {
    for (const strict of [null, "true", 1]) {
      const input = [
        { type: "function", function: { name: "test", strict } },
      ] as unknown as ChatCompletionTool[];
      expect(Object.hasOwn(convertTools(input)!.test, "strict")).toBe(false);
    }
  });
  test("missing schema preserves the existing object default", async () => {
    const body = await wire(
      [{ type: "function", function: { name: "test", strict: false } }],
      false,
    );
    expect(body.tools[0].function.parameters).toEqual({ type: "object" });
    expect(body.tools[0].function.strict).toBe(false);
  });
});
