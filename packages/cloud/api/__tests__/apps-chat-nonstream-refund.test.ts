/**
 * Money-leak guard for POST /api/v1/apps/:id/chat NON-streaming (#11169 part 1).
 *
 * A non-streaming app-chat reserves credits up front, then reads the provider
 * body + computes cost and only THEN settles via reconcileCredits. Before this
 * fix, a throw between the debit and the settle (a truncated body failing
 * providerResponse.json(), or a transient pricing error in calculateCost) fell
 * through to the outer catch, which returned 500 WITHOUT refunding — the hold
 * was stranded (the streaming branch had reconcileStreamProcessingError; this
 * one had nothing).
 *
 * This drives the REAL `reconcileNonStreamProcessingError` (the exact code the
 * route runs) against a spy credit service, asserting the refund decision.
 */
import { describe, expect, mock, test } from "bun:test";
import { reconcileNonStreamProcessingError } from "../v1/apps/[id]/chat/non-stream-refund";
import type { StreamRefundCredits } from "../v1/apps/[id]/chat/stream-refund";

function makeCredits() {
  const calls: Array<{ estimatedBaseCost: number; actualBaseCost: number }> =
    [];
  const reconcileCredits = mock(
    async (args: { estimatedBaseCost: number; actualBaseCost: number }) => {
      calls.push({
        estimatedBaseCost: args.estimatedBaseCost,
        actualBaseCost: args.actualBaseCost,
      });
      return null;
    },
  );
  return { calls, reconcileCredits } satisfies {
    calls: unknown;
    reconcileCredits: StreamRefundCredits["reconcileCredits"];
  };
}

const base = {
  appId: "app-1",
  userId: "user-1",
  reservedBaseCost: 0.05,
  errorMessage: "truncated provider body",
};

describe("reconcileNonStreamProcessingError (#11169)", () => {
  test("failure BEFORE settle (reconciled=false) → full refund (actualBaseCost 0)", async () => {
    const credits = makeCredits();
    const result = await reconcileNonStreamProcessingError(
      { ...base, reconciled: false },
      credits,
    );
    expect(result.refunded).toBe(true);
    expect(credits.reconcileCredits).toHaveBeenCalledTimes(1);
    expect(credits.calls).toEqual([
      { estimatedBaseCost: 0.05, actualBaseCost: 0 },
    ]);
  });

  test("failure AFTER settle (reconciled=true) → NO refund, charge kept", async () => {
    const credits = makeCredits();
    const result = await reconcileNonStreamProcessingError(
      { ...base, reconciled: true },
      credits,
    );
    expect(result.refunded).toBe(false);
    expect(credits.reconcileCredits).not.toHaveBeenCalled();
    expect(credits.calls).toEqual([]);
  });

  test("refund propagates the reserved amount exactly (no partial)", async () => {
    const credits = makeCredits();
    await reconcileNonStreamProcessingError(
      { ...base, reconciled: false, reservedBaseCost: 0.1234 },
      credits,
    );
    expect(credits.calls).toEqual([
      { estimatedBaseCost: 0.1234, actualBaseCost: 0 },
    ]);
  });
});
