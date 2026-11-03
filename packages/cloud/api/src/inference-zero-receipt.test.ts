import { expect, test } from "bun:test";
import { withCanonicalSettlementReceipt } from "@elizaos/cloud-shared/lib/services/inference-settlement-receipt";
import type { OrganizationInferenceAdmission } from "@elizaos/cloud-shared/lib/services/organization-inference-admission";

// This tests the real receipt constructor/validator with a controlled admission
// result port. It does not prove public organization admission, actual payment,
// or the private attachInferenceAdmissionLease observer consumer.
function resultPort(): OrganizationInferenceAdmission {
  return { mode: "durable_object_debit",
    settle: async () => ({ reservedAmount: 0, actualCost: 0, collectedAmount: 0,
      settlementTransactionIds: [], adjustmentType: "none" }),
    settleUnknown: async () => { throw new Error("No unknown settlement expected"); },
  };
}
const context = { organizationId: "zero-owner", requestId: "speech:zero-proof:tts" };

test("the actual receipt helper binds its zero receipt to exact owner request mode and status", async () => {
  const result = await withCanonicalSettlementReceipt(resultPort(), context).settle(0);
  expect(result?.terminalReceipt).toEqual({ version: 1, status: "canonical_completed",
    organizationId: context.organizationId, requestId: context.requestId,
    amountUsd: "0.000000", mode: "durable_object_debit" });
});

test.each([
  ["organizationId", "another-org"], ["requestId", "speech:another:tts"],
  ["version", 2], ["status", "unknown"], ["amountUsd", "1.000000"],
  ["mode", "synchronous_db_ledger"],
])("the actual receipt helper rejects a changed %s on its own previously generated receipt", async (field, value) => {
  const port = resultPort();
  const result = await withCanonicalSettlementReceipt(port, context).settle(0);
  if (!result?.terminalReceipt) throw new Error("Expected actual helper-generated receipt");
  // Mutate actual output rather than hand-authoring a fake canonical receipt.
  Object.defineProperty(result.terminalReceipt, field, { value, enumerable: true, configurable: true });
  const replay: OrganizationInferenceAdmission = { ...port, settle: async () => result };
  await expect(withCanonicalSettlementReceipt(replay, context).settle(0)).rejects.toThrow("Canonical settlement receipt identity mismatch");
});

test("a resolved null result cannot acquire a canonical zero receipt", async () => {
  const port: OrganizationInferenceAdmission = { ...resultPort(), settle: async () => null };
  expect(await withCanonicalSettlementReceipt(port, context).settle(0)).toBeNull();
});

test("funded-budget results remain outside canonical zero-receipt authority", async () => {
  const port: OrganizationInferenceAdmission = { ...resultPort(), mode: "durable_object_funded_budget" };
  const result = await withCanonicalSettlementReceipt(port, context).settle(0);
  expect(result?.terminalReceipt).toBeUndefined();
});
