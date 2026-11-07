/** Policy hydration stays on the same private API capability as accounting recovery. */
import { getCloudBinding } from "../../shared/src/lib/runtime/cloud-bindings";
import {
  type InferenceBudgetPolicy,
  type InferencePolicyMutationObservation,
  isInferenceBudgetPolicy,
} from "../../shared/src/lib/services/inference-policy-contract";

interface PolicyCapability {
  loadAdmissionPolicy(organizationId: string): Promise<InferenceBudgetPolicy>;
  inspectAdmissionPolicyMutation(
    organizationId: string,
    mutationId: string,
  ): Promise<InferencePolicyMutationObservation>;
}

function capability(): PolicyCapability {
  const service = getCloudBinding<PolicyCapability>(
    "INFERENCE_RECOVERY_SERVICE",
  );
  if (!service)
    throw new Error("Inference policy service binding is unavailable");
  return service;
}

export async function loadAdmissionPolicy(
  organizationId: string,
): Promise<InferenceBudgetPolicy> {
  const policy = await capability().loadAdmissionPolicy(organizationId);
  if (
    !isInferenceBudgetPolicy(policy) ||
    policy.organizationId !== organizationId
  )
    throw new Error("Inference policy service returned an invalid policy");
  return policy;
}

export async function inspectAdmissionPolicyMutation(
  organizationId: string,
  mutationId: string,
): Promise<InferencePolicyMutationObservation> {
  const result = await capability().inspectAdmissionPolicyMutation(
    organizationId,
    mutationId,
  );
  if (result?.state === "absent") return result;
  if (
    (result?.state !== "applied" && result?.state !== "complete") ||
    typeof result.fenceToken !== "string" ||
    !result.fenceToken ||
    typeof result.epoch !== "string" ||
    !/^(0|[1-9]\d*)$/.test(result.epoch)
  )
    throw new Error("Inference policy service returned an invalid mutation");
  return result;
}
