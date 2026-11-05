import { expect, test } from "bun:test";
import { withCanonicalSettlementReceipt } from "./inference-settlement-receipt";
import type { OrganizationInferenceAdmission } from "./organization-inference-admission";
const context = { organizationId: "org", requestId: "speech:11111111-1111-4111-8111-111111111111:tts" };
function fixture(result: any, mode: OrganizationInferenceAdmission["mode"] = "durable_object_debit") {
  let calls = 0;
  const admission = withCanonicalSettlementReceipt({ mode, settle: async () => { calls++; return result; }, settleUnknown: async () => result }, context);
  return { admission, calls: () => calls };
}
test("exact canonical collected outcome supplies owner/request/target receipt", async () => {
  const f = fixture({ reservedAmount: 1, actualCost: 1, collectedAmount: 1, adjustmentType: "none", settlementTransactionIds: ["canonical-transaction"] });
  const result = await f.admission.settle(1);
  expect(result?.terminalReceipt).toEqual({ version: 1, organizationId: context.organizationId, requestId: context.requestId, amountUsd: "1.000000", mode: "durable_object_debit", status: "canonical_completed" });
  expect(f.calls()).toBe(1);
});
test.each([
  null,
  { reservedAmount: 1, actualCost: 1, adjustmentType: "uncollected_overage", settlementTransactionIds: [] },
  { reservedAmount: 0, actualCost: 1, collectedAmount: 0, adjustmentType: "none", settlementTransactionIds: ["wrong-collection"] },
  { reservedAmount: 1, actualCost: 2, adjustmentType: "none", settlementTransactionIds: ["wrong-target"] },
  { reservedAmount: 1, actualCost: 1, adjustmentType: "none", settlementTransactionIds: [] },
])("null sweep claims and incomplete or uncollected outcomes cannot attest terminal money: %j", async result => {
  expect((await fixture(result).admission.settle(1))?.terminalReceipt).toBeUndefined();
});
test("funded-budget completion without persistence acknowledgement stays unattested", async () => {
  const f = fixture({ reservedAmount: 1, actualCost: 1, collectedAmount: 1, adjustmentType: "none", settlementTransactionIds: ["not-a-persistence-ack"] }, "durable_object_funded_budget");
  expect((await f.admission.settle(1))?.terminalReceipt).toBeUndefined();
});
test("an explicit canonical zero result can attest zero, while null cannot", async () => {
  const result = await fixture({ reservedAmount: 0, actualCost: 0, adjustmentType: "none", settlementTransactionIds: [] }).admission.settle(0);
  expect(result?.terminalReceipt?.amountUsd).toBe("0.000000");
  expect(await fixture(null).admission.settle(0)).toBeNull();
});

test("an existing receipt cannot be rebound to another owner or request", async () => {
  const f = fixture({ reservedAmount: 1, actualCost: 1, adjustmentType: "none", settlementTransactionIds: ["canonical-transaction"],
    terminalReceipt: { version: 1, organizationId: "another-org", requestId: context.requestId, amountUsd: "1.000000", mode: "durable_object_debit", status: "canonical_completed" } });
  await expect(f.admission.settle(1)).rejects.toThrow("receipt identity mismatch");
});
