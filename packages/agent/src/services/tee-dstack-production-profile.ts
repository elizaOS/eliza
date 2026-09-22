/**
 * Admits a CPU-only dstack CVM using the pinned verifier's supported claims and
 * deployment identity. Accelerator/inference admission is a separate boundary;
 * this profile cannot authorize an inference destination or assert GPU trust.
 */
import { ElizaError } from "@elizaos/core";
import { dstackEvidenceConfiguration } from "./tee-dstack-evidence.ts";
import { teeMeasurementDigestMatches } from "./tee-evidence.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";
import { TEE_PRODUCTION_MAX_AGE_MS } from "./tee-production-profile.ts";

/** Intersects pinned deployment identity with every stricter caller constraint. */
export function mergeDstackCpuProductionProfile(
  policy: TeeEvidencePolicy | undefined,
  configuration: string | undefined,
): TeeEvidencePolicy {
  try {
    if (configuration === undefined)
      throw new Error("Missing dstack configuration");
    const config = dstackEvidenceConfiguration.parse(JSON.parse(configuration));
    const base = policy ?? {};
    const kind = config.variant === "dstack-tdx" ? "tdx" : "nitro";
    const pinned = { compose: config.composeHash, os: config.osImageHash };
    for (const name of ["compose", "os"] as const) {
      const existing = base.requiredMeasurements?.[name];
      if (
        existing !== undefined &&
        !teeMeasurementDigestMatches(existing, pinned[name])
      ) {
        throw new Error(
          "Caller policy conflicts with pinned deployment measurements",
        );
      }
    }
    return {
      ...base,
      required: true,
      allowedKinds: base.allowedKinds?.includes(kind) === false ? [] : [kind],
      allowedProviders:
        base.allowedProviders?.includes("dstack") === false ? [] : ["dstack"],
      requiredMeasurements: { ...base.requiredMeasurements, ...pinned },
      requiredClaims: { ...base.requiredClaims, debugDisabled: true },
      rejectSimulatedEvidence: true,
      maxAgeMs: Math.min(
        base.maxAgeMs ?? TEE_PRODUCTION_MAX_AGE_MS,
        TEE_PRODUCTION_MAX_AGE_MS,
      ),
    };
  } catch (error) {
    // error-policy:J2 Reject a missing or conflicting production admission policy.
    throw new ElizaError("Invalid dstack CPU production profile", {
      code: "TEE_DSTACK_PROFILE_INVALID",
      cause: error,
    });
  }
}
