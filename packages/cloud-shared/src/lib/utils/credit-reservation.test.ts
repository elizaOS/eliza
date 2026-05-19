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
): CreditReservation {
  return { reconcile: reconcileFn } as unknown as CreditReservation;
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

  test("allows retry after reconcile throws", async () => {
    let calls = 0;
    const reservation = makeReservation(async (cost) => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return fakeResult;
    });

    const settle = createCreditReservationSettler(reservation);

    await expect(settle(0.001)).rejects.toThrow("transient");
    // After failure the once-guard resets, so a second call retries
    const result = await settle(0.001);
    expect(calls).toBe(2);
    expect(result).toEqual(fakeResult);
  });
});
