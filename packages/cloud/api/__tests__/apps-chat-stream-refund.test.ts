/**
 * Money-leak guard for POST /api/v1/apps/:id/chat settle errors
 * (#10837 streaming, #11169 part 1 non-streaming).
 *
 * An app-chat request reserves credits up front, and only AFTER delivering
 * (stream forwarded / provider body read) runs calculateCost +
 * reconcileCredits. Both delivery paths share ONE settle-error refund —
 * `reconcileChatSettleError` — gated by a per-site `skipRefund` flag:
 * refunding a fully-delivered stream or an already-invoked settle would hand
 * out free inference / double-credit, systemically so during a DB blip.
 *
 * This drives the REAL `reconcileChatSettleError` (the exact code the route
 * runs) with each call site's exact parameterization (mirrored from
 * route.ts) against a spy credit service, asserting the refund decision and
 * the ledger description/metadata each site sends. The route-level suite
 * (apps-chat-nonstreaming-settle-guard.test.ts) drives the real route.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  type ChatSettleCredits,
  reconcileChatSettleError,
} from "../v1/apps/[id]/chat/stream-refund";

function makeCredits() {
  const calls: Array<{
    estimatedBaseCost: number;
    actualBaseCost: number;
    description: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const reconcileCredits = mock(
    async (args: {
      estimatedBaseCost: number;
      actualBaseCost: number;
      description: string;
      metadata?: Record<string, unknown>;
    }) => {
      calls.push({
        estimatedBaseCost: args.estimatedBaseCost,
        actualBaseCost: args.actualBaseCost,
        description: args.description,
        metadata: args.metadata,
      });
      return null;
    },
  );
  return { calls, reconcileCredits } satisfies {
    calls: unknown;
    reconcileCredits: ChatSettleCredits["reconcileCredits"];
  };
}

const base = {
  appId: "app-1",
  userId: "user-1",
  reservedBaseCost: 0.05,
};

/** The streaming call site's exact parameterization (route.ts). */
function streamingSiteParams(streamCompleted: boolean, userId = base.userId) {
  return {
    ...base,
    userId,
    skipRefund: streamCompleted,
    skipRefundLog:
      "[App Chat] Post-stream accounting failed AFTER full delivery; keeping reserved charge (NOT refunding)",
    refundLog:
      "[App Chat] Stream processing failed before delivery, refunding reserved",
    refundDescription: "Refund due to stream error",
    refundMetadata: { error: true, streaming: true },
    errorMessage: "transient pg timeout",
  };
}

/** The non-streaming call site's exact parameterization (route.ts). */
function nonStreamingSiteParams(settleStarted: boolean) {
  const model = "openai/gpt-oss-120b";
  return {
    ...base,
    skipRefund: settleStarted,
    skipRefundLog:
      "[App Chat] Non-streaming throw at/after the settle reconcile; NOT refunding (movement may have committed — sweep recovers a stranded hold)",
    refundLog:
      "[App Chat] Non-streaming settle never started after debit; refunding reserved hold (#11169)",
    refundDescription: `Chat refund (non-streaming settle failed): ${model}`,
    refundMetadata: {
      error: true,
      streaming: false,
      model,
      provider: "openai",
      billingSource: "openai",
      refundReason: "non_streaming_settle_error",
    },
    errorMessage: "provider body was not valid JSON",
  };
}

describe("reconcileChatSettleError — streaming site (#10837)", () => {
  test("stream COMPLETED then accounting threw → keep the reserved charge, NO refund", async () => {
    const credits = makeCredits();
    const result = await reconcileChatSettleError(
      streamingSiteParams(true),
      credits,
    );
    expect(result.refunded).toBe(false);
    expect(credits.reconcileCredits).not.toHaveBeenCalled();
    expect(credits.calls).toEqual([]);
  });

  test("stream FAILED before delivery → full refund (actualBaseCost 0)", async () => {
    const credits = makeCredits();
    const result = await reconcileChatSettleError(
      streamingSiteParams(false),
      credits,
    );
    expect(result.refunded).toBe(true);
    expect(credits.reconcileCredits).toHaveBeenCalledTimes(1);
    expect(credits.calls[0]).toEqual({
      estimatedBaseCost: 0.05,
      actualBaseCost: 0,
      description: "Refund due to stream error",
      metadata: { error: true, streaming: true },
    });
  });

  test("DB blip across 20 concurrent COMPLETED streams issues ZERO refunds (systemic-leak guard)", async () => {
    const credits = makeCredits();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reconcileChatSettleError(
          streamingSiteParams(true, `user-${i}`),
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
      reconcileChatSettleError(streamingSiteParams(true), credits),
      reconcileChatSettleError(streamingSiteParams(false), credits),
      reconcileChatSettleError(streamingSiteParams(true), credits),
      reconcileChatSettleError(streamingSiteParams(false), credits),
    ]);
    // 2 delivered (no refund) + 2 pre-delivery failures (refund) = exactly 2 refunds.
    expect(credits.reconcileCredits).toHaveBeenCalledTimes(2);
    expect(credits.calls.every((c) => c.actualBaseCost === 0)).toBe(true);
  });
});

describe("reconcileChatSettleError — non-streaming site (#11169 part 1)", () => {
  test("throw BEFORE the settle reconcile was invoked → full refund (actualBaseCost 0)", async () => {
    const credits = makeCredits();
    const result = await reconcileChatSettleError(
      nonStreamingSiteParams(false),
      credits,
    );
    expect(result.refunded).toBe(true);
    expect(credits.reconcileCredits).toHaveBeenCalledTimes(1);
    expect(credits.calls[0]).toMatchObject({
      estimatedBaseCost: 0.05,
      actualBaseCost: 0,
    });
  });

  test("throw at/after the settle reconcile (incl. from INSIDE it — movement may have committed) → NO refund (no double-credit)", async () => {
    const credits = makeCredits();
    const result = await reconcileChatSettleError(
      nonStreamingSiteParams(true),
      credits,
    );
    expect(result.refunded).toBe(false);
    expect(credits.reconcileCredits).not.toHaveBeenCalled();
  });

  test("the refund is tagged non-streaming (streaming:false) so it's distinguishable in the ledger", async () => {
    const credits = makeCredits();
    await reconcileChatSettleError(nonStreamingSiteParams(false), credits);
    expect(credits.calls[0].metadata).toMatchObject({
      streaming: false,
      refundReason: "non_streaming_settle_error",
    });
  });
});

describe("reconcileChatSettleError — shared contract", () => {
  test("both sites route through the ONE helper: skipRefund decides, the ledger tags stay per-site", async () => {
    const credits = makeCredits();
    const [streamKept, streamRefunded, settleKept, settleRefunded] =
      await Promise.all([
        reconcileChatSettleError(streamingSiteParams(true), credits),
        reconcileChatSettleError(streamingSiteParams(false), credits),
        reconcileChatSettleError(nonStreamingSiteParams(true), credits),
        reconcileChatSettleError(nonStreamingSiteParams(false), credits),
      ]);

    // skipRefund=true keeps the charge on BOTH sites; skipRefund=false
    // refunds the full hold on BOTH sites.
    expect(streamKept.refunded).toBe(false);
    expect(settleKept.refunded).toBe(false);
    expect(streamRefunded.refunded).toBe(true);
    expect(settleRefunded.refunded).toBe(true);
    expect(credits.reconcileCredits).toHaveBeenCalledTimes(2);
    expect(credits.calls.every((c) => c.actualBaseCost === 0)).toBe(true);

    // Each refund carries its own site's ledger identity.
    const streaming = credits.calls.find((c) => c.metadata?.streaming === true);
    const nonStreaming = credits.calls.find(
      (c) => c.metadata?.streaming === false,
    );
    expect(streaming?.description).toBe("Refund due to stream error");
    expect(nonStreaming?.description).toBe(
      "Chat refund (non-streaming settle failed): openai/gpt-oss-120b",
    );
    expect(nonStreaming?.metadata).toMatchObject({
      refundReason: "non_streaming_settle_error",
    });
  });
});
