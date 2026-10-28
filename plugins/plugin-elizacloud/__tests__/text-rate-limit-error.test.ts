/** Eliza Cloud 429s reach the runtime as one typed, bounded rate-limit error. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type IAgentRuntime,
  isInsufficientCreditsError,
  isRateLimitError,
  MAX_PROVIDER_RATE_LIMIT_RETRY_AFTER_MS,
  providerRateLimitRetryAt,
  readProviderRateLimit,
  type TextStreamResult,
} from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleResponseHandler, handleTextSmall } from "../src/models/text";

import {
  getCloudInferenceFailure,
  recordCloudInferenceFailure,
} from "../src/utils/inference-diagnostics";

let server: Server;
let baseUrl: string;
let requests: string[] = [];
let onRequest: (() => void) | undefined;
let reply: { status?: number; headers: Record<string, string>; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    onRequest?.();
    req.resume();
    req.on("end", () => {
      res.writeHead(reply.status ?? 429, { "content-type": "application/json", ...reply.headers });
      res.end(reply.body);
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
  "/responses": () => handleTextSmall(runtime(), { prompt: "Say hi" } as never),
  "/chat/completions": () =>
    handleResponseHandler(runtime(), {
      prompt: "Say hi",
      messages: [{ role: "user", content: "Say hi" }],
    } as never),
  "/chat/completions (stream)": () =>
    handleResponseHandler(runtime(), {
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
