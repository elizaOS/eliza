/** Primary-only policy reads; split admission Workers use the private API capability. */
import type {
  InferenceBudgetPolicy,
  InferencePolicyMutationObservation,
} from "./inference-policy-contract";

export async function loadAdmissionPolicy(organizationId: string): Promise<InferenceBudgetPolicy> {
  const [{ runWithDbCacheAsync }, { loadInferenceBudgetPolicy }] = await Promise.all([
    import("../../db/client"),
    import("./inference-funded-budget-admission"),
  ]);
  return runWithDbCacheAsync(() => loadInferenceBudgetPolicy(organizationId));
}

export async function inspectAdmissionPolicyMutation(
  organizationId: string,
  mutationId: string,
): Promise<InferencePolicyMutationObservation> {
  const [{ runWithDbCacheAsync }, { inspectInferencePolicyMutation }] = await Promise.all([
    import("../../db/client"),
    import("./inference-policy-fence"),
  ]);
  return runWithDbCacheAsync(() => inspectInferencePolicyMutation(organizationId, mutationId));
}
