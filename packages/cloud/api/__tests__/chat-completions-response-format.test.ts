/** Exercises gateway response-format translation through the real OpenAI SDK serializer and response parser, with deterministic provider HTTP responses. */

import { expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { __nativeToolingTestHooks } from "../v1/chat/completions/route";

test("JSON object mode reaches the provider without an invented strict schema", async () => {
  const requests: Array<{ response_format: unknown }> = [];
  const provider = createOpenAI({
    apiKey: "fixture-provider-key",
    fetch: Object.assign(
      async (...[, init]: Parameters<typeof fetch>) => {
        requests.push(
          JSON.parse(String(init?.body)) as { response_format: unknown },
        );
        return Response.json({
          id: "format-contract",
          object: "chat.completion",
          created: 0,
          model: "qwen-3.8-27b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"greeting":"hello"}' },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const result = await generateText({
    model: provider.chat("qwen-3.8-27b"),
    prompt: "Return a JSON object with a greeting.",
    output: __nativeToolingTestHooks.mapResponseFormat({ type: "json_object" }),
    maxRetries: 0,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.response_format).toEqual({ type: "json_object" });
  expect(result.output).toEqual({ greeting: "hello" });
  expect(result.usage.inputTokens).toBe(12);
});
