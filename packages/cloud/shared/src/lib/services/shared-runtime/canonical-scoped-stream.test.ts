/**
 * Canonical scoped SSE handler — executionCtx threading contract.
 *
 * The shared-tier billing-tail deferral (#8759 pattern for the SSE path) only
 * works if the Worker executionCtx handed to handleCanonicalScopedAgentStream
 * actually reaches elizaSandboxService.bridgeStream — dropping the parameter
 * anywhere along the chain silently reverts every turn to inline billing with
 * no failing behavior. These tests drive the REAL handler against a captured
 * bridgeStream to pin the pass-through (and its absence for non-Worker
 * callers, who must keep the inline-settle behavior).
 */

import { describe, expect, mock, test } from "bun:test";

const bridgeStream = mock(
  async (
    _agentId: string,
    _orgId: string,
    _rpc: unknown,
    _executionCtx?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response | null> =>
    new Response("event: done\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    }),
);

mock.module("../eliza-sandbox", () => ({
  elizaSandboxService: { bridgeStream },
}));

const { handleCanonicalScopedAgentStream } = await import("./canonical-scoped-stream");

const BASE = {
  agentId: "00000000-0000-4000-8000-00000000a9e0",
  orgId: "00000000-0000-4000-8000-00000000a9e1",
  conversationId: "00000000-0000-4000-8000-00000000a9e2",
  body: { text: "hello" },
};

describe("handleCanonicalScopedAgentStream — executionCtx threading", () => {
  test("threads the caller's executionCtx to bridgeStream (deferral seam)", async () => {
    bridgeStream.mockClear();
    const executionCtx = { waitUntil: (_p: Promise<unknown>) => undefined };

    const res = await handleCanonicalScopedAgentStream({ ...BASE, executionCtx });

    expect(res.status).toBe(200);
    expect(bridgeStream).toHaveBeenCalledTimes(1);
    const call = bridgeStream.mock.calls[0];
    expect(call?.[0]).toBe(BASE.agentId);
    expect(call?.[1]).toBe(BASE.orgId);
    // The SAME executionCtx object must arrive as the 4th argument — the
    // shared-tier turn hands its billing tail to exactly this waitUntil.
    expect(call?.[3]).toBe(executionCtx);
  });

  test("no executionCtx (tests, non-Worker callers): bridgeStream receives undefined", async () => {
    bridgeStream.mockClear();

    const res = await handleCanonicalScopedAgentStream({ ...BASE });

    expect(res.status).toBe(200);
    expect(bridgeStream).toHaveBeenCalledTimes(1);
    expect(bridgeStream.mock.calls[0]?.[3]).toBeUndefined();
  });
});
