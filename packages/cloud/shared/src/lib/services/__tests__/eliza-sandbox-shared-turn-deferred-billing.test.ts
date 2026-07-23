/**
 * Deferred billing-tail proof for the SHARED-runtime agent turn.
 *
 * bridgeSharedMessageSend returns the reply as soon as the turn ran and history
 * persisted; the billing tail (billUsage → settleReservation → analytics →
 * audit, ~1.7s of cross-region RTT) runs via executionCtx.waitUntil OFF the
 * response path. These tests drive the REAL bridgeSharedMessageSend against a
 * spy reservation and a capturing waitUntil to prove the money invariants
 * survive the deferral:
 *   (a) the reply resolves while billUsage is still in flight,
 *   (b) the deferred task still settles the hold at billing.totalCost,
 *   (c) a billUsage throw still refunds the hold (reconcile(0)) — deferred,
 *   (d) without an executionCtx the tail runs inline (pre-deferral behavior),
 *   (e) the degraded path refunds synchronously and never uses waitUntil.
 */

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { describe, expect, mock, test } from "bun:test";

const aiBillingActual = await import("../ai-billing");
const runTurnActual = await import("../shared-runtime/run-shared-agent-turn");

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

// Controllable seams: the turn result and the billUsage behavior.
let turnImpl: () => unknown = () => ({
  degraded: false,
  reply: "hi there",
  history: [],
  model: "openai/gpt-oss-120b",
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
  runSharedAgentTurn: mock(async () => turnImpl()),
}));

const { ElizaSandboxService } = await import("../eliza-sandbox");

type BridgeCallable = {
  bridgeSharedMessageSend: (
    rec: Record<string, unknown>,
    rpc: { jsonrpc: string; id: number; method: string; params: { text: string } },
    executionCtx?: { waitUntil(promise: Promise<unknown>): void },
  ) => Promise<{ result?: { text?: string } }>;
  buildSharedRuntimeCharacter: (...args: unknown[]) => Promise<unknown>;
  loadSharedRuntimeHistory: (...args: unknown[]) => Promise<unknown>;
  saveSharedRuntimeHistory: (...args: unknown[]) => Promise<unknown>;
};

function makeService(): BridgeCallable {
  const svc = new ElizaSandboxService() as unknown as BridgeCallable;
  // Private seams the turn path calls before/after runSharedAgentTurn.
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

function reset() {
  reconcileCalls.length = 0;
  reservation = makeReservation();
  turnImpl = () => ({
    degraded: false,
    reply: "hi there",
    history: [],
    model: "openai/gpt-oss-120b",
  });
  billUsageImpl = async () => ({ totalCost: 0.0042 });
}

const REC = {
  id: "00000000-0000-4000-8000-00000000b1e0",
  organization_id: "00000000-0000-4000-8000-00000000b1e1",
  user_id: "00000000-0000-4000-8000-00000000b1e2",
  execution_tier: "shared",
  agent_name: "Eliza",
};
const RPC = {
  jsonrpc: "2.0",
  id: 1,
  method: "message.send",
  params: { text: "hello" },
};

describe("bridgeSharedMessageSend — billing tail deferred via executionCtx.waitUntil", () => {
  test("reply resolves BEFORE the billing tail; deferred task settles at billing.totalCost", async () => {
    reset();
    // Gate billUsage so we can prove the reply did not wait for it.
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

    // (a) resolves while billUsage is still blocked on the gate.
    const response = await svc.bridgeSharedMessageSend(REC, RPC, ctx);
    expect(response.result?.text).toBe("hi there");
    expect(ctx.captured).toHaveLength(1);
    expect(reservation.reconcile).not.toHaveBeenCalled();

    // (b) the deferred task still settles the hold, at the billed cost.
    releaseBill?.();
    await ctx.captured[0];
    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0.0042]);
  });

  test("billUsage throwing in the deferred task refunds the hold (reconcile(0)) without failing the reply", async () => {
    reset();
    billUsageImpl = async () => {
      throw new Error("cross-region billing write failed");
    };
    const ctx = makeExecutionCtx();
    const svc = makeService();

    const response = await svc.bridgeSharedMessageSend(REC, RPC, ctx);
    expect(response.result?.text).toBe("hi there");
    expect(ctx.captured).toHaveLength(1);

    // The waitUntil promise must resolve (never reject — Workers would log an
    // unhandled rejection) and must have refunded the hold exactly once.
    await ctx.captured[0];
    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0]);
  });

  test("without an executionCtx the tail runs inline: settled by the time the reply resolves", async () => {
    reset();
    const svc = makeService();

    const response = await svc.bridgeSharedMessageSend(REC, RPC);
    expect(response.result?.text).toBe("hi there");
    // Pre-deferral behavior preserved for tests / non-Worker callers.
    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0.0042]);
  });

  test("degraded turn refunds synchronously and never touches waitUntil", async () => {
    reset();
    turnImpl = () => ({
      degraded: true,
      reply: "degraded reply",
      history: [],
      model: "openai/gpt-oss-120b",
    });
    const ctx = makeExecutionCtx();
    const svc = makeService();

    await svc.bridgeSharedMessageSend(REC, RPC, ctx);
    expect(ctx.captured).toHaveLength(0);
    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0]);
  });
});
