/**
 * Deferred billing-tail proof for the SHARED-runtime SSE stream turn.
 *
 * bridgeSharedMessageStream emits the `done` SSE frame as soon as the last
 * token arrived and history persisted; the billing tail (billUsage →
 * settleReservation → analytics → audit, ~4 serial cross-region Worker→DB
 * round-trips ≈ 1.5-2s) runs via executionCtx.waitUntil OFF the stream path —
 * the same #8759 deferral the non-stream send already has. These tests drive
 * the REAL bridgeSharedMessageStream against a spy reservation and a capturing
 * waitUntil to prove the money invariants survive the deferral:
 *   (a) the `done` frame flushes while billUsage is still in flight,
 *   (b) the deferred task still settles the hold at billing.totalCost,
 *   (c) a billUsage throw still refunds the hold (reconcile(0)) — deferred,
 *   (d) without an executionCtx the tail runs inline (pre-deferral behavior).
 */

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { describe, expect, mock, test } from "bun:test";

const aiBillingActual = await import("../ai-billing");
const runTurnActual = await import("../shared-runtime/run-shared-agent-turn");

import type { SharedAgentTurnStreamPart } from "../shared-runtime/run-shared-agent-turn";

// A reservation whose reconcile() records every settle amount.
const reconcileCalls: number[] = [];
const makeReservation = () => ({
  reservedAmount: 0.01,
  reconcile: mock(async (actualCost: number) => {
    reconcileCalls.push(actualCost);
    return null;
  }),
});
let reservation = makeReservation();

function makeParts(finalText: string): AsyncIterable<SharedAgentTurnStreamPart> {
  return (async function* () {
    yield { type: "text-delta", text: finalText } as const;
    yield { type: "finish", text: finalText } as const;
  })();
}

// Controllable seams: the stream turn result and the billUsage behavior.
let streamTurnImpl: () => unknown = () => ({
  model: "openai/gpt-oss-120b",
  degraded: false,
  parts: makeParts("hi there"),
});
let billUsageImpl: () => Promise<{ totalCost: number }> = async () => ({ totalCost: 0.0042 });

mock.module("../ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits: mock(async () => reservation),
  billUsage: mock(async () => billUsageImpl()),
  recordUsageAnalytics: mock(async () => null),
}));

mock.module("../shared-runtime/run-shared-agent-turn", () => ({
  ...runTurnActual,
  // Keep the model billable so a reservation is actually taken.
  resolveSharedAgentTurnModel: () => "openai/gpt-oss-120b",
  runSharedAgentTurnStream: mock(async () => streamTurnImpl()),
}));

const { ElizaSandboxService } = await import("../eliza-sandbox");

type StreamCallable = {
  bridgeSharedMessageStream: (
    rec: Record<string, unknown>,
    rpc: { jsonrpc: string; id: number; method: string; params: { text: string } },
    executionCtx?: { waitUntil(promise: Promise<unknown>): void },
  ) => Promise<Response>;
  buildSharedRuntimeCharacter: (...args: unknown[]) => Promise<unknown>;
  loadSharedRuntimeHistory: (...args: unknown[]) => Promise<unknown>;
  saveSharedRuntimeHistory: (...args: unknown[]) => Promise<unknown>;
};

function makeService(): StreamCallable {
  const svc = new ElizaSandboxService() as unknown as StreamCallable;
  // Private seams the turn path calls before/after runSharedAgentTurnStream.
  svc.buildSharedRuntimeCharacter = mock(async () => ({
    name: "Eliza",
    model: "openai/gpt-oss-120b",
    system: "",
    bio: [],
  })) as never;
  svc.loadSharedRuntimeHistory = mock(async () => []) as never;
  svc.saveSharedRuntimeHistory = mock(async () => undefined) as never;
  return svc;
}

/** executionCtx spy that captures every promise handed to waitUntil. */
function makeExecutionCtx() {
  const captured: Promise<unknown>[] = [];
  return {
    captured,
    waitUntil: (p: Promise<unknown>) => {
      captured.push(p);
    },
  };
}

async function drainSse(response: Response): Promise<string> {
  return await response.text();
}

function reset() {
  reconcileCalls.length = 0;
  reservation = makeReservation();
  streamTurnImpl = () => ({
    model: "openai/gpt-oss-120b",
    degraded: false,
    parts: makeParts("hi there"),
  });
  billUsageImpl = async () => ({ totalCost: 0.0042 });
}

const REC = {
  id: "00000000-0000-4000-8000-00000000c1e0",
  organization_id: "00000000-0000-4000-8000-00000000c1e1",
  user_id: "00000000-0000-4000-8000-00000000c1e2",
  execution_tier: "shared",
  agent_name: "Eliza",
};
const RPC = {
  jsonrpc: "2.0",
  id: 1,
  method: "message.send",
  params: { text: "hello" },
};

describe("bridgeSharedMessageStream — billing tail deferred via executionCtx.waitUntil", () => {
  test("persists complete grounding internally without emitting provider evidence in done SSE", async () => {
    reset();
    const providerBody = "PRIVATE_PROVIDER_BODY_MARKER";
    const sourceExcerpt = "PRIVATE_SOURCE_EXCERPT_MARKER";
    const internalGrounding = {
      kind: "web_search" as const,
      query: "what is btc price rn",
      provider: "parallel" as const,
      observedAt: Date.UTC(2026, 7, 23, 12, 0, 0),
      sourceUrls: ["https://coin.example/bitcoin"],
      sources: [{ url: "https://coin.example/bitcoin", text: sourceExcerpt }],
      text: providerBody,
      truncated: false,
    };
    streamTurnImpl = () => ({
      model: "openai/gpt-oss-120b",
      degraded: false,
      internalGrounding,
      parts: makeParts("Bitcoin is current. [Source](https://coin.example/bitcoin)"),
    });
    const svc = makeService();

    const response = await svc.bridgeSharedMessageStream(REC, RPC);
    const body = await drainSse(response);

    expect(svc.saveSharedRuntimeHistory).toHaveBeenCalledTimes(1);
    const persisted = (svc.saveSharedRuntimeHistory as ReturnType<typeof mock>).mock.calls[0]?.[2];
    expect(persisted).toBeArray();
    expect((persisted as Array<Record<string, unknown>>).at(-1)?.grounding).toEqual(
      internalGrounding,
    );
    expect(body).toContain("event: done");
    expect(body).toContain("Bitcoin is current.");
    expect(body).not.toContain(providerBody);
    expect(body).not.toContain(sourceExcerpt);
    expect(body).not.toContain("internalGrounding");
  });

  test("`done` frame flushes BEFORE the billing tail; deferred task settles at billing.totalCost", async () => {
    reset();
    // Gate billUsage so we can prove the stream completed without waiting on it.
    let releaseBill: (() => void) | undefined;
    const billGate = new Promise<void>((resolve) => {
      releaseBill = resolve;
    });
    billUsageImpl = async () => {
      await billGate;
      return { totalCost: 0.0042 };
    };
    const ctx = makeExecutionCtx();
    const svc = makeService();

    const response = await svc.bridgeSharedMessageStream(REC, RPC, ctx);
    // (a) the full SSE body (including `done`) drains while billUsage is still
    // blocked on the gate — the stream never awaited the billing tail.
    const body = await drainSse(response);
    expect(body).toContain("event: done");
    expect(body).toContain("hi there");
    expect(ctx.captured).toHaveLength(1);
    expect(reservation.reconcile).not.toHaveBeenCalled();

    // (b) the deferred task still settles the hold, at the billed cost.
    releaseBill?.();
    await ctx.captured[0];
    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0.0042]);
  });

  test("billUsage throwing in the deferred task refunds the hold (reconcile(0)) without failing the stream", async () => {
    reset();
    billUsageImpl = async () => {
      throw new Error("cross-region billing write failed");
    };
    const ctx = makeExecutionCtx();
    const svc = makeService();

    const response = await svc.bridgeSharedMessageStream(REC, RPC, ctx);
    const body = await drainSse(response);
    expect(body).toContain("event: done");
    expect(ctx.captured).toHaveLength(1);

    // The waitUntil promise must resolve (never reject — Workers would log an
    // unhandled rejection) and must have refunded the hold exactly once.
    await ctx.captured[0];
    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0]);
  });

  test("without an executionCtx the tail runs inline: settled by the time the stream drains", async () => {
    reset();
    const svc = makeService();

    const response = await svc.bridgeSharedMessageStream(REC, RPC);
    const body = await drainSse(response);
    expect(body).toContain("event: done");
    // Pre-deferral behavior preserved for tests / non-Worker callers.
    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0.0042]);
  });

  test("client cancel between last token and `done` frame never refunds a delivered turn", async () => {
    reset();
    // Gate the parts iterator between the text-delta and the finish part so the
    // test can cancel the response stream while the turn is still "delivering".
    let releaseFinish: (() => void) | undefined;
    const finishGate = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    streamTurnImpl = () => ({
      model: "openai/gpt-oss-120b",
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta", text: "hi there" } as const;
        await finishGate;
        yield { type: "finish", text: "hi there" } as const;
      })(),
    });
    // Gate billUsage so the deferred tail provably cannot settle before the
    // stream's catch runs — pre-fix, the catch's settle(0) always won this race.
    let releaseBill: (() => void) | undefined;
    const billGate = new Promise<void>((resolve) => {
      releaseBill = resolve;
    });
    billUsageImpl = async () => {
      await billGate;
      return { totalCost: 0.0042 };
    };
    const ctx = makeExecutionCtx();
    const svc = makeService();

    const response = await svc.bridgeSharedMessageStream(REC, RPC, ctx);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the chunk frame
    await reader.cancel(); // client disconnects; the later `done` enqueue throws
    releaseFinish?.();

    // Let the start() continuation run: history persists, the tail registers,
    // the `done` enqueue throws into the stream catch.
    while (ctx.captured.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    releaseBill?.();
    await ctx.captured[0];

    // The reply was fully generated and persisted — the hold must settle at the
    // billed cost exactly once, never refund via the stream catch.
    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0.0042]);
  });
});
