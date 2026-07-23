/**
 * Verifies scoped SSE turns preserve the conversation coordinator contract.
 *
 * The harness drives the real protocol boundary while replacing only the
 * Durable Object stub, including typed rate and cache-warming failures.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { RateLimitError } from "../../api/errors";
import * as coordinatorActual from "./conversation-coordinator";

const coordinateSharedStream = mock(
  async (): Promise<Response> =>
    new Response("event: done\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    }),
);

mock.module("./conversation-coordinator", () => ({
  ...coordinatorActual,
  coordinateSharedStream,
}));

const { handleCanonicalScopedAgentStream } = await import("./canonical-scoped-stream");

afterAll(() => {
  mock.module("./conversation-coordinator", () => coordinatorActual);
});

const AGENT = {
  id: "00000000-0000-4000-8000-00000000a9e0",
  organization_id: "00000000-0000-4000-8000-00000000a9e1",
  user_id: "00000000-0000-4000-8000-00000000a9e3",
  execution_tier: "shared",
} as never;
const NAMESPACE = {
  getByName: mock(() => ({
    fetch: mock(async () => new Response()),
  })),
};
const EXECUTION_CTX = {
  waitUntil: (_promise: Promise<unknown>) => undefined,
};
const BASE = {
  agent: AGENT,
  agentId: AGENT.id,
  orgId: AGENT.organization_id,
  conversationId: "00000000-0000-4000-8000-00000000a9e2",
  namespace: NAMESPACE,
  executionCtx: EXECUTION_CTX,
  body: { text: "hello" },
};

describe("handleCanonicalScopedAgentStream", () => {
  beforeEach(() => {
    coordinateSharedStream.mockReset();
    coordinateSharedStream.mockResolvedValue(
      new Response("event: done\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }),
    );
  });

  test("threads the exact Worker coordinator context to the shared turn", async () => {
    const res = await handleCanonicalScopedAgentStream(BASE);

    expect(res.status).toBe(200);
    expect(coordinateSharedStream).toHaveBeenCalledTimes(1);
    const call = coordinateSharedStream.mock.calls[0];
    expect(call?.[0]).toBe(AGENT);
    expect(call?.[2]).toEqual({
      namespace: NAMESPACE,
      executionCtx: EXECUTION_CTX,
    });
  });

  test("maps exact rate denial to a retryable 429 before SSE starts", async () => {
    coordinateSharedStream.mockRejectedValueOnce(
      new RateLimitError("Organization rate limit exceeded.", 41),
    );

    const res = await handleCanonicalScopedAgentStream(BASE);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("41");
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Organization rate limit exceeded.",
      code: "rate_limit_exceeded",
      retryable: true,
    });
  });

  test("keeps cache warming distinct from rate denial", async () => {
    const warming = new Error("Rate-limit authorization cache is warming. Retry shortly.");
    warming.name = "SharedRuntimeCacheWarmingError";
    coordinateSharedStream.mockRejectedValueOnce(warming);

    const res = await handleCanonicalScopedAgentStream(BASE);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: "shared_runtime_cache_warming",
      retryable: true,
    });
  });
});
