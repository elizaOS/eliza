/**
 * Money-leak guard for the SHARED-runtime agent turn billing (#11169-class).
 *
 * bridgeSharedMessageSend reserves credits up front (reserveCredits), then runs
 * the turn and settles. The `degraded` and billing-failure paths refund the
 * hold, but a THROW between the reserve and the settle — runSharedAgentTurn
 * raising, or saveSharedRuntimeHistory hitting a DB blip (it runs OUTSIDE the
 * inner billing try/catch) — used to propagate WITHOUT refunding, stranding the
 * hold and over-charging the org on the DEFAULT (shared) agent tier.
 *
 * The fix wraps the post-reserve block in a try/catch that calls
 * settleReservation(0); settleReservation is idempotent (reservationSettled), so
 * a normally-settled turn is never double-refunded. This drives the REAL
 * bridgeSharedMessageSend against a spy reservation, only mocking the two module
 * seams needed to force a post-reserve throw (real code otherwise).
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

// Control whether the turn throws (post-reserve failure) or succeeds.
let turnImpl: () => unknown = () => {
  throw new Error("provider 503 during shared-runtime turn");
};

mock.module("../ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits: mock(async () => reservation),
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
  ) => Promise<unknown>;
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
  return svc;
}

const REC = {
  id: "00000000-0000-4000-8000-00000000a9e0",
  organization_id: "00000000-0000-4000-8000-00000000a9e1",
  user_id: "00000000-0000-4000-8000-00000000a9e2",
  execution_tier: "shared",
  agent_name: "Eliza",
};
const RPC = {
  jsonrpc: "2.0",
  id: 1,
  method: "message.send",
  params: { text: "hello" },
};

describe("bridgeSharedMessageSend — refunds the hold on a post-reserve throw (#11169-class)", () => {
  test("runSharedAgentTurn throwing after the reserve refunds the hold (reconcile(0)) then rethrows", async () => {
    reconcileCalls.length = 0;
    reservation = makeReservation();
    turnImpl = () => {
      throw new Error("provider 503 during shared-runtime turn");
    };
    const svc = makeService();

    await expect(svc.bridgeSharedMessageSend(REC, RPC)).rejects.toThrow("provider 503");

    // The upfront hold must have been refunded exactly once, at actualCost 0.
    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0]);
  });

  test("a DB blip in saveSharedRuntimeHistory (post-reserve, pre-settle) also refunds the hold", async () => {
    reconcileCalls.length = 0;
    reservation = makeReservation();
    // Turn succeeds (not degraded), but persisting history throws — the leak the
    // fix closes, since saveSharedRuntimeHistory runs outside the billing catch.
    turnImpl = () => ({
      degraded: false,
      reply: "hi there",
      history: [],
      model: "openai/gpt-oss-120b",
    });
    const svc = makeService();
    svc.saveSharedRuntimeHistory = mock(async () => {
      throw new Error("pg write timeout");
    }) as never;

    await expect(svc.bridgeSharedMessageSend(REC, RPC)).rejects.toThrow("pg write timeout");

    expect(reservation.reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileCalls).toEqual([0]);
  });
});
