/**
 * Money-leak guard for POST /api/v1/apps/:id/chat streaming (#10837).
 *
 * A streaming app-chat reserves credits up front, forwards the whole provider
 * response, closes the writer, and only THEN runs calculateCost +
 * reconcileCredits. Before this fix, if that post-stream accounting threw (a
 * transient DB/pricing error), the catch unconditionally full-refunded — free
 * inference, systemically so across concurrent streams during a DB blip.
 *
 * This drives the REAL `reconcileStreamProcessingError` (the exact code the
 * route runs) against a spy credit service, asserting the refund decision.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  reconcileNonStreamingSettleError,
  reconcileStreamProcessingError,
  type StreamRefundCredits,
} from "../v1/apps/[id]/chat/stream-refund";

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
  errorMessage: "transient pg timeout",
};

describe("reconcileStreamProcessingError (#10837)", () => {
  test("stream COMPLETED then accounting threw → keep the reserved charge, NO refund", async () => {
    const credits = makeCredits();
    const result = await reconcileStreamProcessingError(
      { ...base, streamCompleted: true },
      credits,
    );
    expect(result.refunded).toBe(false);
    expect(credits.reconcileCredits).not.toHaveBeenCalled();
    expect(credits.calls).toEqual([]);
  });

  test("stream FAILED before delivery → full refund (actualBaseCost 0)", async () => {
    const credits = makeCredits();
    const result = await reconcileStreamProcessingError(
      { ...base, streamCompleted: false },
      credits,
    );
    expect(result.refunded).toBe(true);
    expect(credits.reconcileCredits).toHaveBeenCalledTimes(1);
    expect(credits.calls[0]).toEqual({
      estimatedBaseCost: 0.05,
      actualBaseCost: 0,
    });
  });

  test("DB blip across 20 concurrent COMPLETED streams issues ZERO refunds (systemic-leak guard)", async () => {
    const credits = makeCredits();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reconcileStreamProcessingError(
          { ...base, userId: `user-${i}`, streamCompleted: true },
          credits,
        ),
      ),
    );
    expect(results.every((r) => r.refunded === false)).toBe(true);
    expect(credits.reconcileCredits).not.toHaveBeenCalled();
  });

  test("mixed batch: only the pre-delivery failures are refunded", async () => {
    const credits = makeCredits();
    await Promise.all([
      reconcileStreamProcessingError(
        { ...base, streamCompleted: true },
        credits,
      ),
      reconcileStreamProcessingError(
        { ...base, streamCompleted: false },
        credits,
      ),
      reconcileStreamProcessingError(
        { ...base, streamCompleted: true },
        credits,
      ),
      reconcileStreamProcessingError(
        { ...base, streamCompleted: false },
        credits,
      ),
    ]);
    // 2 delivered (no refund) + 2 pre-delivery failures (refund) = exactly 2 refunds.
    expect(credits.reconcileCredits).toHaveBeenCalledTimes(2);
    expect(credits.calls.every((c) => c.actualBaseCost === 0)).toBe(true);
  });
});

const nonStreamBase = {
  appId: "app-1",
  userId: "user-1",
  reservedBaseCost: 0.05,
  model: "openai/gpt-oss-120b",
  provider: "openai",
  billingSource: "openai",
  errorMessage: "provider body was not valid JSON",
};

describe("reconcileNonStreamingSettleError (#11169 part 1)", () => {
  test("settle threw BEFORE reconcile (not settled) → full refund (actualBaseCost 0)", async () => {
    const credits = makeCredits();
    const result = await reconcileNonStreamingSettleError(
      { ...nonStreamBase, settled: false },
      credits,
    );
    expect(result.refunded).toBe(true);
    expect(credits.reconcileCredits).toHaveBeenCalledTimes(1);
    expect(credits.calls[0]).toEqual({
      estimatedBaseCost: 0.05,
      actualBaseCost: 0,
    });
  });

  test("throw AFTER reconcile already charged (settled) → keep the charge, NO refund (no double-credit)", async () => {
    const credits = makeCredits();
    const result = await reconcileNonStreamingSettleError(
      { ...nonStreamBase, settled: true },
      credits,
    );
    expect(result.refunded).toBe(false);
    expect(credits.reconcileCredits).not.toHaveBeenCalled();
  });

  test("the refund is tagged non-streaming (streaming:false) so it's distinguishable in the ledger", async () => {
    const metaCalls: Array<Record<string, unknown> | undefined> = [];
    const credits = {
      reconcileCredits: mock(
        async (args: { metadata?: Record<string, unknown> }) => {
          metaCalls.push(args.metadata);
          return null;
        },
      ),
    } as unknown as StreamRefundCredits;
    await reconcileNonStreamingSettleError(
      { ...nonStreamBase, settled: false },
      credits,
    );
    expect(metaCalls[0]).toMatchObject({
      streaming: false,
      refundReason: "non_streaming_settle_error",
    });
  });
});
