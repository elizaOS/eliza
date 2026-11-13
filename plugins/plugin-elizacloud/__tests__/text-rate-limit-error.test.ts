/**
 * Eliza Cloud 429s reach the runtime as one typed, bounded rate-limit error.
 * A connection reset soon after the send, before any response, is retried in
 * place, a few times.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AgentRuntime,
  type IAgentRuntime,
  isInsufficientCreditsError,
  isModelProviderFallbackError,
  isModelProviderRetryBudgetExhaustedError,
  isRateLimitError,
  MAX_PROVIDER_RATE_LIMIT_RETRY_AFTER_MS,
  ModelType,
  providerRateLimitRetryAt,
  readProviderRateLimit,
  type TextStreamResult,
} from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElizaCloudConnectionResetExhaustedError,
  handleResponseHandler,
  handleTextLarge,
  handleTextSmall,
  nextConnectionResetRetry,
} from "../src/models/text";

import {
  getCloudInferenceFailure,
  recordCloudInferenceFailure,
} from "../src/utils/inference-diagnostics";

/** `reset` drops the socket before the response, or after its headers and first bytes. */
type Reply = {
  status?: number;
  headers: Record<string, string>;
  body: string;
  reset?: "before-response" | "after-headers";
};

let server: Server;
let baseUrl: string;
let requests: string[] = [];
let onRequest: (() => void) | undefined;
let reply: Reply;
/** Answers for the next requests, in order, before `reply`. */
let replies: Reply[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    onRequest?.();
    req.resume();
    req.on("end", () => {
      const next = replies.shift() ?? reply;
      if (next.reset === "before-response") {
        req.socket.destroy();
        return;
      }
      res.writeHead(next.status ?? 429, { "content-type": "application/json", ...next.headers });
      if (next.reset === "after-headers") {
        res.write(next.body);
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      res.end(next.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  replies = [];
  onRequest = undefined;
});

function runtime(): IAgentRuntime {
  const settings: Record<string, string> = {
    ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
    ELIZAOS_CLOUD_BASE_URL: baseUrl,
    ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "gpt-oss-120b",
  };
  return {
    character: { name: "Rate limit test", bio: [] },
    getSetting: (key: string) => settings[key],
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

/** The plan-bucket 429 body Eliza Cloud sends (`planRequestLimitedResponse`). */
function planBucketBody(error: Record<string, unknown> = {}): string {
  return JSON.stringify({
    error: {
      message: "Too many requests in a short time for this plan. Retry after the wait.",
      type: "rate_limit_error",
      code: "rate_limited",
      retryAfterSeconds: 3,
      retryAfterMs: 2_400,
      retryAt: "2026-10-14T00:00:02.400Z",
      plan: { id: "pro" },
      limit: { bucket: "burst", capacity: 5, refillPerSecond: 1, selected: true },
      ...error,
    },
  });
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await run();
    if (result && typeof result === "object" && "textStream" in result) {
      for await (const _chunk of (result as TextStreamResult).textStream) {
        // drain
      }
    }
  } catch (error) {
    return error;
  }
  throw new Error("Cloud call completed without the 429");
}

const routes = {
  "/responses": (agent = runtime()) => handleTextSmall(agent, { prompt: "Say hi" } as never),
  "/chat/completions": (agent = runtime()) =>
    handleResponseHandler(agent, {
      prompt: "Say hi",
      messages: [{ role: "user", content: "Say hi" }],
    } as never),
  "/chat/completions (stream)": (agent = runtime()) =>
    handleResponseHandler(agent, {
      prompt: "Say hi",
      messages: [{ role: "user", content: "Say hi" }],
      stream: true,
      streamStructured: true,
    } as never),
} as const;

describe("Eliza Cloud text 429", () => {
  it.each(Object.keys(routes) as (keyof typeof routes)[])(
    "%s maps the plan-bucket body to a typed rate limit without retrying",
    async (route) => {
      reply = { headers: { "Retry-After": "3" }, body: planBucketBody() };
      const error = await failure(routes[route]);
      expect(requests).toHaveLength(1);
      expect(isRateLimitError(error)).toBe(true);
      expect((error as { status?: number }).status).toBe(429);
      expect((error as Error).message).toBe(
        "Too many requests in a short time for this plan. Retry after the wait."
      );
      expect((error as { rateLimit?: unknown }).rateLimit).toEqual({
        kind: "rate_limited",
        retryAfterMs: 2_400,
        planId: "pro",
        scope: "burst",
        resetAt: "2026-10-14T00:00:02.400Z",
        resetAfterSeconds: 3,
      });
      // Not a retry hint: the coding planner's wait-and-retry reads
      // `providerRateLimitRetryAt` and must keep failing fast on Cloud 429s.
      expect(providerRateLimitRetryAt(error)).toBeUndefined();
      // Only the bounded fields: no provider message or other body fields.
      expect(Object.keys(readProviderRateLimit(error) ?? {}).sort()).toEqual([
        "kind",
        "planId",
        "resetAfterSeconds",
        "resetAt",
        "retryAfterMs",
        "scope",
      ]);
    }
  );

  it("reads the org-tier body and falls back to Retry-After", async () => {
    reply = {
      headers: { "Retry-After": "60" },
      body: JSON.stringify({
        success: false,
        error: "Too many requests",
        code: "rate_limit_exceeded",
        retryAfterSeconds: 17,
      }),
    };
    expect(readProviderRateLimit(await failure(routes["/chat/completions"]))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 17_000,
    });

    reply = { headers: { "Retry-After": "7" }, body: "upstream busy" };
    expect(readProviderRateLimit(await failure(routes["/responses"]))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 7_000,
    });
  });

  it("carries the period-allowance reset time past the wait cap", async () => {
    reply = {
      headers: { "Retry-After": "259200" },
      body: JSON.stringify({
        error: {
          code: "allowance_exhausted",
          service: "inference",
          resetsAt: "2026-11-01T00:00:00.000Z",
          retryAfterSeconds: 259_200,
        },
      }),
    };
    const error = await failure(routes["/chat/completions"]);
    expect(isRateLimitError(error)).toBe(true);
    expect(readProviderRateLimit(error)).toEqual({
      kind: "rate_limited",
      retryAfterMs: MAX_PROVIDER_RATE_LIMIT_RETRY_AFTER_MS,
      scope: "period",
      resetAt: "2026-11-01T00:00:00.000Z",
      resetAfterSeconds: 259_200,
    });
  });

  it("reads the org-tier X-RateLimit-Reset header as the reset time", async () => {
    const resetAt = new Date(Date.now() + 17_000).toISOString();
    reply = {
      headers: { "X-RateLimit-Reset": resetAt },
      body: JSON.stringify({
        success: false,
        error: "Too many requests",
        code: "rate_limit_exceeded",
        retryAfterSeconds: 99,
      }),
    };
    // The reset came from the header, so its seconds are the time to that
    // reset, not the body's unrelated retryAfterSeconds.
    expect(readProviderRateLimit(await failure(routes["/responses"]))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 99_000,
      resetAt,
      resetAfterSeconds: 17,
    });
  });

  it("derives the wait from the reset time when no retry field is sent", async () => {
    const resetAt = new Date(Date.now() + 5_000).toISOString();
    reply = { headers: { "X-RateLimit-Reset": resetAt }, body: "{}" };
    const rateLimit = readProviderRateLimit(await failure(routes["/chat/completions"]));
    expect(rateLimit).toMatchObject({ kind: "rate_limited", resetAt, resetAfterSeconds: 5 });
    expect(rateLimit?.retryAfterMs).toBeGreaterThan(4_000);
    expect(rateLimit?.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it("reports the inference 402 allowance refusal with its reset, without retrying", async () => {
    const resetsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    reply = {
      status: 402,
      headers: {},
      body: JSON.stringify({
        error: {
          message: "Plan allowance is used up for this period. Nothing is purchased automatically.",
          type: "insufficient_quota",
          code: "allowance_exhausted",
          resetsAt,
        },
      }),
    };
    const error = await failure(routes["/chat/completions"]);
    expect(requests).toHaveLength(1);
    expect(isInsufficientCreditsError(error)).toBe(true);
    expect(isRateLimitError(error)).toBe(false);
    expect(providerRateLimitRetryAt(error)).toBeUndefined();
    expect(readProviderRateLimit(error)).toEqual({
      kind: "rate_limited",
      retryAfterMs: MAX_PROVIDER_RATE_LIMIT_RETRY_AFTER_MS,
      scope: "period",
      resetAt: resetsAt,
      resetAfterSeconds: 172_800,
    });

    // A plain credits 402 carries no rate limit.
    reply = {
      status: 402,
      headers: {},
      body: JSON.stringify({
        error: {
          type: "insufficient_quota",
          code: "insufficient_credits",
          message: "Insufficient credits",
        },
      }),
    };
    expect(readProviderRateLimit(await failure(routes["/responses"]))).toBeUndefined();
  });

  it("drops a reset time without a time zone", async () => {
    reply = {
      headers: {},
      body: JSON.stringify({
        error: {
          code: "allowance_exhausted",
          resetsAt: "2026-11-01T00:00:00",
          retryAfterSeconds: 10,
        },
      }),
    };
    expect(readProviderRateLimit(await failure(routes["/responses"]))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 10_000,
      scope: "period",
    });
  });

  it("ignores malformed headers and body fields", async () => {
    reply = {
      headers: { "Retry-After": "soon", "Retry-After-Ms": "-5" },
      body: JSON.stringify({ error: { message: "slow down", retryAfterMs: "2400" } }),
    };
    const error = await failure(routes["/chat/completions (stream)"]);
    expect(isRateLimitError(error)).toBe(true);
    expect((error as { rateLimit?: unknown }).rateLimit).toBeUndefined();
    expect(readProviderRateLimit(error)).toBeUndefined();

    reply = {
      headers: { "Retry-After": "soon" },
      body: planBucketBody({
        retryAfterMs: Number.NaN,
        retryAfterSeconds: -1,
        retryAt: "soon",
        plan: { id: "pro plan; key=sk-secret" },
        limit: { bucket: "monthly" },
      }),
    };
    expect(readProviderRateLimit(await failure(routes["/responses"]))).toBeUndefined();
  });

  it("caps the wait and drops unsafe plan ids and unknown scopes", async () => {
    reply = {
      headers: {},
      body: planBucketBody({
        retryAfterMs: 10 * 60 * 60 * 1000,
        retryAt: "next month",
        plan: { id: "x".repeat(65) },
        limit: { bucket: "monthly" },
      }),
    };
    expect(readProviderRateLimit(await failure(routes["/chat/completions"]))).toEqual({
      kind: "rate_limited",
      retryAfterMs: MAX_PROVIDER_RATE_LIMIT_RETRY_AFTER_MS,
    });
  });
});

describe("Eliza Cloud connection reset before any response", () => {
  type Route = keyof typeof routes;
  const allRoutes = Object.keys(routes) as Route[];
  const chatOk = JSON.stringify({
    choices: [
      { index: 0, message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" },
    ],
  });
  // The stream route takes the gateway's buffered JSON answer as one chunk.
  const ok: Record<Route, Reply> = {
    "/responses": {
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Hi there" }] }],
      }),
    },
    "/chat/completions": { status: 200, headers: {}, body: chatOk },
    "/chat/completions (stream)": { status: 200, headers: {}, body: chatOk },
  };
  const resetBeforeResponse: Reply = { headers: {}, body: "", reset: "before-response" };
  /** The error Bun's fetch rejects with when the socket closes before a response. */
  const bunSocketClosed = (): Error =>
    Object.assign(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"
      ),
      { code: "ECONNRESET", path: baseUrl, errno: 0 }
    );

  async function replyText(route: Route): Promise<string> {
    const result = await routes[route]();
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && "textStream" in result) {
      let text = "";
      for await (const chunk of (result as TextStreamResult).textStream) text += chunk;
      return text;
    }
    return (result as { text: string }).text;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(allRoutes)("%s retries a Node socket reset before the headers", async (route) => {
    replies = [resetBeforeResponse];
    reply = ok[route];
    expect(await replyText(route)).toBe("Hi there");
    expect(requests).toHaveLength(2);
  });

  it.each(allRoutes)("%s retries Bun's top-level ECONNRESET", async (route) => {
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .fn((input: RequestInfo | URL, init?: RequestInit) => realFetch(input, init))
      .mockRejectedValueOnce(bunSocketClosed());
    vi.stubGlobal("fetch", fetchSpy);
    reply = ok[route];
    expect(await replyText(route)).toBe("Hi there");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
  });

  it.each(allRoutes)(
    "%s stops after two retries with the typed provider budget exhaustion",
    async (route) => {
      reply = resetBeforeResponse;
      const error = await failure(routes[route]);
      expect(requests).toHaveLength(3);
      expect(error).toBeInstanceOf(ElizaCloudConnectionResetExhaustedError);
      // useModel reads these: skip this provider's sibling registrations,
      // still fail over to a distinct provider.
      expect(isModelProviderRetryBudgetExhaustedError(error)).toBe(true);
      expect(isModelProviderFallbackError(error, "TEXT_SMALL")).toBe(true);
      expect((error as Error).cause).toMatchObject({
        message: "fetch failed",
        cause: { code: "UND_ERR_SOCKET" },
      });
    }
  );

  it.each(allRoutes)(
    "%s records a spent budget of Bun resets as transport, as one raw Bun reset was",
    async (route) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const fetchSpy = vi.fn(async () => {
        throw bunSocketClosed();
      });
      vi.stubGlobal("fetch", fetchSpy);
      const agent = runtime();
      const error = await failure(() => routes[route](agent));
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(error).toBeInstanceOf(ElizaCloudConnectionResetExhaustedError);
      // Support reads this reason in /api/status.
      const diagnostic = getCloudInferenceFailure(agent);
      expect(diagnostic?.reason).toBe("transport");
      expect(diagnostic).not.toHaveProperty("status");
    }
  );

  it.each(allRoutes)("%s sends a fast reset again but never a late one", async (route) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    // Past the 1 s window: a buffered generation may have finished and billed.
    const late = bunSocketClosed();
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(bunSocketClosed())
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => setTimeout(() => reject(late), 1_200))
      );
    vi.stubGlobal("fetch", fetchSpy);
    const agent = runtime();
    const error = await failure(() => routes[route](agent));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Thrown unchanged, as before this retry existed.
    expect(error).toBe(late);
    expect(getCloudInferenceFailure(agent)?.reason).toBe("transport");
  });

  it("spends one budget per useModel call, then skips this provider's siblings", async () => {
    reply = resetBeforeResponse;
    const agent = new AgentRuntime({
      character: {
        name: "Reset dispatch test",
        bio: [],
        settings: {
          secrets: { ELIZAOS_CLOUD_API_KEY: "synthetic-test-key" },
          ELIZAOS_CLOUD_BASE_URL: baseUrl,
        },
      },
      logLevel: "fatal",
      adapter: { createLogs: async () => undefined },
    } as never);
    agent.registerModel(ModelType.TEXT_SMALL, handleTextSmall as never, "elizaOSCloud", 10);
    agent.registerModel(ModelType.TEXT_LARGE, handleTextLarge as never, "elizaOSCloud", 10);
    const distinct = vi.fn(async () => "Hi from another provider");
    agent.registerModel(ModelType.TEXT_LARGE, distinct, "other", 0);
    expect(await agent.useModel(ModelType.TEXT_SMALL, { prompt: "Say hi" })).toBe(
      "Hi from another provider"
    );
    // The TEXT_LARGE Cloud registration adds no attempts of its own.
    expect(requests).toHaveLength(3);
    expect(distinct).toHaveBeenCalledTimes(1);
  });

  it.each(allRoutes)("%s never resends after the headers arrived", async (route) => {
    reply = { status: 200, headers: {}, body: '{"choices":', reset: "after-headers" };
    const error = await failure(routes[route]);
    expect(requests).toHaveLength(1);
    expect(isModelProviderRetryBudgetExhaustedError(error)).toBe(false);
  });

  it.each(allRoutes)("%s never retries a 429", async (route) => {
    reply = {
      headers: {},
      body: JSON.stringify({ error: { message: "Too Many Requests", type: "rate_limit_error" } }),
    };
    const error = await failure(routes[route]);
    expect(requests).toHaveLength(1);
    expect(isRateLimitError(error)).toBe(true);
    expect((error as { status?: number }).status).toBe(429);
  });

  it("keeps the added wait under 2 s", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999_999);
    const state = { attempt: 0 };
    const reset = bunSocketClosed();
    const waits = [
      nextConnectionResetRetry(state, reset, 0, "responses"),
      nextConnectionResetRetry(state, reset, 1_000, "responses"),
    ].map((retry) => ("delayMs" in retry ? retry.delayMs : Number.NaN));
    expect(waits).toEqual([499, 1_499]);
    expect(waits[0] + waits[1]).toBeLessThanOrEqual(2_000);
    expect(nextConnectionResetRetry(state, reset, 0, "responses")).toEqual({
      error: expect.any(ElizaCloudConnectionResetExhaustedError),
    });
    // Late resets, other transport failures and cancelled calls are thrown unchanged.
    expect(nextConnectionResetRetry({ attempt: 0 }, reset, 1_001, "responses")).toEqual({
      error: reset,
    });
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(nextConnectionResetRetry({ attempt: 0 }, refused, 0, "responses")).toEqual({
      error: refused,
    });
    expect(
      nextConnectionResetRetry({ attempt: 0 }, reset, 0, "responses", AbortSignal.abort())
    ).toEqual({ error: reset });
  });

  it.each(["/chat/completions", "/chat/completions (stream)"] as const)(
    "%s ends the backoff when the caller cancels",
    async (route) => {
      const controller = new AbortController();
      const reason = new DOMException("Synthetic user Stop", "AbortError");
      replies = [resetBeforeResponse];
      reply = ok[route];
      onRequest = () => setTimeout(() => controller.abort(reason), 100);
      await expect(
        handleResponseHandler(runtime(), {
          prompt: "Say hi",
          messages: [{ role: "user", content: "Say hi" }],
          signal: controller.signal,
          ...(route === "/chat/completions (stream)"
            ? { stream: true, streamStructured: true }
            : {}),
        } as never)
      ).rejects.toBe(reason);
      // Past the longest first wait (499 ms): the call was not sent again.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(requests).toHaveLength(1);
    }
  );

  it("records the reset when the stream timeout ends the backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999_999);
    vi.stubEnv("ELIZAOS_CLOUD_TEXT_TIMEOUT_MS", "150");
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValueOnce(bunSocketClosed());
    vi.stubGlobal("fetch", fetchSpy);
    const agent = runtime();
    // The first wait is 499 ms, so the 150 ms timeout fires inside it.
    const error = await failure(() => routes["/chat/completions (stream)"](agent));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(getCloudInferenceFailure(agent)?.reason).toBe("transport");
  });
});

describe("content-free support diagnostics", () => {
  it.each([false, true])(
    "keeps the original HTTP failure and final strict schema facts with stream=%s",
    async (stream) => {
      const agent = runtime();
      reply = {
        status: 400,
        headers: {},
        body: JSON.stringify({
          error: {
            message: "Unsupported schema keyword pattern. PRIVATE_NOTE sk-private",
            param: "tools",
            code: "invalid_request_error",
          },
        }),
      };
      let failure: unknown;
      try {
        await handleResponseHandler(agent, {
          prompt: "PRIVATE_PROMPT",
          stream,
          streamStructured: stream,
          tools: [
            {
              name: "HANDLE_RESPONSE",
              type: "function",
              strict: true,
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: { intentId: { type: "string", pattern: "^intent:[1-9][0-9]*$" } },
                required: ["intentId"],
              },
            },
          ],
          toolChoice: "required",
        } as never);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        status: 400,
        message: "Unsupported schema keyword pattern. PRIVATE_NOTE sk-private",
      });
      expect(requests).toEqual(["/api/v1/chat/completions"]);
      const diagnostic = getCloudInferenceFailure(agent);
      expect(diagnostic).toEqual({
        version: 1,
        at: expect.any(Number),
        stage: "response-handler",
        status: 400,
        reason: "unsupported-schema-keyword",
        parameter: "tools",
        keyword: "pattern",
        strictTools: ["HANDLE_RESPONSE"],
        schemaKeywords: ["pattern"],
        schemaScanTruncated: false,
        schemaDepth: 2,
        schemaProperties: 1,
        schemaEnumValues: 0,
        schemaTextChars: 8,
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE|sk-private|intentId/);
      if (!diagnostic) throw new Error("Missing failure");
      diagnostic.strictTools.push("other");
      expect(getCloudInferenceFailure(agent)?.strictTools).toEqual(["HANDLE_RESPONSE"]);
    }
  );

  it.each(["nested-tools", "flat-tools", "chat-schema", "responses-schema"])(
    "inspects the final %s schema envelope without retaining payloads",
    (shape) => {
      const agent = runtime(),
        schema = { type: "string", pattern: "PRIVATE_PATTERN" };
      const request =
        shape === "nested-tools"
          ? {
              tools: [
                {
                  type: "function",
                  function: { name: "READ_CONTEXT", strict: true, parameters: schema },
                },
              ],
            }
          : shape === "flat-tools"
            ? {
                tools: [
                  { type: "function", name: "READ_CONTEXT", strict: true, parameters: schema },
                ],
              }
            : shape === "chat-schema"
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: { name: "PRIVATE_SCHEMA", strict: true, schema },
                  },
                }
              : {
                  text: {
                    format: { type: "json_schema", name: "PRIVATE_SCHEMA", strict: true, schema },
                  },
                };
      const original = structuredClone(request);
      recordCloudInferenceFailure(
        agent,
        "TEXT_SMALL",
        request,
        Object.assign(new Error("Unknown failure"), { status: 400 })
      );
      const diagnostic = getCloudInferenceFailure(agent);
      expect(diagnostic?.schemaKeywords).toEqual(["pattern"]);
      expect(diagnostic?.strictTools).toEqual(shape.endsWith("tools") ? ["READ_CONTEXT"] : []);
      expect(diagnostic?.stage).toBe("text");
      expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
      expect(request).toEqual(original);
    }
  );

  it("keeps an actual Responses HTTP refusal classified without inventing native tools", async () => {
    const agent = runtime();
    reply = {
      status: 400,
      headers: {},
      body: JSON.stringify({ error: { message: "Unknown error PRIVATE_BODY" } }),
    };
    await expect(
      handleTextSmall(agent, { prompt: "PRIVATE_PROMPT" } as never)
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toEqual(["/api/v1/responses"]);
    expect(getCloudInferenceFailure(agent)).toMatchObject({
      stage: "text",
      status: 400,
      reason: "unknown",
      strictTools: [],
      schemaKeywords: [],
      schemaScanTruncated: false,
    });
  });

  it.each([false, true])(
    "does not log a user's in-flight cancellation with stream=%s",
    async (stream) => {
      const agent = runtime(),
        controller = new AbortController();
      const reason = new DOMException("Synthetic user Stop", "AbortError");
      reply = {
        status: 200,
        headers: {},
        body: JSON.stringify({ choices: [{ message: { content: "not accepted after Stop" } }] }),
      };
      onRequest = () => controller.abort(reason);
      await expect(
        handleResponseHandler(agent, {
          prompt: "Synthetic request",
          messages: [{ role: "user", content: "Synthetic request" }],
          stream,
          streamStructured: stream,
          signal: controller.signal,
        } as never)
      ).rejects.toBe(reason);
      expect(requests).toEqual(["/api/v1/chat/completions"]);
      expect(getCloudInferenceFailure(agent)).toBeUndefined();
    }
  );

  it.each(["prefixItems", "items", "not", "additionalProperties"])(
    "marks unexpanded %s schema children incomplete",
    (container) => {
      const agent = runtime(),
        child = { type: "string", pattern: "PRIVATE_CHILD" };
      const schema = {
        type: "object",
        [container]: container === "prefixItems" || container === "items" ? [child] : child,
      };
      recordCloudInferenceFailure(
        agent,
        "RESPONSE_HANDLER",
        { tools: [{ function: { name: "HANDLE_RESPONSE", strict: true, parameters: schema } }] },
        Object.assign(new Error("Unknown failure"), { status: 400 })
      );
      const diagnostic = getCloudInferenceFailure(agent);
      expect(diagnostic?.schemaScanTruncated).toBe(true);
      expect(diagnostic?.schemaKeywords).not.toContain("pattern");
      expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_CHILD");
    }
  );

  it("reports bounded schema aggregates without copying names, descriptions or values", () => {
    const agent = runtime();
    const schema = {
      type: "object",
      description: "PRIVATE_IGNORED_DESCRIPTION",
      properties: {
        "🧪": { type: "string", enum: ["a", "🧪"] },
        second: { type: "string", const: "x" },
      },
      required: ["🧪", "second"],
      additionalProperties: false,
    };
    recordCloudInferenceFailure(
      agent,
      "RESPONSE_HANDLER",
      { tools: [{ function: { name: "HANDLE_RESPONSE", strict: true, parameters: schema } }] },
      Object.assign(new Error("JSON schema exceeds maximum number of enum values PRIVATE_BODY"), {
        status: 400,
      })
    );
    const diagnostic = getCloudInferenceFailure(agent);
    expect(diagnostic).toMatchObject({
      reason: "schema-limit",
      schemaDepth: 2,
      schemaProperties: 2,
      schemaEnumValues: 2,
      schemaTextChars: 10,
      schemaScanTruncated: false,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE|second|🧪/);
  });

  it("omits unknown provider fields and bounds recursive schema inspection without changing the input", () => {
    const agent = runtime();
    const cyclic: Record<string, unknown> = { type: "array" };
    cyclic.items = cyclic;
    const request = {
      tools: [
        {
          type: "function",
          function: { name: "PRIVATE_TOOL_NAME", strict: true, parameters: cyclic },
        },
      ],
    };
    const error = Object.assign(new Error("PRIVATE_UNKNOWN_ERROR"), {
      status: 400,
      error: { param: "PRIVATE_PARAM", code: "PRIVATE_CODE", message: "PRIVATE_BODY" },
    });
    recordCloudInferenceFailure(agent, "PRIVATE_MODEL_TYPE", request, error);
    const diagnostic = getCloudInferenceFailure(agent);
    expect(diagnostic).toMatchObject({
      stage: "other",
      status: 400,
      reason: "unknown",
      strictTools: ["other"],
      schemaKeywords: [],
      schemaScanTruncated: true,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE/);
    expect(cyclic.items).toBe(cyclic);
    expect(error.message).toBe("PRIVATE_UNKNOWN_ERROR");
    const hostile = Object.defineProperty({}, "message", {
      get() {
        throw new Error("PRIVATE_GETTER");
      },
    });
    expect(() => recordCloudInferenceFailure(agent, "TEXT_LARGE", request, hostile)).not.toThrow();
    expect(getCloudInferenceFailure(agent)).toEqual(diagnostic);
  });
});
