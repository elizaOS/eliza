/** Private recovery capability; accounting stays on the original API environment. */
import { WorkerEntrypoint } from "cloudflare:workers";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import type { InferenceBalanceFence } from "@elizaos/cloud-shared/lib/services/credits";
import type { InferenceAdmissionRecoveryContext } from "@elizaos/cloud-shared/lib/services/inference-admission-recovery";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import {
  validId,
  validRecoveryContext,
  validRequestId,
} from "./inference-admission-gate";

export class InferenceRecoveryService extends WorkerEntrypoint<
  AppEnv["Bindings"]
> {
  async recover(
    context: InferenceAdmissionRecoveryContext,
    estimatedCostUsd: number,
    options: { inferenceBalanceFence?: InferenceBalanceFence },
  ) {
    if (
      !context ||
      !validId(context.organizationId) ||
      !validRequestId(context.requestId) ||
      !validRecoveryContext(
        context,
        context.requestId,
        context.organizationId,
      ) ||
      !Number.isFinite(estimatedCostUsd) ||
      estimatedCostUsd <= 0 ||
      (context.kind === "organization" &&
        (typeof options?.inferenceBalanceFence?.lowerCommittedBalance !==
          "function" ||
          typeof options?.inferenceBalanceFence?.publishAuthoritativeBalance !==
            "function"))
    ) {
      throw new Error("Invalid inference recovery capability request");
    }
    return runWithCloudBindingsAsync(
      this.env as Record<string, unknown>,
      async () => {
        const [
          { runWithDbCacheAsync },
          { recoverExpiredInferenceAdmissionLease },
        ] = await Promise.all([
          import("@elizaos/cloud-shared/db/client"),
          import(
            "@elizaos/cloud-shared/lib/services/inference-admission-recovery"
          ),
        ]);
        return runWithDbCacheAsync(() =>
          recoverExpiredInferenceAdmissionLease(
            context,
            estimatedCostUsd,
            options,
          ),
        );
      },
    );
  }
}
