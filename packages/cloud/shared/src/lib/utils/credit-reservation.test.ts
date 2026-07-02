/**
 * Tests for createCreditReservationSettler.
 *
 * The settler is the mechanism that prevents double-settlement when audit
 * record writes fail after the credit reservation has already been reconciled.
 * Issue: cloud-api#7794 — non-streaming handler was calling settleReservation(0)
 * from its catch block after settleReservation(billing.totalCost) had already
 * run, potentially double-settling. The once-guard here prevents that.
 */

import { describe, expect, test } from "bun:test";
import type { CreditReconciliationResult, CreditReservation } from "../services/credits";
import { createCreditReservationSettler } from "./credit-reservation";

function makeReservation(
  reconcileFn: (cost: number) => Promise<CreditReconciliationResult>,
  reservationTransactionId?: string | null,
): CreditReservation {
  return {
    reservedAmount: fakeResult.reservedAmount,
    reservationTransactionId,
    reconcile: reconcileFn,
  } as CreditReservation;
}

const fakeResult: CreditReconciliationResult = {
  reservedAmount: 0.001,
  actualCost: 0.0007,
  adjustmentType: "refund",
  reservationTransactionId: "txn-1",
  settlementTransactionIds: ["txn-2"],
};

describe("createCreditReservationSettler", () => {
  test("returns null immediately when no reservation is provided", async () => {
    const settle = createCreditReservationSettler(undefined);
    const result = await settle(0.001);
    expect(result).toBeNull();
  });

  test("calls reconcile once and returns the result", async () => {
    let calls = 0;
    const reservation = makeReservation(async (cost) => {
      calls++;
      expect(cost).toBe(0.001);
      return fakeResult;
    });

    const settle = createCreditReservationSettler(reservation);
    const result = await settle(0.001);

    expect(calls).toBe(1);
    expect(result).toEqual(fakeResult);
  });

  test("once-guard: second call returns cached result without re-running reconcile", async () => {
    let calls = 0;
    const reservation = makeReservation(async () => {
      calls++;
      return fakeResult;
    });

    const settle = createCreditReservationSettler(reservation);
    const first = await settle(0.001);
    const second = await settle(0); // simulates the catch-block settleReservation(0)

    expect(calls).toBe(1);
    expect(first).toEqual(fakeResult);
    expect(second).toEqual(fakeResult); // returns cached, does not re-run with 0
  });

  test("concurrent calls both return the same result with only one reconcile run", async () => {
    let calls = 0;
    const reservation = makeReservation(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return fakeResult;
    });

    const settle = createCreditReservationSettler(reservation);
    const [r1, r2] = await Promise.all([settle(0.001), settle(0.001)]);

    expect(calls).toBe(1);
    expect(r1).toEqual(fakeResult);
    expect(r2).toEqual(fakeResult);
  });

  test("#11512: unkeyed throw does NOT reset the guard — reconcile never re-runs", async () => {
    // reconcileCredits commits the org refund BEFORE its throw-prone
    // post-refund writes. If a rejected settle reset the once-guard, the
    // route's fallback settleReservation?.(0) re-invoked reconcile and issued
    // a SECOND committed refund (2×reserved − actual = minted cashable
    // credit). First-call-wins must hold across rejection too.
    let calls = 0;
    const reservation = makeReservation(async () => {
      calls++;
      if (calls === 1) throw new Error("post-refund write blip");
      return fakeResult; // would be a second refund — must be unreachable
    });

    const settle = createCreditReservationSettler(reservation);

    await expect(settle(0.001)).rejects.toThrow("post-refund write blip");
    // The route's multi-site fallback call: same rejection, NO re-invoke.
    await expect(settle(0)).rejects.toThrow("post-refund write blip");
    expect(calls).toBe(1);
  });

  test("#11608: keyed throw may retry with the first actual cost", async () => {
    let calls = 0;
    const costs: number[] = [];
    const reservation = makeReservation(async (cost) => {
      calls++;
      costs.push(cost);
      if (calls === 1) throw new Error("post-refund write blip");
      return { ...fakeResult, actualCost: cost };
    }, "txn-1");

    const settle = createCreditReservationSettler(reservation);

    await expect(settle(0.0042)).rejects.toThrow("post-refund write blip");
    const result = await settle(0);

    expect(result?.actualCost).toBe(0.0042);
    expect(calls).toBe(2);
    expect(costs).toEqual([0.0042, 0.0042]);
  });

  test("#11512: concurrent call during an eventually-rejecting settle shares the rejection", async () => {
    let calls = 0;
    const reservation = makeReservation(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("late failure");
    });

    const settle = createCreditReservationSettler(reservation);
    const [r1, r2] = await Promise.allSettled([settle(0.001), settle(0)]);

    expect(calls).toBe(1);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
  });

  // Streaming-path invariants (cloud-api v1/chat/completions/route.ts).
  // handleStreamingRequest's streamText callbacks share ONE settler:
  //   onFinish success → settleReservation(billing.totalCost)
  //   onFinish throw    → settleReservation(0)
  //   onAbort           → settleReservation(0)
  // The once-guard guarantees the actual cost is settled exactly once even
  // when these fire in either order, so a thrown onFinish or a late onAbort
  // can never refund/double-settle a stream that already billed.

  test("settle(0) releases without re-billing once a real cost is settled (onFinish-then-abort)", async () => {
    const reconciledCosts: number[] = [];
    const reservation = makeReservation(async (cost) => {
      reconciledCosts.push(cost);
      return fakeResult;
    });

    const settle = createCreditReservationSettler(reservation);

    // onFinish bills the real usage…
    const finished = await settle(0.0042);
    // …then a late onAbort fires with the release amount.
    const aborted = await settle(0);

    // reconcile ran exactly once, with the real cost — the abort's 0 is a no-op.
    expect(reconciledCosts).toEqual([0.0042]);
    expect(finished).toEqual(fakeResult);
    expect(aborted).toEqual(fakeResult);
  });

  test("abort-then-finish: first settlement wins, second is a no-op", async () => {
    const reconciledCosts: number[] = [];
    const reservation = makeReservation(async (cost) => {
      reconciledCosts.push(cost);
      return fakeResult;
    });

    const settle = createCreditReservationSettler(reservation);

    // onAbort releases first…
    const aborted = await settle(0);
    // …a racing onFinish then tries to bill the real cost.
    const finished = await settle(0.0042);

    // Still a single settlement — the abort's release is authoritative.
    expect(reconciledCosts).toEqual([0]);
    expect(aborted).toEqual(fakeResult);
    expect(finished).toEqual(fakeResult);
  });

  test("settle(0) on a no-op (anonymous) reservation releases without billing", async () => {
    // createAnonymousReservation() returns a reservation whose reconcile is a
    // void no-op; the onAbort settleReservation(0) path must not throw.
    let calls = 0;
    const reservation = makeReservation(async () => {
      calls++;
      return undefined as unknown as CreditReconciliationResult;
    });

    const settle = createCreditReservationSettler(reservation);
    const result = await settle(0);

    expect(calls).toBe(1);
    expect(result).toBeNull();
  });
});
