/**
 * Exercises the real text handler and AI SDK against a local HTTP provider.
 * Permanent quota errors must reach the caller without redundant requests;
 * transient rate limits must still recover on the next provider attempt.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleResponseHandler, handleTextSmall } from "../models/text";

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
});

async function fixture(
  code: string,
  recover: boolean,
  retryAfter?: string | Record<string, string>,
  streamRecovery = false,
  structured = false,
  status = 429,
  failAfterOutput = false
) {
  let requests = 0;
  const requestTimes: number[] = [];
  server = createServer((request, response) => {
    request.resume();
    requests++;
    requestTimes.push(performance.now());
    response.setHeader("Content-Type", "application/json");
    if (!failAfterOutput && (!recover || requests === 1)) {
      if (typeof retryAfter === "string") response.setHeader("Retry-After", retryAfter);
      else if (retryAfter) {
        for (const [name, value] of Object.entries(retryAfter)) response.setHeader(name, value);
      }
      response.writeHead(status);
      response.end(
        JSON.stringify({ error: { message: "Provider rejected request", type: code, code } })
      );
      return;
    }
    if (streamRecovery) {
      response.setHeader("Content-Type", "text/event-stream");
      const chunk = {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "latency-test",
      };
      response.end(
        [
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: structured ? { role: "assistant", tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "reply", arguments: '{"text":"Recovered"}' } }] } : { role: "assistant", content: "Recovered" }, finish_reason: null }] })}\n\n`,
          failAfterOutput
            ? `data: ${JSON.stringify({ error: { message: "Stream failed after output", type: "server_error", code: "server_error" } })}\n\n`
            : `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: structured ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join("")
      );
      return;
    }
    response.end(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "latency-test",
        choices: [
          { index: 0, message: { role: "assistant", content: "Recovered" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  vi.stubEnv("OPENAI_API_KEY", "local-test-key");
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  vi.stubEnv("CEREBRAS_API_KEY", "");
  vi.stubEnv("ELIZA_PROVIDER", "openai");
  const runtime = new AgentRuntime({
    character: {
      name: "QuotaRetryTest",
      settings: {
        OPENAI_API_KEY: "local-test-key",
        OPENAI_BASE_URL: baseURL,
        OPENAI_SMALL_MODEL: "latency-test",
      },
    },
  });
  return { runtime, requests: () => requests, requestTimes };
}

describe("provider quota retry HTTP boundary", () => {
  it.each([
    ["insufficient_quota", "generate"],
    ["credit_balance_exhausted", "generate"],
    ["insufficient_quota", "live"],
    ["credit_balance_exhausted", "live"],
    ["insufficient_quota", "buffered"],
    ["credit_balance_exhausted", "buffered"],
    ["insufficient_quota", "structured"],
    ["credit_balance_exhausted", "structured"],
  ])(
    "does not retry %s in %s mode",
    async (code, mode) => {
      const test = await fixture(code, false);
      vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", mode === "buffered" ? "1" : "0");
      const call = async () => {
        const result = await handleTextSmall(test.runtime, {
          prompt: "Reply briefly.",
          signal: AbortSignal.timeout(5000),
          stream: mode !== "generate",
          streamStructured: mode === "structured",
        });
        if (typeof result !== "string") {
          for await (const chunk of result.textStream) {
            throw new Error(`Unexpected output before quota rejection: ${chunk}`);
          }
        }
      };
      await expect(call()).rejects.toMatchObject({ statusCode: 429 });
      expect(test.requests()).toBe(1);
    },
    10000
  );

  it("retries a temporary rate limit and delivers the recovered response", async () => {
    const test = await fixture("rate_limit_exceeded", true);
    await expect(handleTextSmall(test.runtime, { prompt: "Reply briefly." })).resolves.toBe(
      "Recovered"
    );
    expect(test.requests()).toBe(2);
  }, 10000);

  it("honors the provider retry delay before recovering", async () => {
    const test = await fixture("rate_limit_exceeded", true, "0.8");
    await expect(handleTextSmall(test.runtime, { prompt: "Reply briefly." })).resolves.toBe(
      "Recovered"
    );
    expect(test.requests()).toBe(2);
    expect(test.requestTimes[1] - test.requestTimes[0]).toBeGreaterThanOrEqual(790);
  }, 10000);

  const shortDelayCases: Array<{
    header: string;
    headers: Record<string, string>;
    delayMs: number;
  }> = [
    { header: "milliseconds", headers: { "retry-after-ms": "800" }, delayMs: 800 },
    {
      header: "fractional milliseconds",
      headers: { "retry-after-ms": "800.5" },
      delayMs: 800.5,
    },
    {
      header: "HTTP date",
      headers: { "Retry-After": new Date(Date.UTC(2026, 8, 6, 12, 0, 1)).toUTCString() },
      delayMs: 900,
    },
    {
      header: "millisecond precedence",
      headers: { "retry-after-ms": "800", "Retry-After": "30" },
      delayMs: 800,
    },
    {
      header: "invalid milliseconds with valid seconds",
      headers: { "retry-after-ms": "invalid", "Retry-After": "0.8" },
      delayMs: 800,
    },
  ];

  it.each(shortDelayCases)(
    "does not retry before a short $header hint",
    async ({ headers, delayMs }) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 6, 12, 0, 0, 100));
      const timer = vi.spyOn(globalThis, "setTimeout");
      const test = await fixture("rate_limit_exceeded", true, headers);
      await expect(handleTextSmall(test.runtime, { prompt: "Reply briefly." })).resolves.toBe(
        "Recovered"
      );
      expect(test.requests()).toBe(2);
      expect(timer).toHaveBeenCalledWith(expect.any(Function), Math.ceil(delayMs));
      expect(test.requestTimes[1] - test.requestTimes[0]).toBeGreaterThanOrEqual(delayMs);
    },
    10000
  );

  const longDelayHeaders: Array<{ header: string; headers: Record<string, string> }> = [
    { header: "seconds", headers: { "Retry-After": "30" } },
    { header: "milliseconds", headers: { "Retry-After-Ms": "30000" } },
    {
      header: "HTTP date",
      headers: { "Retry-After": new Date(Date.UTC(2026, 8, 6, 12, 0, 30)).toUTCString() },
    },
  ];
  const longDelayCases = longDelayHeaders.flatMap((hint) =>
    [429, 503].flatMap((status) =>
      ["generate", "live", "buffered", "structured"].map((mode) => ({ ...hint, status, mode }))
    )
  );

  it.each(longDelayCases)(
    "fails over without waiting or resending HTTP $status with long $header in $mode mode",
    async ({ headers, status, mode }) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 6, 12));
      const test = await fixture("rate_limit_exceeded", true, headers, false, false, status);
      vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", mode === "buffered" ? "1" : "0");
      const signal = AbortSignal.timeout(1000);
      const call = async () => {
        const result = await handleTextSmall(test.runtime, {
          prompt: "Reply briefly.",
          signal,
          stream: mode !== "generate",
          streamStructured: mode === "structured",
        });
        if (typeof result !== "string") {
          for await (const chunk of result.textStream) {
            throw new Error(`Unexpected output before provider rejection: ${chunk}`);
          }
        }
      };
      await expect(call()).rejects.toMatchObject({ statusCode: status });
      expect(signal.aborted).toBe(false);
      expect(test.requests()).toBe(1);
    },
    10000
  );

  it("keeps a long millisecond cooldown through aliases until the complete provider delay expires", async () => {
    const now = Date.UTC(2026, 8, 6, 12);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const test = await fixture("rate_limit_exceeded", true, { "retry-after-ms": "180000" });
    await expect(handleTextSmall(test.runtime, { prompt: "First attempt." })).rejects.toMatchObject(
      {
        statusCode: 429,
      }
    );
    clock.mockReturnValue(now + 120_001);
    await expect(
      handleResponseHandler(test.runtime, {
        prompt: "Same model through streaming.",
        model: "latency-test",
        stream: true,
      })
    ).rejects.toMatchObject({ name: "ProviderRateLimitCooldownError", statusCode: 429 });
    expect(test.requests()).toBe(1);
    clock.mockReturnValue(now + 180_000);
    await expect(handleTextSmall(test.runtime, { prompt: "After reset." })).resolves.toBe(
      "Recovered"
    );
    expect(test.requests()).toBe(2);
  });

  it("recovers a buffered stream using the original rate-limit error", async () => {
    const test = await fixture("rate_limit_exceeded", true, undefined, true);
    vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "1");
    const result = await handleTextSmall(test.runtime, { prompt: "Reply briefly.", stream: true });
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error("Expected streamed result");
    let text = "";
    for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe("Recovered");
    expect(test.requests()).toBe(2);
  }, 10000);

  it.each([429, 500])(
    "recovers structured live output after HTTP %s",
    async (status) => {
      const test = await fixture("rate_limit_exceeded", true, "0.01", true, true, status);
      vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "0");
      const result = await handleTextSmall(test.runtime, {
        prompt: "Reply briefly.",
        stream: true,
        streamStructured: true,
        tools: [
          {
            name: "reply",
            description: "Return reply",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
      if (typeof result === "string") throw new Error("Expected streamed result");
      let text = "";
      for await (const chunk of result.textStream) text += chunk;
      expect(text).toBe('{"text":"Recovered"}');
      expect(test.requests()).toBe(2);
    },
    10000
  );

  it("never retries structured output after an argument delta reached the caller", async () => {
    const test = await fixture("server_error", false, undefined, true, true, 500, true);
    vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", "0");
    const result = await handleTextSmall(test.runtime, {
      prompt: "Reply briefly.",
      stream: true,
      streamStructured: true,
    });
    if (typeof result === "string") throw new Error("Expected streamed result");
    let text = "";
    await expect(
      (async () => {
        for await (const chunk of result.textStream) text += chunk;
      })()
    ).rejects.toThrow();
    expect(text).toBe('{"text":"Recovered"}');
    expect(test.requests()).toBe(1);
  }, 10000);

  it.each([false, true])(
    "cancels provider-directed retry wait (structured=%s)",
    async (structured) => {
      const test = await fixture("rate_limit_exceeded", true, "2");
      await expect(
        handleTextSmall(test.runtime, {
          prompt: "Reply briefly.",
          signal: AbortSignal.timeout(1000),
          stream: structured,
          streamStructured: structured,
        })
      ).rejects.toThrow();
      expect(test.requests()).toBe(1);
    },
    10000
  );
});
