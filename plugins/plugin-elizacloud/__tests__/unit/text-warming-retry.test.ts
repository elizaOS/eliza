/**
 * Offline unit coverage for the cold-gateway warming retry: a 503 whose body
 * carries a structural `*_cache_warming` code, the inference admission
 * boundary's exact `rate_limit_unavailable` or `inference_admission_unavailable`
 * shape, or the retryable
 * service_unavailable envelope is retried in place with bounded backoff so a
 * gateway that recovers in ~3s stays within one registration. Persistent
 * unavailability preserves a typed exhaustion signal for provider-aware
 * fallback, while every other failure still throws immediately. The fetch is
 * mocked; timers are faked to drive the backoff deterministically.
 */
import { type IAgentRuntime, MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetNativeChatLimiterForTests,
  ElizaCloudGatewayWarmingExhaustedError,
  generateNativeChatCompletion,
  handleResponseHandler,
  isWarmingUnavailableResponse,
  nextWarmingRetryDelayMs,
  requestNativeWithWarmingRetry,
  streamNativeChatCompletion,
  withNativeChatLimit,
} from "../../src/models/text";

type RuntimeFixture = Pick<IAgentRuntime, "character" | "emitEvent" | "getSetting"> &
  Partial<IAgentRuntime>;

type ElizaErrorShape = Error & { code?: string; status?: number };

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

const WARMING_BODY = {
  error: {
    message: "Authorization cache is warming. Retry shortly.",
    type: "service_unavailable",
    code: "auth_cache_warming",
  },
};

const REAL_FAILURE_BODY = {
  error: {
    message: "upstream provider exploded",
    type: "api_error",
    code: "upstream_error",
  },
};

const RATE_LIMIT_UNAVAILABLE_BODY = {
  success: false,
  error: "Rate limit unavailable",
  code: "rate_limit_unavailable",
  message: "The inference rate limiter is temporarily unavailable.",
};

const ADMISSION_UNAVAILABLE_BODY = {
  error: {
    message: "Inference admission is temporarily unavailable. Retry shortly.",
    type: "service_unavailable",
    code: "inference_admission_unavailable",
  },
};

function warmingResponse(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(WARMING_BODY), {
    status: 503,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function realFailureResponse(): Response {
  return new Response(JSON.stringify(REAL_FAILURE_BODY), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

function rateLimitUnavailableResponse(): Response {
  return new Response(JSON.stringify(RATE_LIMIT_UNAVAILABLE_BODY), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "1" },
  });
}

function admissionUnavailableResponse(): Response {
  return new Response(JSON.stringify(ADMISSION_UNAVAILABLE_BODY), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "1" },
  });
}

const transientResponses = [
  ["cache warming", warmingResponse],
  ["inference admission unavailable", admissionUnavailableResponse],
] as const;

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function sseResponse(): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(frames, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function mockFetchSequence(responses: Array<() => Response>): ReturnType<typeof vi.fn> {
  let call = 0;
  const impl = vi.fn(async () => {
    const factory = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return factory();
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(impl as unknown as typeof fetch);
  return impl;
}

/** A fetch that settles only when its request signal aborts. */
function hangingFetchUntilAbort(): ReturnType<typeof vi.fn> {
  const impl = vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      })
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(impl as unknown as typeof fetch);
  return impl;
}

const CONTEXT = { modelName: "gemma-4-31b", prompt: "hello" };
const NATIVE_PARAMS = {
  prompt: "hello",
  messages: [{ role: "user", content: "hello" }],
} as Parameters<typeof generateNativeChatCompletion>[2];

describe("warming 503 classification", () => {
  it("recognizes every explicit transient gateway shape", () => {
    expect(isWarmingUnavailableResponse(503, JSON.stringify(WARMING_BODY))).toBe(true);
    expect(
      isWarmingUnavailableResponse(
        503,
        JSON.stringify({ error: { code: "rate_limit_cache_warming" } })
      )
    ).toBe(true);
    expect(
      isWarmingUnavailableResponse(
        503,
        JSON.stringify({ error: { code: "inference_dependency_cache_warming" } })
      )
    ).toBe(true);
    expect(
      isWarmingUnavailableResponse(
        503,
        JSON.stringify({
          success: false,
          error: "Authorization cache is warming; retry shortly",
          code: "service_unavailable",
          details: { retryable: true, retryAfterSeconds: 1 },
        })
      )
    ).toBe(true);
    expect(isWarmingUnavailableResponse(503, JSON.stringify(RATE_LIMIT_UNAVAILABLE_BODY))).toBe(
      true
    );
    expect(isWarmingUnavailableResponse(503, JSON.stringify(ADMISSION_UNAVAILABLE_BODY))).toBe(
      true
    );
  });

  it("rejects real failures, non-503 statuses, and unparseable bodies", () => {
    expect(isWarmingUnavailableResponse(503, JSON.stringify(REAL_FAILURE_BODY))).toBe(false);
    expect(isWarmingUnavailableResponse(200, JSON.stringify(WARMING_BODY))).toBe(false);
    expect(isWarmingUnavailableResponse(502, JSON.stringify(WARMING_BODY))).toBe(false);
    expect(isWarmingUnavailableResponse(502, JSON.stringify(ADMISSION_UNAVAILABLE_BODY))).toBe(
      false
    );
    expect(
      isWarmingUnavailableResponse(
        503,
        JSON.stringify({ success: false, code: "service_unavailable" })
      )
    ).toBe(false);
    expect(
      isWarmingUnavailableResponse(503, JSON.stringify({ code: "rate_limit_unavailable" }))
    ).toBe(false);
    expect(isWarmingUnavailableResponse(503, "<html>bad gateway</html>")).toBe(false);
    expect(isWarmingUnavailableResponse(503, "")).toBe(false);
  });

  it("bounds the retry budget and honors Retry-After within the cap", () => {
    const state = { attempt: 0 };
    const delays: number[] = [];
    for (;;) {
      const delay = nextWarmingRetryDelayMs(state, warmingResponse(), JSON.stringify(WARMING_BODY));
      if (delay === undefined) break;
      delays.push(delay);
      expect(delays.length).toBeLessThan(10);
    }
    expect(delays).toEqual([250, 500, 1000, 1500]);
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3000);

    const headerState = { attempt: 0 };
    expect(
      nextWarmingRetryDelayMs(
        headerState,
        warmingResponse({ "Retry-After": "1" }),
        JSON.stringify(WARMING_BODY)
      )
    ).toBe(1000);
    expect(
      nextWarmingRetryDelayMs(
        headerState,
        warmingResponse({ "Retry-After": "30" }),
        JSON.stringify(WARMING_BODY)
      )
    ).toBe(2000);
  });
});

describe("buffered native chat completion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(transientResponses)(
    "retries %s with backoff and succeeds without throwing",
    async (_label, response) => {
      const fetchMock = mockFetchSequence([response, response, successResponse]);
      const pending = generateNativeChatCompletion(runtime(), "TEXT_SMALL", NATIVE_PARAMS, CONTEXT);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.text).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  );

  it("fails over immediately on a real provider 503 (no retry, no delay)", async () => {
    const fetchMock = mockFetchSequence([realFailureResponse]);
    const pending = generateNativeChatCompletion(
      runtime(),
      "TEXT_SMALL",
      NATIVE_PARAMS,
      CONTEXT
    ).catch((error: Error & { status?: number }) => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { status?: number }).status).toBe(503);
    expect((error as Error).message).toBe("upstream provider exploded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(transientResponses)(
    "spends exactly one bounded retry budget for %s and preserves typed exhaustion",
    async (_label, response) => {
      const fetchMock = mockFetchSequence([response]);
      const pending = generateNativeChatCompletion(
        runtime(),
        "TEXT_SMALL",
        NATIVE_PARAMS,
        CONTEXT
      ).catch((error: Error & { status?: number }) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toBeInstanceOf(ElizaCloudGatewayWarmingExhaustedError);
      expect((error as ElizaErrorShape).code).toBe(MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED);
      expect((error as Error & { status?: number }).status).toBe(503);
      // 1 initial attempt + 4 bounded retries, then the normal error path.
      expect(fetchMock).toHaveBeenCalledTimes(5);
    }
  );

  it("waits the server-declared Retry-After before the next attempt", async () => {
    const fetchMock = mockFetchSequence([
      () => warmingResponse({ "Retry-After": "1" }),
      successResponse,
    ]);
    const pending = generateNativeChatCompletion(runtime(), "TEXT_SMALL", NATIVE_PARAMS, CONTEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const result = await pending;
    expect(result.text).toBe("ok");
  });

  it.each([
    ["admission limiter", rateLimitUnavailableResponse],
    ["admission reservation", admissionUnavailableResponse],
  ] as const)("retries a cold %s and stays on Cloud", async (_label, response) => {
    const fetchMock = mockFetchSequence([response, successResponse]);
    const pending = generateNativeChatCompletion(runtime(), "TEXT_SMALL", NATIVE_PARAMS, CONTEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("streaming native chat completion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY = "1";
    __resetNativeChatLimiterForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.ELIZAOS_CLOUD_NATIVE_CONCURRENCY;
    __resetNativeChatLimiterForTests();
  });

  it.each(transientResponses)(
    "retries %s then streams the recovered response",
    async (_label, response) => {
      const fetchMock = mockFetchSequence([response, sseResponse]);
      const pending = streamNativeChatCompletion(runtime(), "TEXT_SMALL", NATIVE_PARAMS, CONTEXT);
      await vi.runAllTimersAsync();
      const result = await pending;
      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }
      expect(chunks.join("")).toBe("hi");
      await expect(result.text).resolves.toBe("hi");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it("retries an unavailable admission limiter then streams the recovered response", async () => {
    const fetchMock = mockFetchSequence([rateLimitUnavailableResponse, sseResponse]);
    const pending = streamNativeChatCompletion(runtime(), "TEXT_SMALL", NATIVE_PARAMS, CONTEXT);
    await vi.runAllTimersAsync();
    const result = await pending;
    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);
    expect(chunks.join("")).toBe("hi");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on a real provider 503 without consuming retries", async () => {
    const fetchMock = mockFetchSequence([realFailureResponse]);
    const pending = streamNativeChatCompletion(
      runtime(),
      "TEXT_SMALL",
      NATIVE_PARAMS,
      CONTEXT
    ).catch((error: Error & { status?: number }) => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect((error as Error & { status?: number }).status).toBe(503);
    expect((error as Error).message).toBe("upstream provider exploded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight buffered completion with the caller's signal", async () => {
    const fetchMock = hangingFetchUntilAbort();
    const controller = new AbortController();
    const abortReason = new DOMException("turn cancelled", "AbortError");
    const pending = generateNativeChatCompletion(
      runtime(),
      "TEXT_SMALL",
      { ...NATIVE_PARAMS, signal: controller.signal },
      CONTEXT
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort(abortReason);
    await vi.advanceTimersByTimeAsync(0);
    await expect(Promise.race([pending, Promise.resolve("still pending")])).resolves.toBe(
      abortReason
    );
  });

  it("still applies the client timeout to a buffered completion that carries a caller signal", async () => {
    const previous = process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS;
    process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS = "1000";
    try {
      const fetchMock = hangingFetchUntilAbort();
      const controller = new AbortController();
      const pending = generateNativeChatCompletion(
        runtime(),
        "TEXT_SMALL",
        { ...NATIVE_PARAMS, signal: controller.signal },
        CONTEXT
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      const settled = await Promise.race([pending, Promise.resolve("still pending")]);
      expect(settled).toBeInstanceOf(Error);
      expect(controller.signal.aborted).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS;
      else process.env.ELIZAOS_CLOUD_TEXT_TIMEOUT_MS = previous;
    }
  });

  it("aborts an in-flight /responses round-trip with the caller's signal", async () => {
    const fetchMock = hangingFetchUntilAbort();
    const controller = new AbortController();
    const abortReason = new DOMException("turn cancelled", "AbortError");
    const pending = handleResponseHandler(runtime(), {
      prompt: "hello",
      signal: controller.signal,
    } as Parameters<typeof handleResponseHandler>[1]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");
    controller.abort(abortReason);
    await vi.advanceTimersByTimeAsync(0);
    await expect(Promise.race([pending, Promise.resolve("still pending")])).resolves.toBe(
      abortReason
    );
  });

  it.each(transientResponses)(
    "ends a buffered completion's %s backoff on caller abort without another request",
    async (_label, response) => {
      const fetchMock = mockFetchSequence([response]);
      const controller = new AbortController();
      const abortReason = new DOMException("turn cancelled", "AbortError");
      const pending = generateNativeChatCompletion(
        runtime(),
        "TEXT_SMALL",
        { ...NATIVE_PARAMS, signal: controller.signal },
        CONTEXT
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      controller.abort(abortReason);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBe(abortReason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each(transientResponses)(
    "preserves caller abort during %s backoff without another request",
    async (_label, response) => {
      const fetchMock = mockFetchSequence([response]);
      const controller = new AbortController();
      const abortReason = new DOMException("turn cancelled", "AbortError");
      const pending = streamNativeChatCompletion(
        runtime(),
        "TEXT_SMALL",
        { ...NATIVE_PARAMS, signal: controller.signal },
        CONTEXT
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      controller.abort(abortReason);
      await expect(pending).rejects.toBe(abortReason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("releases the concurrency permit when a warming response body read aborts", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("turn cancelled", "AbortError");
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller.signal.addEventListener(
          "abort",
          () => streamController.error(controller.signal.reason),
          { once: true }
        );
      },
    });
    const fetchMock = mockFetchSequence([
      () =>
        new Response(body, {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const pending = streamNativeChatCompletion(
      runtime(),
      "TEXT_SMALL",
      { ...NATIVE_PARAMS, signal: controller.signal },
      CONTEXT
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    controller.abort(abortReason);
    await expect(pending).rejects.toBe(abortReason);

    let followupEntered = false;
    await expect(
      withNativeChatLimit(async () => {
        followupEntered = true;
        return "released";
      })
    ).resolves.toBe("released");
    expect(followupEntered).toBe(true);
  });

  it.each(transientResponses)(
    "preserves typed exhaustion when %s streaming spends its one retry budget",
    async (_label, response) => {
      const fetchMock = mockFetchSequence([response]);
      const pending = streamNativeChatCompletion(
        runtime(),
        "TEXT_SMALL",
        NATIVE_PARAMS,
        CONTEXT
      ).catch((error: Error) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toBeInstanceOf(ElizaCloudGatewayWarmingExhaustedError);
      expect((error as ElizaErrorShape).code).toBe(MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    }
  );
});

describe("requestNativeWithWarmingRetry contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the final response with its body pre-read", async () => {
    let calls = 0;
    const pending = requestNativeWithWarmingRetry(async () => {
      calls += 1;
      return calls === 1 ? warmingResponse() : successResponse();
    }, "responses");
    await vi.runAllTimersAsync();
    const { response, bodyText } = await pending;
    expect(response.status).toBe(200);
    expect(JSON.parse(bodyText).choices[0].message.content).toBe("ok");
    expect(calls).toBe(2);
  });
});
