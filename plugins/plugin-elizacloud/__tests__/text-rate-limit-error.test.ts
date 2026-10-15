/** Eliza Cloud 429s reach the runtime as one typed, bounded rate-limit error. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type IAgentRuntime,
  isRateLimitError,
  MAX_PROVIDER_RATE_LIMIT_RETRY_AFTER_MS,
  providerRateLimitRetryAt,
  readProviderRateLimit,
  type TextStreamResult,
} from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleResponseHandler, handleTextSmall } from "../src/models/text";

let server: Server;
let baseUrl: string;
let requests: string[] = [];
let reply: { headers: Record<string, string>; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.writeHead(429, { "content-type": "application/json", ...reply.headers });
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
      });
      // Not a retry hint: the coding planner's wait-and-retry reads
      // `providerRateLimitRetryAt` and must keep failing fast on Cloud 429s.
      expect(providerRateLimitRetryAt(error)).toBeUndefined();
      // Only the bounded fields: no provider message or other body fields.
      expect(Object.keys(readProviderRateLimit(error) ?? {}).sort()).toEqual([
        "kind",
        "planId",
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
