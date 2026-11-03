import { expect, test } from "bun:test";
import { withCanonicalSettlementReceipt } from "/workspace/packages/cloud/shared/src/lib/services/inference-settlement-receipt.ts";
import type { OrganizationInferenceAdmission } from "/workspace/packages/cloud/shared/src/lib/services/organization-inference-admission.ts";

test("non-speech receipt decoration preserves every canonical call and economic result", async () => {
  const modes: OrganizationInferenceAdmission["mode"][] = [
    "durable_object_debit", "durable_object_affiliate_debit", "durable_object_subscription_funding",
    "synchronous_db_ledger", "synchronous_kv_ledger", "synchronous_reservation", "durable_object_funded_budget",
  ];
  let observations = 0;
  for (const mode of modes) for (const amount of [0, 0.000001, 0.0036, 1]) for (const outcome of ["collected", "null-claim", "uncollected", "wrong-target"] as const) {
    const trace: number[] = [];
    const result = outcome === "null-claim" ? null : {
      reservedAmount: outcome === "uncollected" ? 0 : amount,
      actualCost: outcome === "wrong-target" ? amount + 1 : amount,
      collectedAmount: outcome === "uncollected" ? 0 : amount,
      settlementTransactionIds: amount > 0 && outcome !== "uncollected" ? ["fake-canonical-effect"] : [],
      adjustmentType: outcome === "uncollected" ? "uncollected_overage" as const : "none" as const,
    };
    const original = structuredClone(result);
    const settleUnknown = async () => result;
    const markProviderDispatched = async () => {};
    const admission = { mode, settle: async (value: number) => { trace.push(value); return result; }, settleUnknown, markProviderDispatched };
    const wrapped = withCanonicalSettlementReceipt(admission, { organizationId: "fake-owned-org", requestId: "non-speech-owned-request" });
    const decorated = await wrapped.settle(amount);
    expect(trace).toEqual([amount]);
    expect(wrapped.settleUnknown).toBe(settleUnknown);
    expect(wrapped.markProviderDispatched).toBe(markProviderDispatched);
    expect(result).toEqual(original);
    if (decorated) {
      const { terminalReceipt, ...economicResult } = decorated;
      expect(economicResult).toEqual(original);
      expect(Boolean(terminalReceipt)).toBe(outcome === "collected" && mode !== "durable_object_funded_budget");
    } else expect(original).toBeNull();
    observations++;
  }
  expect(observations).toBe(112);
});
