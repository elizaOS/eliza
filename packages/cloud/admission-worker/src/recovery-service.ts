/** Worker-only alias: preserve awaited accounting callbacks through private RPC. */
import { getCloudBinding } from "../../shared/src/lib/runtime/cloud-bindings";
import type { InferenceBalanceFence } from "../../shared/src/lib/services/credits";
import type {
  InferenceAdmissionRecoveryContext,
  InferenceAdmissionRecoveryResult,
} from "../../shared/src/lib/services/inference-admission-recovery";

interface RecoveryCapability {
  recover(
    context: InferenceAdmissionRecoveryContext,
    estimatedCostUsd: number,
    options: { inferenceBalanceFence?: InferenceBalanceFence },
  ): Promise<InferenceAdmissionRecoveryResult>;
}

export async function recoverExpiredInferenceAdmissionLease(
  context: InferenceAdmissionRecoveryContext,
  estimatedCostUsd: number,
  options: { inferenceBalanceFence?: InferenceBalanceFence } = {},
): Promise<InferenceAdmissionRecoveryResult> {
  const service = getCloudBinding<RecoveryCapability>(
    "INFERENCE_RECOVERY_SERVICE",
  );
  if (!service)
    throw new Error("Inference recovery service binding is unavailable");
  // Functions are RPC capabilities. Awaiting this call keeps the actor fence
  // callbacks alive until the canonical API accounting operation completes.
  return service.recover(context, estimatedCostUsd, options);
}
