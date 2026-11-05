import type { OrganizationInferenceAdmission, OrganizationInferenceAdmissionParams } from "./organization-inference-admission";

/** Attach an exact receipt only to a completed, collected canonical result.
 * Missing sweep claims/null and uncollected outcomes are not terminal evidence.
 * Funded-budget persistence is asynchronous and needs its own acknowledged receipt.
 */
export function withCanonicalSettlementReceipt(
  admission: OrganizationInferenceAdmission,
  context: Pick<OrganizationInferenceAdmissionParams["context"], "organizationId" | "requestId">,
): OrganizationInferenceAdmission {
  const settle = admission.settle;
  const mode = admission.mode;
  const { organizationId, requestId } = context;
  return { ...admission, settle: async amount => {
    const result = await settle.call(admission, amount);
    if (!result) return result;
    const collected = result.collectedAmount ?? result.reservedAmount;
    const authoritative = mode !== "durable_object_funded_budget" &&
      Number.isFinite(amount) && amount >= 0 && result.actualCost === amount &&
      ["none", "refund", "overage"].includes(result.adjustmentType) && Number.isFinite(collected) && collected >= amount &&
      Array.isArray(result.settlementTransactionIds) &&
      (amount === 0 || result.settlementTransactionIds.length > 0) &&
      result.settlementTransactionIds.every(id => typeof id === "string" && id.length > 0);
    const prior = result.terminalReceipt;
    if (prior) {
      if (!authoritative || prior.version !== 1 || prior.status !== "canonical_completed" ||
          prior.organizationId !== organizationId || prior.requestId !== requestId ||
          prior.amountUsd !== amount.toFixed(6) || prior.mode !== mode)
        throw Error("Canonical settlement receipt identity mismatch");
      return result;
    }
    return { ...result, terminalReceipt: authoritative ? {
      version: 1 as const, organizationId: organizationId, requestId,
      amountUsd: amount.toFixed(6), mode, status: "canonical_completed" as const,
    } : undefined };
  } };
}
