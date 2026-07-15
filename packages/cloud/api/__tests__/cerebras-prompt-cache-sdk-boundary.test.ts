/**
 * Verifies the AI SDK's OpenAI-compatible transport emits Cerebras prompt-cache
 * keys on the provider wire for both complete and streamed generations.
 */

import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";

const PROMPT_CACHE_KEY = "v5:stable-prefix";

function createCapturingProvider(response: Response, bodies: unknown[]) {
  const provider = createOpenAI({
    apiKey: "test-cerebras-key",
    baseURL: "https://api.cerebras.ai/v1",
    fetch: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response;
    }) as typeof fetch,
  });
  return provider.chat("gpt-oss-120b");
}

const providerOptions = {
  openai: { promptCacheKey: PROMPT_CACHE_KEY },
};

describe("Cerebras prompt cache key AI SDK boundary", () => {
  test("generateText serializes prompt_cache_key", async () => {
    const bodies: unknown[] = [];
    const model = createCapturingProvider(
      Response.json({
        id: "chatcmpl-cache-key",
        object: "chat.completion",
        created: 1,
        model: "gpt-oss-120b",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      bodies,
    );

    await generateText({ model, prompt: "hello", providerOptions });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ prompt_cache_key: PROMPT_CACHE_KEY });
    expect(bodies[0]).not.toHaveProperty("promptCacheKey");
  });

  test("streamText serializes prompt_cache_key", async () => {
    const bodies: unknown[] = [];
    const model = createCapturingProvider(
      new Response(
        `data: {"id":"chatcmpl-cache-key","object":"chat.completion.chunk","created":1,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
      bodies,
    );

    const result = streamText({ model, prompt: "hello", providerOptions });
    await result.text;

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ prompt_cache_key: PROMPT_CACHE_KEY });
    expect(bodies[0]).not.toHaveProperty("promptCacheKey");
  });
});
