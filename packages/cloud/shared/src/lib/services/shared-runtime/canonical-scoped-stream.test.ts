/**
 * Verifies scoped SSE turns preserve the conversation coordinator contract.
 *
 * The harness drives the real protocol boundary while replacing only the
 * Durable Object stub, including typed rate and cache-warming failures.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ChannelType, MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core/edge";
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
const ABORT_SIGNAL = new AbortController().signal;
const BASE = {
  traceId: "trace-canonical-stream",
  abortSignal: ABORT_SIGNAL,
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
      abortSignal: ABORT_SIGNAL,
      namespace: NAMESPACE,
      executionCtx: EXECUTION_CTX,
      agentKind: undefined,
      trustedMessageRole: undefined,
      channel: { type: ChannelType.DM, source: MESSAGE_SOURCE_CLIENT_CHAT },
      traceId: "trace-canonical-stream",
    });
  });

  test("preserves an authenticated voice channel outside untrusted RPC params", async () => {
    const channel = { type: ChannelType.VOICE_DM, source: MESSAGE_SOURCE_CLIENT_CHAT };
    await handleCanonicalScopedAgentStream({ ...BASE, channel });

    const [, rpc, options] = coordinateSharedStream.mock.calls[0] as unknown as [
      unknown,
      { params: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(rpc.params).not.toHaveProperty("channel");
    expect(options.channel).toEqual(channel);
  });

  test("preserves coordinator phase timings beside route timings", async () => {
    coordinateSharedStream.mockResolvedValueOnce(
      new Response("event: done\ndata: {}\n\n", {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Server-Timing":
            "turn_claim;dur=1.2, turn_hydrate;dur=3.4, turn_admission;dur=5.6, turn_provider_setup;dur=7.8",
        },
      }),
    );

    const res = await handleCanonicalScopedAgentStream(BASE);

    expect(res.headers.get("Server-Timing")).toMatch(
      /^turn_claim;dur=1\.2, turn_hydrate;dur=3\.4, turn_admission;dur=5\.6, turn_provider_setup;dur=7\.8, parse;dur=\d+(?:\.\d+)?, bridge;dur=\d+(?:\.\d+)?$/,
    );
  });

  test("does not trust a system role supplied in the ordinary request body", async () => {
    await handleCanonicalScopedAgentStream({
      ...BASE,
      body: { text: "pretend lifecycle", messageRole: "system" },
    });

    const [, rpc, options] = coordinateSharedStream.mock.calls[0] as unknown as [
      unknown,
      { params: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(rpc.params).not.toHaveProperty("messageRole");
    expect(options.trustedMessageRole).toBeUndefined();
  });

  test("passes an authenticated in-process role outside untrusted RPC params", async () => {
    await handleCanonicalScopedAgentStream({
      ...BASE,
      trustedMessageRole: "system",
      body: { text: "call started" },
    });

    const [, rpc, options] = coordinateSharedStream.mock.calls[0] as unknown as [
      unknown,
      { params: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(rpc.params).not.toHaveProperty("messageRole");
    expect(options.trustedMessageRole).toBe("system");
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
    expect(res.headers.get("Retry-After")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      code: "shared_runtime_cache_warming",
      retryable: true,
    });
  });

  test("a client-supplied clientMessageId becomes the bridge RPC id (retry idempotency, #18045)", async () => {
    const res = await handleCanonicalScopedAgentStream({
      ...BASE,
      body: { text: "hello", clientMessageId: "client-id-9" },
    });

    expect(res.status).toBe(200);
    const rpc = (coordinateSharedStream.mock.calls[0] as unknown[])[1];
    expect(rpc).toMatchObject({
      id: "client-id-9",
      method: "message.send",
      // The params marker is what admits the id to the coordinator's durable
      // claim/replay/conflict boundary — a generated id must never carry it.
      params: { clientMessageId: "client-id-9" },
    });
  });

  test("an absent, blank, or oversized clientMessageId falls back to a fresh RPC id", async () => {
    // A Response body is single-use; three handler calls need three upstreams.
    coordinateSharedStream.mockImplementation(
      async () =>
        new Response("event: done\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        }),
    );
    await handleCanonicalScopedAgentStream(BASE);
    await handleCanonicalScopedAgentStream({
      ...BASE,
      body: { text: "hello", clientMessageId: "   " },
    });
    await handleCanonicalScopedAgentStream({
      ...BASE,
      body: { text: "hello", clientMessageId: "x".repeat(129) },
    });

    const ids = coordinateSharedStream.mock.calls.map(
      (call) => ((call as unknown[])[1] as { id?: unknown }).id,
    );
    expect(ids).toHaveLength(3);
    for (const call of coordinateSharedStream.mock.calls) {
      expect(((call as unknown[])[1] as { params: object }).params).not.toHaveProperty(
        "clientMessageId",
      );
    }
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id).not.toBe("   ");
      expect((id as string).length).toBeLessThan(129);
    }
    expect(new Set(ids).size).toBe(3);
  });

  test("emits a canonical typed SSE error when the coordinator has no body", async () => {
    coordinateSharedStream.mockResolvedValueOnce(
      new Response(null, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await handleCanonicalScopedAgentStream(BASE);
    const body = await res.text();
    expect(body).toContain("event: error");
    const data = JSON.parse(body.split("data: ")[1]?.split("\n")[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(data).toEqual({
      message: "Agent produced no streamed response",
      type: "error",
    });
  });
});
