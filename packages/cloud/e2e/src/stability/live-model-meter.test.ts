/**
 * Exercises real-provider token metering and proxy policy with keyless response fixtures.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  LiveModelUsageMeter,
  type StabilityModelFailureCode,
  type StabilityModelProxy,
  startLiveModelEgressProxy,
} from "./live-model-meter.ts";

const proxies: StabilityModelProxy[] = [];

function reserve(meter: LiveModelUsageMeter) {
  const admission = meter.reserveRequest();
  if (!admission.allowed) throw new Error(admission.failure.message);
  return admission.reservation;
}

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
});

describe("live model usage meter", () => {
  test("parses and cumulatively aggregates OpenAI and Anthropic usage", () => {
    const openai = new LiveModelUsageMeter("openai", {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxRequests: 3,
    });
    openai.recordSuccessfulResponse(
      reserve(openai),
      "application/json",
      Buffer.from(
        JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      ),
    );
    openai.recordSuccessfulResponse(
      reserve(openai),
      "application/json",
      Buffer.from(
        JSON.stringify({ usage: { input_tokens: 5, output_tokens: 2 } }),
      ),
    );
    expect(openai.snapshot()).toMatchObject({
      requestCount: 2,
      inputTokens: 12,
      outputTokens: 5,
      failures: [],
    });

    const anthropic = new LiveModelUsageMeter("anthropic", {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxRequests: 2,
    });
    anthropic.recordSuccessfulResponse(
      reserve(anthropic),
      "application/json",
      Buffer.from(
        JSON.stringify({ usage: { input_tokens: 11, output_tokens: 4 } }),
      ),
    );
    expect(anthropic.snapshot()).toMatchObject({
      inputTokens: 11,
      outputTokens: 4,
    });
  });

  test("accepts the exact boundary and blocks any further provider request", () => {
    const meter = new LiveModelUsageMeter("openai", {
      maxInputTokens: 10,
      maxOutputTokens: 5,
      maxRequests: 2,
    });
    meter.recordSuccessfulResponse(
      reserve(meter),
      "application/json",
      Buffer.from(
        JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      ),
    );
    expect(meter.reserveRequest()).toMatchObject({
      allowed: false,
      failure: { code: "STABILITY_MODEL_TOKEN_BUDGET_EXHAUSTED" },
    });
  });

  test("fails closed on over-budget, missing, malformed, and zero usage", () => {
    const cases: Array<[string, unknown, StabilityModelFailureCode]> = [
      [
        "over",
        { usage: { prompt_tokens: 11, completion_tokens: 1 } },
        "STABILITY_MODEL_TOKEN_BUDGET_EXCEEDED",
      ],
      ["missing", { id: "response" }, "STABILITY_MODEL_USAGE_MISSING"],
      [
        "malformed",
        { usage: { prompt_tokens: "ten", completion_tokens: 1 } },
        "STABILITY_MODEL_USAGE_MALFORMED",
      ],
      [
        "zero",
        { usage: { prompt_tokens: 0, completion_tokens: 0 } },
        "STABILITY_MODEL_USAGE_MALFORMED",
      ],
    ];
    for (const [, payload, code] of cases) {
      const meter = new LiveModelUsageMeter("openai", {
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxRequests: 2,
      });
      expect(() =>
        meter.recordSuccessfulResponse(
          reserve(meter),
          "application/json",
          Buffer.from(JSON.stringify(payload)),
        ),
      ).toThrow(new RegExp(code));
      expect(meter.snapshot().failures.at(-1)?.code).toBe(code);
    }
  });

  test("extracts authoritative usage from OpenAI and Anthropic SSE", () => {
    const openai = new LiveModelUsageMeter("openai", {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxRequests: 1,
    });
    openai.recordSuccessfulResponse(
      reserve(openai),
      "text/event-stream",
      Buffer.from(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":13,"output_tokens":6}}}\n\ndata: [DONE]\n\n',
      ),
    );
    expect(openai.snapshot()).toMatchObject({
      inputTokens: 13,
      outputTokens: 6,
    });

    const anthropic = new LiveModelUsageMeter("anthropic", {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxRequests: 1,
    });
    anthropic.recordSuccessfulResponse(
      reserve(anthropic),
      "text/event-stream",
      Buffer.from(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4,"output_tokens":0}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
      ),
    );
    expect(anthropic.snapshot()).toMatchObject({
      inputTokens: 9,
      outputTokens: 4,
    });
  });

  test("counts Anthropic cache-only input and rejects unsafe aggregate overflow", () => {
    const cacheOnly = new LiveModelUsageMeter("anthropic", {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxRequests: 1,
    });
    cacheOnly.recordSuccessfulResponse(
      reserve(cacheOnly),
      "application/json",
      Buffer.from(
        JSON.stringify({
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 17,
            output_tokens: 2,
          },
        }),
      ),
    );
    expect(cacheOnly.snapshot()).toMatchObject({
      inputTokens: 17,
      outputTokens: 2,
    });

    const overflow = new LiveModelUsageMeter("anthropic", {
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      maxOutputTokens: 100,
      maxRequests: 1,
    });
    expect(() =>
      overflow.recordSuccessfulResponse(
        reserve(overflow),
        "application/json",
        Buffer.from(
          JSON.stringify({
            usage: {
              input_tokens: Number.MAX_SAFE_INTEGER,
              cache_read_input_tokens: 1,
              output_tokens: 1,
            },
          }),
        ),
      ),
    ).toThrow("STABILITY_MODEL_USAGE_MALFORMED");
  });

  test("proxy records provider errors and timeouts without fabricating usage", async () => {
    for (const fixture of [
      {
        response: new Response("provider rejected", { status: 429 }),
        code: "STABILITY_MODEL_PROVIDER_ERROR",
      },
      { response: null, code: "STABILITY_MODEL_PROVIDER_TIMEOUT" },
    ] as const) {
      const proxy = await startLiveModelEgressProxy({
        provider: "openai",
        budgets: { maxInputTokens: 100, maxOutputTokens: 100, maxRequests: 2 },
        upstreamTimeoutMs: 5,
        fetchUpstream: fixture.response
          ? async () => fixture.response
          : async (_url, init) =>
              await new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () =>
                  reject(init.signal?.reason),
                );
              }),
      });
      proxies.push(proxy);
      const response = await fetch(`${proxy.url}/chat/completions`, {
        method: "POST",
        body: "{}",
      });
      expect(response.ok).toBe(false);
      expect(proxy.snapshot().failures.at(-1)?.code).toBe(fixture.code);
      expect(proxy.snapshot()).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
      });
    }
  });

  test("proxy enforces request cap before a further upstream call", async () => {
    let upstreamCalls = 0;
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      budgets: { maxInputTokens: 100, maxOutputTokens: 100, maxRequests: 1 },
      fetchUpstream: async () => {
        upstreamCalls += 1;
        return Response.json({
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      },
    });
    proxies.push(proxy);
    expect(
      (await fetch(`${proxy.url}/responses`, { method: "POST", body: "{}" }))
        .ok,
    ).toBe(true);
    expect(
      (await fetch(`${proxy.url}/responses`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(429);
    expect(upstreamCalls).toBe(1);
    expect(proxy.snapshot().failures.at(-1)?.code).toBe(
      "STABILITY_MODEL_REQUEST_BUDGET_EXCEEDED",
    );
  });

  test("proxy atomically reserves one admission under concurrent request pressure", async () => {
    let upstreamCalls = 0;
    let releaseUpstream: (() => void) | undefined;
    const upstreamBlocked = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      budgets: { maxInputTokens: 100, maxOutputTokens: 100, maxRequests: 1 },
      fetchUpstream: async () => {
        upstreamCalls += 1;
        await upstreamBlocked;
        return Response.json({
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      },
    });
    proxies.push(proxy);

    const requests = Array.from({ length: 8 }, () =>
      fetch(`${proxy.url}/responses`, { method: "POST", body: "{}" }),
    );
    await Bun.sleep(10);
    expect(upstreamCalls).toBe(1);
    releaseUpstream?.();
    const responses = await Promise.all(requests);

    expect(responses.filter((response) => response.ok)).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 429),
    ).toHaveLength(7);
    expect(upstreamCalls).toBe(1);
    expect(proxy.snapshot()).toMatchObject({
      requestCount: 1,
      inputTokens: 2,
      outputTokens: 1,
    });
    expect(
      proxy
        .snapshot()
        .failures.filter(
          (failure) =>
            failure.code === "STABILITY_MODEL_REQUEST_BUDGET_EXCEEDED",
        ),
    ).toHaveLength(1);
  });

  test("proxy serializes exchanges so concurrent calls cannot admit against stale token totals", async () => {
    let upstreamCalls = 0;
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      budgets: { maxInputTokens: 2, maxOutputTokens: 1, maxRequests: 8 },
      fetchUpstream: async () => {
        upstreamCalls += 1;
        await Bun.sleep(5);
        return Response.json({
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      },
    });
    proxies.push(proxy);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${proxy.url}/responses`, { method: "POST", body: "{}" }),
      ),
    );

    expect(responses.filter((response) => response.ok)).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 429),
    ).toHaveLength(7);
    expect(upstreamCalls).toBe(1);
    expect(proxy.snapshot()).toMatchObject({
      requestCount: 1,
      inputTokens: 2,
      outputTokens: 1,
    });
    expect(proxy.snapshot().failures).toEqual([
      expect.objectContaining({
        code: "STABILITY_MODEL_TOKEN_BUDGET_EXHAUSTED",
        requestNumber: 2,
      }),
    ]);
  });

  test("proxy counts and retains an oversized upstream response", async () => {
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      budgets: { maxInputTokens: 100, maxOutputTokens: 100, maxRequests: 2 },
      fetchUpstream: async () =>
        new Response(new Uint8Array(16 * 1024 * 1024 + 1), { status: 200 }),
    });
    proxies.push(proxy);
    expect(
      (await fetch(`${proxy.url}/responses`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(502);
    expect(proxy.snapshot()).toMatchObject({
      requestCount: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(proxy.snapshot().failures.at(-1)?.code).toBe(
      "STABILITY_MODEL_PROXY_ERROR",
    );
  });

  test("proxy retains an observer failure before provider dispatch", async () => {
    let upstreamCalls = 0;
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      budgets: { maxInputTokens: 100, maxOutputTokens: 100, maxRequests: 2 },
      fetchUpstream: async () => {
        upstreamCalls += 1;
        return Response.json({
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      },
      onUpstreamRequest: () => {
        throw new Error("injected ledger boundary failure");
      },
    });
    proxies.push(proxy);
    expect(
      (await fetch(`${proxy.url}/responses`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(502);
    expect(upstreamCalls).toBe(0);
    expect(proxy.snapshot().requestCount).toBe(1);
    expect(proxy.snapshot().failures.at(-1)?.code).toBe(
      "STABILITY_MODEL_PROXY_ERROR",
    );
  });

  test("proxy retains a response-boundary failure after successful metering", async () => {
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      budgets: { maxInputTokens: 100, maxOutputTokens: 100, maxRequests: 2 },
      fetchUpstream: async () =>
        ({
          ok: true,
          status: 200,
          headers: {
            get: () => "application/json",
            [Symbol.iterator](): IterableIterator<[string, string]> {
              throw new Error("injected response header boundary failure");
            },
          },
          arrayBuffer: async () =>
            new TextEncoder().encode(
              JSON.stringify({
                usage: { prompt_tokens: 2, completion_tokens: 1 },
              }),
            ).buffer,
        }) as unknown as Response,
    });
    proxies.push(proxy);

    expect(
      (await fetch(`${proxy.url}/responses`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(502);
    expect(proxy.snapshot()).toMatchObject({
      requestCount: 1,
      inputTokens: 2,
      outputTokens: 1,
    });
    expect(proxy.snapshot().failures).toEqual([
      expect.objectContaining({
        code: "STABILITY_MODEL_PROXY_ERROR",
        requestNumber: 1,
        message: "injected response header boundary failure",
      }),
    ]);
  });
});
