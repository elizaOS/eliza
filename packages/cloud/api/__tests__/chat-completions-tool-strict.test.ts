/** The chat route forwards each tool's `strict` flag to the OpenAI-compatible provider request. */
import { expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const PARAMETERS = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
  additionalProperties: false,
};

test("tool strict flags reach the outbound provider body unchanged", async () => {
  const { __nativeToolingTestHooks } = await import(
    "../v1/chat/completions/route"
  );
  const bodies: Array<{
    tools: Array<{ function: { name: string; strict?: boolean } }>;
  }> = [];
  const provider = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://provider.test/v1",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "qwen-3.8-27b",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });

  await generateText({
    model: provider.chat("qwen-3.8-27b"),
    prompt: "hello",
    tools: __nativeToolingTestHooks.convertTools([
      {
        type: "function",
        function: { name: "STRICT", parameters: PARAMETERS, strict: true },
      },
      {
        type: "function",
        function: { name: "LOOSE", parameters: PARAMETERS, strict: false },
      },
      { type: "function", function: { name: "UNSET", parameters: PARAMETERS } },
    ]),
  });

  const byName = Object.fromEntries(
    bodies[0].tools.map((tool) => [tool.function.name, tool.function]),
  );
  expect(byName.STRICT.strict).toBe(true);
  expect(byName.LOOSE.strict).toBe(false);
  expect(byName.UNSET).not.toHaveProperty("strict");
});
