/**
 * Exercises real-provider token metering and proxy policy with keyless response fixtures.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  LiveModelUsageMeter,
  liveModelScenarioChildEnvironment,
  type StabilityModelFailureCode,
  type StabilityModelProxy,
  startLiveModelEgressProxy,
} from "./live-model-meter.ts";

const proxies: StabilityModelProxy[] = [];
const EXPECTED_MODEL = "test-model";
const OPENAI_RESPONSES_BODY = JSON.stringify({
  model: EXPECTED_MODEL,
  input: "test",
  max_output_tokens: 1,
});
const OPENAI_CHAT_BODY = JSON.stringify({
  model: EXPECTED_MODEL,
  messages: [{ role: "user", content: "test" }],
  max_completion_tokens: 1,
});
const ANTHROPIC_BODY = JSON.stringify({
  model: EXPECTED_MODEL,
  messages: [{ role: "user", content: "test" }],
  max_tokens: 1,
});

function providerBody(provider: "openai" | "anthropic"): string {
  return provider === "openai" ? OPENAI_RESPONSES_BODY : ANTHROPIC_BODY;
}

function reserve(meter: LiveModelUsageMeter) {
  const admission = meter.reserveRequest();
  if (!admission.allowed) throw new Error(admission.failure.message);
  return admission.reservation;
}

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
});

describe("live model usage meter", () => {
  test.each(["openai", "anthropic"] as const)(
    "scenario child receives only a dummy %s credential",
    (provider) => {
      const environment = liveModelScenarioChildEnvironment(
        provider,
        "http://127.0.0.1:43123/v1",
        {
          OPENAI_API_KEY: "real-openai-secret",
          ANTHROPIC_API_KEY: "real-anthropic-secret",
          ELIZA_STABILITY_METER_ATTESTATION_KEY: "parent-attestation-secret",
          RETAINED_VALUE: "retained",
        },
      );
      expect(JSON.stringify(environment)).not.toContain("real-");
      expect(environment.ELIZA_STABILITY_METER_ATTESTATION_KEY).toBeUndefined();
      expect(environment.RETAINED_VALUE).toBe("retained");
      if (provider === "openai") {
        expect(environment.OPENAI_API_KEY).toContain("placeholder");
        expect(environment.OPENAI_BASE_URL).toBe("http://127.0.0.1:43123/v1");
        expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
      } else {
        expect(environment.ANTHROPIC_API_KEY).toContain("placeholder");
        expect(environment.ANTHROPIC_BASE_URL).toBe(
          "http://127.0.0.1:43123/v1",
        );
        expect(environment.OPENAI_API_KEY).toBeUndefined();
      }
    },
  );

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

    const mixed = new LiveModelUsageMeter("anthropic", {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxRequests: 1,
    });
    mixed.recordSuccessfulResponse(
      reserve(mixed),
      "application/json",
      Buffer.from(
        JSON.stringify({
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 7,
            output_tokens: 2,
          },
        }),
      ),
    );
    expect(mixed.snapshot()).toMatchObject({
      inputTokens: 15,
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

  test("accepts cache-only Anthropic input in SSE", () => {
    const meter = new LiveModelUsageMeter("anthropic", {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxRequests: 1,
    });
    meter.recordSuccessfulResponse(
      reserve(meter),
      "text/event-stream",
      Buffer.from(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"cache_read_input_tokens":19,"output_tokens":0}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
      ),
    );
    expect(meter.snapshot()).toMatchObject({
      inputTokens: 19,
      outputTokens: 3,
    });
  });

  test("fails closed when individually safe responses overflow cumulative accounting", () => {
    const meter = new LiveModelUsageMeter("openai", {
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      maxOutputTokens: Number.MAX_SAFE_INTEGER,
      maxRequests: 2,
    });
    meter.recordSuccessfulResponse(
      reserve(meter),
      "application/json",
      Buffer.from(
        JSON.stringify({
          usage: {
            prompt_tokens: Number.MAX_SAFE_INTEGER - 1,
            completion_tokens: 1,
          },
        }),
      ),
    );
    expect(() =>
      meter.recordSuccessfulResponse(
        reserve(meter),
        "application/json",
        Buffer.from(
          JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 1 } }),
        ),
      ),
    ).toThrow("STABILITY_MODEL_USAGE_MALFORMED");
    expect(meter.snapshot()).toMatchObject({
      requestCount: 2,
      inputTokens: Number.MAX_SAFE_INTEGER - 1,
      outputTokens: 1,
      failures: [
        expect.objectContaining({
          code: "STABILITY_MODEL_USAGE_MALFORMED",
          requestNumber: 2,
        }),
      ],
    });
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
        expectedModel: EXPECTED_MODEL,
        budgets: {
          maxInputTokens: 10_000,
          maxOutputTokens: 100,
          maxRequests: 2,
        },
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
        body: OPENAI_CHAT_BODY,
      });
      expect(response.ok).toBe(false);
      expect(proxy.snapshot().failures.at(-1)?.code).toBe(fixture.code);
      expect(proxy.snapshot()).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
      });
    }
  });

  test.each([
    {
      payload: { id: "missing-usage" },
      code: "STABILITY_MODEL_USAGE_MISSING",
    },
    {
      payload: { usage: { prompt_tokens: "bad", completion_tokens: 1 } },
      code: "STABILITY_MODEL_USAGE_MALFORMED",
    },
    {
      payload: { usage: { prompt_tokens: 10_001, completion_tokens: 1 } },
      code: "STABILITY_MODEL_TOKEN_BUDGET_EXCEEDED",
    },
  ] as const)(
    "proxy retains $code from a successful provider response",
    async ({ payload, code }) => {
      const proxy = await startLiveModelEgressProxy({
        provider: "openai",
        expectedModel: EXPECTED_MODEL,
        budgets: {
          maxInputTokens: 10_000,
          maxOutputTokens: 100,
          maxRequests: 1,
        },
        fetchUpstream: async () => Response.json(payload),
      });
      proxies.push(proxy);

      expect(
        (
          await fetch(`${proxy.url}/responses`, {
            method: "POST",
            body: OPENAI_RESPONSES_BODY,
          })
        ).status,
      ).toBe(502);
      expect(proxy.snapshot().failures.at(-1)?.code).toBe(code);
    },
  );

  test("native upstream receives provider host/auth without child auth or proxy headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        capturedHeaders = Object.fromEntries(request.headers);
        return Response.json({
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      },
    });
    try {
      const proxy = await startLiveModelEgressProxy({
        provider: "openai",
        expectedModel: EXPECTED_MODEL,
        budgets: {
          maxInputTokens: 10_000,
          maxOutputTokens: 100,
          maxRequests: 1,
        },
        upstreamCredential: "real-model-secret",
        upstreamOrigin: `http://127.0.0.1:${upstream.port}`,
        fetchUpstream: (url, init) => fetch(url, init),
      });
      proxies.push(proxy);

      expect(
        (
          await fetch(`${proxy.url}/responses`, {
            method: "POST",
            headers: {
              authorization: "Bearer child-placeholder",
              "x-api-key": "child-placeholder",
              "proxy-authorization": "Bearer child-placeholder",
              "proxy-connection": "child-hop-value",
              host: "child-loopback.invalid",
            },
            body: OPENAI_RESPONSES_BODY,
          })
        ).ok,
      ).toBe(true);
      expect(capturedHeaders.host).toBe(`127.0.0.1:${upstream.port}`);
      expect(capturedHeaders.authorization).toBe("Bearer real-model-secret");
      expect(JSON.stringify(capturedHeaders)).not.toContain("child-");
      for (const absent of [
        "x-api-key",
        "api-key",
        "proxy-authorization",
        "proxy-connection",
      ]) {
        expect(capturedHeaders[absent]).toBeUndefined();
      }
    } finally {
      upstream.stop(true);
    }
  });

  test.each([
    {
      provider: "openai" as const,
      expectedHeader: "authorization",
      expectedValue: "Bearer real-model-secret",
    },
    {
      provider: "anthropic" as const,
      expectedHeader: "x-api-key",
      expectedValue: "real-model-secret",
    },
  ])(
    "proxy replaces child authentication with the parent-held $provider credential",
    async ({ provider, expectedHeader, expectedValue }) => {
      let capturedHeaders: Record<string, string> = {};
      const proxy = await startLiveModelEgressProxy({
        provider,
        expectedModel: EXPECTED_MODEL,
        budgets: {
          maxInputTokens: 10_000,
          maxOutputTokens: 100,
          maxRequests: 1,
        },
        upstreamCredential: "real-model-secret",
        fetchUpstream: async (_url, init) => {
          capturedHeaders = Object.fromEntries(new Headers(init.headers));
          return Response.json({
            usage:
              provider === "openai"
                ? { prompt_tokens: 2, completion_tokens: 1 }
                : { input_tokens: 2, output_tokens: 1 },
          });
        },
      });
      proxies.push(proxy);

      expect(
        (
          await fetch(
            `${proxy.url}/${provider === "anthropic" ? "messages" : "responses"}`,
            {
              method: "POST",
              headers: {
                authorization: "Bearer child-dummy-secret",
                "x-api-key": "child-dummy-secret",
                "api-key": "child-dummy-secret",
                "proxy-authorization": "Bearer child-dummy-secret",
                "proxy-connection": "keep-alive",
                connection: "keep-alive",
                host: "child-loopback.invalid",
                "anthropic-version": "2023-06-01",
              },
              body: providerBody(provider),
            },
          )
        ).ok,
      ).toBe(true);
      expect(capturedHeaders[expectedHeader]).toBe(expectedValue);
      expect(JSON.stringify(capturedHeaders)).not.toContain(
        "child-dummy-secret",
      );
      expect(
        capturedHeaders[
          expectedHeader === "authorization" ? "x-api-key" : "authorization"
        ],
      ).toBeUndefined();
      for (const stripped of [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "proxy-authorization",
        "proxy-connection",
        "api-key",
      ]) {
        expect(capturedHeaders[stripped]).toBeUndefined();
      }
      expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
    },
  );

  test.each([
    { method: "GET", path: "/responses" },
    { method: "POST", path: "/models" },
    { method: "POST", path: "/responses?redirect=https://example.com" },
  ])(
    "proxy rejects non-model route $method $path",
    async ({ method, path }) => {
      let upstreamCalls = 0;
      const proxy = await startLiveModelEgressProxy({
        provider: "openai",
        expectedModel: EXPECTED_MODEL,
        budgets: {
          maxInputTokens: 10_000,
          maxOutputTokens: 100,
          maxRequests: 2,
        },
        upstreamCredential: "real-model-secret",
        fetchUpstream: async () => {
          upstreamCalls += 1;
          return Response.json({
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          });
        },
      });
      proxies.push(proxy);

      expect(
        (
          await fetch(`${proxy.url}${path}`, {
            method,
            body: method === "POST" ? OPENAI_RESPONSES_BODY : undefined,
          })
        ).status,
      ).toBe(404);
      expect(upstreamCalls).toBe(0);
      expect(proxy.snapshot()).toMatchObject({
        requestCount: 0,
        failures: [
          expect.objectContaining({ code: "STABILITY_MODEL_PROXY_ERROR" }),
        ],
      });
    },
  );

  test("proxy enforces request cap before a further upstream call", async () => {
    let upstreamCalls = 0;
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      expectedModel: EXPECTED_MODEL,
      budgets: { maxInputTokens: 10_000, maxOutputTokens: 100, maxRequests: 1 },
      fetchUpstream: async () => {
        upstreamCalls += 1;
        return Response.json({
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      },
    });
    proxies.push(proxy);
    expect(
      (
        await fetch(`${proxy.url}/responses`, {
          method: "POST",
          body: OPENAI_RESPONSES_BODY,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await fetch(`${proxy.url}/responses`, {
          method: "POST",
          body: OPENAI_RESPONSES_BODY,
        })
      ).status,
    ).toBe(429);
    expect(upstreamCalls).toBe(1);
    expect(proxy.snapshot().failures.at(-1)?.code).toBe(
      "STABILITY_MODEL_REQUEST_BUDGET_EXCEEDED",
    );
    expect(proxy.snapshot().requestEnvelopes.at(-1)).toMatchObject({
      accepted: false,
      forwardedBodyBytes: null,
      forwardedBodySha256: null,
    });
  });

  test("proxy atomically reserves one admission under concurrent request pressure", async () => {
    let upstreamCalls = 0;
    let releaseUpstream: (() => void) | undefined;
    const upstreamBlocked = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      expectedModel: EXPECTED_MODEL,
      budgets: { maxInputTokens: 10_000, maxOutputTokens: 100, maxRequests: 1 },
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
      fetch(`${proxy.url}/responses`, {
        method: "POST",
        body: OPENAI_RESPONSES_BODY,
      }),
    );
    for (let attempt = 0; attempt < 200 && upstreamCalls === 0; attempt += 1) {
      await Bun.sleep(10);
    }
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
      expectedModel: EXPECTED_MODEL,
      budgets: { maxInputTokens: 10_000, maxOutputTokens: 1, maxRequests: 8 },
      fetchUpstream: async () => {
        upstreamCalls += 1;
        await Bun.sleep(5);
        return Response.json({
          usage: { prompt_tokens: 10_000, completion_tokens: 1 },
        });
      },
    });
    proxies.push(proxy);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${proxy.url}/responses`, {
          method: "POST",
          body: OPENAI_RESPONSES_BODY,
        }),
      ),
    );

    expect(responses.filter((response) => response.ok)).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 422),
    ).toHaveLength(7);
    expect(upstreamCalls).toBe(1);
    expect(proxy.snapshot()).toMatchObject({
      requestCount: 1,
      inputTokens: 10_000,
      outputTokens: 1,
    });
    expect(proxy.snapshot().failures).toEqual([
      expect.objectContaining({
        code: "STABILITY_MODEL_PRE_DISPATCH_REJECTED",
        requestNumber: 2,
      }),
    ]);
  });

  test("proxy counts and retains an oversized upstream response", async () => {
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      expectedModel: EXPECTED_MODEL,
      budgets: { maxInputTokens: 10_000, maxOutputTokens: 100, maxRequests: 2 },
      fetchUpstream: async () =>
        new Response(new Uint8Array(16 * 1024 * 1024 + 1), { status: 200 }),
    });
    proxies.push(proxy);
    expect(
      (
        await fetch(`${proxy.url}/responses`, {
          method: "POST",
          body: OPENAI_RESPONSES_BODY,
        })
      ).status,
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

  test("proxy cancels a chunked provider response at the byte cap", async () => {
    let cancelled = false;
    let chunks = 0;
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      expectedModel: EXPECTED_MODEL,
      budgets: { maxInputTokens: 10_000, maxOutputTokens: 100, maxRequests: 1 },
      fetchUpstream: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunks += 1;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    proxies.push(proxy);

    expect(
      (
        await fetch(`${proxy.url}/responses`, {
          method: "POST",
          body: OPENAI_RESPONSES_BODY,
        })
      ).status,
    ).toBe(502);
    expect(chunks).toBeLessThanOrEqual(18);
    expect(cancelled).toBe(true);
    expect(proxy.snapshot().failures.at(-1)?.code).toBe(
      "STABILITY_MODEL_PROXY_ERROR",
    );
  });

  test.each([
    { name: "malformed JSON", body: "{" },
    {
      name: "missing model",
      body: JSON.stringify({ input: "test", max_output_tokens: 1 }),
    },
    {
      name: "wrong model",
      body: JSON.stringify({
        model: "wrong-model",
        input: "test",
        max_output_tokens: 1,
      }),
    },
    {
      name: "ambiguous output caps",
      path: "/chat/completions",
      body: JSON.stringify({
        model: EXPECTED_MODEL,
        messages: [{ role: "user", content: "test" }],
        max_completion_tokens: 1,
        max_tokens: 1,
      }),
    },
    {
      name: "multimodal input",
      body: JSON.stringify({
        model: EXPECTED_MODEL,
        input: [
          { type: "input_image", image_url: "https://example.invalid/x" },
        ],
        max_output_tokens: 1,
      }),
    },
    {
      name: "indirect previous response context",
      body: JSON.stringify({
        model: EXPECTED_MODEL,
        input: "test",
        previous_response_id: "resp_provider_hosted",
        max_output_tokens: 1,
      }),
    },
    {
      name: "provider-hosted search tool",
      body: JSON.stringify({
        model: EXPECTED_MODEL,
        input: "test",
        tools: [{ type: "web_search_preview" }],
        max_output_tokens: 1,
      }),
    },
    {
      name: "oversized textual input",
      body: JSON.stringify({
        model: EXPECTED_MODEL,
        input: "x".repeat(1024 * 1024),
        max_output_tokens: 1_000_000,
      }),
    },
  ])(
    "rejects $name before credential-bearing dispatch",
    async ({ body, path }) => {
      let upstreamCalls = 0;
      const proxy = await startLiveModelEgressProxy({
        provider: "openai",
        expectedModel: EXPECTED_MODEL,
        budgets: {
          maxInputTokens: 10_000,
          maxOutputTokens: 10,
          maxRequests: 1,
        },
        upstreamCredential: "real-model-secret",
        fetchUpstream: async () => {
          upstreamCalls += 1;
          return Response.json({
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      });
      proxies.push(proxy);

      expect(
        (
          await fetch(`${proxy.url}${path ?? "/responses"}`, {
            method: "POST",
            body,
          })
        ).status,
      ).toBe(422);
      expect(upstreamCalls).toBe(0);
      expect(proxy.snapshot()).toMatchObject({
        requestCount: 0,
        failures: [
          expect.objectContaining({
            code: "STABILITY_MODEL_PRE_DISPATCH_REJECTED",
          }),
        ],
        requestEnvelopes: [expect.objectContaining({ accepted: false })],
      });
      if (body.includes("wrong-model")) {
        expect(proxy.snapshot().requestEnvelopes[0]?.observedModel).toBe(
          "wrong-model",
        );
      }
    },
  );

  test.each([
    {
      name: "Anthropic remote URL document",
      provider: "anthropic" as const,
      path: "/messages",
      body: {
        model: EXPECTED_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "url", url: "https://example.invalid/doc" },
              },
            ],
          },
        ],
        max_tokens: 1,
      },
    },
    {
      name: "OpenAI provider item reference",
      provider: "openai" as const,
      path: "/responses",
      body: {
        model: EXPECTED_MODEL,
        input: [{ type: "item_reference", id: "item_provider_hosted" }],
        max_output_tokens: 1,
      },
    },
    ...["shell", "local_shell", "apply_patch"].map((type) => ({
      name: `OpenAI hosted ${type} tool`,
      provider: "openai" as const,
      path: "/responses",
      body: {
        model: EXPECTED_MODEL,
        input: "test",
        tools: [{ type }],
        max_output_tokens: 1,
      },
    })),
    ...["web_fetch_20250910", "code_execution_20250522"].map((type) => ({
      name: `Anthropic hosted ${type} tool`,
      provider: "anthropic" as const,
      path: "/messages",
      body: {
        model: EXPECTED_MODEL,
        messages: [{ role: "user", content: "test" }],
        tools: [{ type, name: type, input_schema: {} }],
        max_tokens: 1,
      },
    })),
    ...[
      ["fallback routing", { fallbacks: ["claude-expensive"] }],
      ["default fallback routing", { fallbacks: "default" }],
      ["container", { container: "container_provider" }],
      ["context management", { context_management: { edits: [] } }],
      [
        "MCP servers",
        { mcp_servers: [{ url: "https://example.invalid/mcp" }] },
      ],
      ["premium speed", { speed: "fast" }],
      ["inference geography", { inference_geo: "us" }],
    ].map(([name, extra]) => ({
      name: `Anthropic ${name}`,
      provider: "anthropic" as const,
      path: "/messages",
      body: {
        model: EXPECTED_MODEL,
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
        ...(extra as object),
      },
    })),
    ...[
      ["multiple choices", { n: 2 }],
      ["invalid n", { n: "1" }],
      ["web search options", { web_search_options: {} }],
      ["audio modality", { modalities: ["text", "audio"] }],
      ["premium service tier", { service_tier: "priority" }],
      [
        "stream without usage",
        { stream: true, stream_options: { include_usage: false } },
      ],
      [
        "stream extra controls",
        { stream: true, stream_options: { include_usage: true, extra: true } },
      ],
    ].map(([name, extra]) => ({
      name: `OpenAI Chat ${name}`,
      provider: "openai" as const,
      path: "/chat/completions",
      body: {
        model: EXPECTED_MODEL,
        messages: [{ role: "user", content: "test" }],
        max_completion_tokens: 1,
        ...(extra as object),
      },
    })),
    ...[
      ["background execution", { background: true }],
      ["container", { container: "container_provider" }],
      ["premium service tier", { service_tier: "priority" }],
      ["generic remote URL", { url: "https://example.invalid/context" }],
    ].map(([name, extra]) => ({
      name: `OpenAI Responses ${name}`,
      provider: "openai" as const,
      path: "/responses",
      body: {
        model: EXPECTED_MODEL,
        input: "test",
        max_output_tokens: 1,
        ...(extra as object),
      },
    })),
  ])(
    "rejects endpoint-schema bypass: $name",
    async ({ provider, path, body }) => {
      let upstreamCalls = 0;
      const proxy = await startLiveModelEgressProxy({
        provider,
        expectedModel: EXPECTED_MODEL,
        budgets: {
          maxInputTokens: 10_000,
          maxOutputTokens: 10,
          maxRequests: 1,
        },
        upstreamCredential: "real-model-secret",
        fetchUpstream: async () => {
          upstreamCalls += 1;
          return Response.json({
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      });
      proxies.push(proxy);
      expect(
        (
          await fetch(`${proxy.url}${path}`, {
            method: "POST",
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(422);
      expect(upstreamCalls).toBe(0);
      expect(proxy.snapshot()).toMatchObject({
        requestCount: 0,
        requestEnvelopes: [
          {
            accepted: false,
            forwardedBodyBytes: null,
            forwardedBodySha256: null,
          },
        ],
      });
    },
  );

  test("canonicalizes output caps to the remaining attempt budget", async () => {
    const forwardedCaps: number[] = [];
    const forwardedBodies: string[] = [];
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      expectedModel: EXPECTED_MODEL,
      budgets: { maxInputTokens: 20_000, maxOutputTokens: 5, maxRequests: 2 },
      fetchUpstream: async (_url, init) => {
        const rawBody = String(init.body);
        forwardedBodies.push(rawBody);
        const body = JSON.parse(rawBody) as {
          max_output_tokens: number;
        };
        forwardedCaps.push(body.max_output_tokens);
        return Response.json({
          usage: {
            input_tokens: 1,
            output_tokens: forwardedCaps.length === 1 ? 3 : 2,
          },
        });
      },
    });
    proxies.push(proxy);
    const requestBody = JSON.stringify({
      model: EXPECTED_MODEL,
      input: "test",
      max_output_tokens: 1_000_000,
    });

    expect(
      await Promise.all(
        [1, 2].map(
          async () =>
            (
              await fetch(`${proxy.url}/responses`, {
                method: "POST",
                body: requestBody,
              })
            ).status,
        ),
      ),
    ).toEqual([200, 200]);
    expect(forwardedCaps).toEqual([5, 2]);
    expect(proxy.snapshot().requestEnvelopes).toMatchObject([
      { requestedMaxOutputTokens: 1_000_000, effectiveMaxOutputTokens: 5 },
      { requestedMaxOutputTokens: 1_000_000, effectiveMaxOutputTokens: 2 },
    ]);
    for (const [index, envelope] of proxy
      .snapshot()
      .requestEnvelopes.entries()) {
      const forwardedBody = forwardedBodies[index] ?? "";
      expect(envelope.forwardedBodyBytes).toBe(
        Buffer.byteLength(forwardedBody),
      );
      expect(envelope.forwardedBodySha256).toBe(
        new Bun.CryptoHasher("sha256").update(forwardedBody).digest("hex"),
      );
      expect(envelope.inputBudgetCharge).toBe(
        Math.max(envelope.bodyBytes, Buffer.byteLength(forwardedBody)) + 8_192,
      );
    }
  });

  test.each([
    {
      provider: "openai" as const,
      path: "/responses",
      body: {
        model: EXPECTED_MODEL,
        input: "test",
        tools: [
          {
            type: "function",
            name: "local_tool",
            parameters: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "function", name: "local_tool" },
      },
      capField: "max_output_tokens",
    },
    {
      provider: "openai" as const,
      path: "/chat/completions",
      body: {
        model: EXPECTED_MODEL,
        messages: [{ role: "user", content: "test" }],
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "local_tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "local_tool" } },
      },
      capField: "max_completion_tokens",
    },
    {
      provider: "anthropic" as const,
      path: "/messages",
      body: {
        model: EXPECTED_MODEL,
        messages: [{ role: "user", content: "test" }],
        max_tokens: 64_000,
        tools: [
          {
            name: "local_tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "tool", name: "local_tool" },
      },
      capField: "max_tokens",
    },
  ])(
    "forwards a compatible canonical $provider$path request",
    async ({ provider, path, body, capField }) => {
      let forwarded: Record<string, unknown> | undefined;
      const proxy = await startLiveModelEgressProxy({
        provider,
        expectedModel: EXPECTED_MODEL,
        budgets: {
          maxInputTokens: 10_000,
          maxOutputTokens: 7,
          maxRequests: 1,
        },
        fetchUpstream: async (_url, init) => {
          forwarded = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Response.json({
            usage:
              provider === "openai"
                ? { input_tokens: 1, output_tokens: 1 }
                : { input_tokens: 1, output_tokens: 1 },
          });
        },
      });
      proxies.push(proxy);

      expect(
        (
          await fetch(`${proxy.url}${path}`, {
            method: "POST",
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(200);
      expect(forwarded?.model).toBe(EXPECTED_MODEL);
      expect(forwarded?.[capField]).toBe(7);
      if (path === "/chat/completions") {
        expect(forwarded?.stream_options).toEqual({ include_usage: true });
      }
      expect(JSON.stringify(forwarded)).not.toContain("real-model-secret");
    },
  );

  test("proxy never follows an upstream provider redirect", async () => {
    let targetCalls = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        targetCalls += 1;
        return Response.json({ reached: true });
      },
    });
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.redirect(`http://127.0.0.1:${target.port}/target`, 302);
      },
    });
    try {
      const proxy = await startLiveModelEgressProxy({
        provider: "openai",
        expectedModel: EXPECTED_MODEL,
        budgets: {
          maxInputTokens: 10_000,
          maxOutputTokens: 100,
          maxRequests: 2,
        },
        upstreamCredential: "real-model-secret",
        upstreamOrigin: `http://127.0.0.1:${redirect.port}`,
        fetchUpstream: (url, init) => fetch(url, init),
      });
      proxies.push(proxy);

      expect(
        (
          await fetch(`${proxy.url}/responses`, {
            method: "POST",
            body: OPENAI_RESPONSES_BODY,
          })
        ).status,
      ).toBe(502);
      expect(targetCalls).toBe(0);
      expect(proxy.snapshot().failures.at(-1)).toMatchObject({
        code: "STABILITY_MODEL_PROXY_ERROR",
        requestNumber: 1,
      });
    } finally {
      redirect.stop(true);
      target.stop(true);
    }
  });

  test("proxy retains an observer failure before provider dispatch", async () => {
    let upstreamCalls = 0;
    const proxy = await startLiveModelEgressProxy({
      provider: "openai",
      expectedModel: EXPECTED_MODEL,
      budgets: { maxInputTokens: 10_000, maxOutputTokens: 100, maxRequests: 2 },
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
      (
        await fetch(`${proxy.url}/responses`, {
          method: "POST",
          body: OPENAI_RESPONSES_BODY,
        })
      ).status,
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
      expectedModel: EXPECTED_MODEL,
      budgets: { maxInputTokens: 10_000, maxOutputTokens: 100, maxRequests: 2 },
      fetchUpstream: async () =>
        ({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
            [Symbol.iterator](): IterableIterator<[string, string]> {
              throw new Error("injected response header boundary failure");
            },
          },
          body: new Response(
            new TextEncoder().encode(
              JSON.stringify({
                usage: { prompt_tokens: 2, completion_tokens: 1 },
              }),
            ),
          ).body,
        }) as unknown as Response,
    });
    proxies.push(proxy);

    expect(
      (
        await fetch(`${proxy.url}/responses`, {
          method: "POST",
          body: OPENAI_RESPONSES_BODY,
        })
      ).status,
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
