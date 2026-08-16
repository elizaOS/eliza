/**
 * Verifies the real generative admission helper keeps long-running video work
 * on a durable credit reservation even when a Worker execution context would
 * normally select the deferred Durable Object admission path.
 */

import { afterAll, expect, mock, test } from "bun:test";
import * as aiBillingActual from "@/lib/services/ai-billing";

const reserveFlatUsageCredits = mock();
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveFlatUsageCredits,
}));

const { admitFlatGenerativeOperation } = await import(
  "../src/lib/generative-route-auth"
);

afterAll(() => {
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
});

test("video settlement mode forces a provider-specific durable reservation in Workers", async () => {
  const reconcile = mock(async () => undefined);
  reserveFlatUsageCredits.mockResolvedValue({
    reservedAmount: 0.3,
    reservationTransactionId: "22222222-2222-4222-8222-222222222222",
    affiliateAttribution: null,
    reconcile,
  });
  const waitUntil = mock();
  const context = {
    executionCtx: { waitUntil },
  } as unknown as Parameters<typeof admitFlatGenerativeOperation>[0]["c"];
  const billingContext = {
    organizationId: "00000000-0000-4000-8000-0000000000aa",
    userId: "00000000-0000-4000-8000-0000000000bb",
    apiKeyId: "key-1",
    model: "vidu/q3-turbo/text-to-video",
    provider: "vidu",
    billingSource: "atlascloud" as const,
    requestId: "generate-video:request:1",
  };
  const cost = {
    totalCost: 0.3,
    baseTotalCost: 0.25,
    platformMarkup: 0.05,
  };

  const admission = await admitFlatGenerativeOperation({
    c: context,
    context: billingContext,
    apiKeyId: "key-1",
    cost,
    idempotencyKey: billingContext.requestId,
    settlementMode: "synchronous_reservation",
  });

  expect(admission.mode).toBe("synchronous_reservation");
  expect(admission.reservation?.reservationTransactionId).toBe(
    "22222222-2222-4222-8222-222222222222",
  );
  expect(reserveFlatUsageCredits).toHaveBeenCalledWith(billingContext, cost, {
    idempotencyKey: billingContext.requestId,
  });
  expect(waitUntil).not.toHaveBeenCalled();

  await admission.settleUnknown();
  expect(reconcile).toHaveBeenCalledWith(cost.totalCost);
});
