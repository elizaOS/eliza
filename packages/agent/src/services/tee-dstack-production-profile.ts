/**
 * Admits a dstack CVM using the pinned verifier's supported claims and
 * deployment identity. When the signed configuration declares NVIDIA GPUs, the
 * profile also requires the dstack TDX cloud-inference floor
 * (`DSTACK_TDX_CLOUD_CLAIMS`) and, when the GPU fleet is fully pinned, its
 * `gpuFirmware` digest. GPU trust can only come from
 * the provider's verified NVIDIA attestation, never from this profile.
 */
import { ElizaError } from "@elizaos/core";
import { resolveDstackEvidenceConfiguration } from "./tee-dstack-release.ts";
import { teeMeasurementDigestMatches } from "./tee-evidence.ts";
import { nvidiaGpuFirmwareDigest } from "./tee-gpu-nvidia.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";
import {
  mergeTeeProductionProfile,
  TEE_PRODUCTION_MAX_AGE_MS,
} from "./tee-production-profile.ts";

type GpuPolicyPins = {
  allowedDriverVersions?: string[];
  allowedVbiosVersions?: string[];
  allowedHwModels?: string[];
  expectedGpuCount?: number;
};

/** Golden `gpuFirmware` digest when driver, VBIOS, model and count are each pinned to one value. */
function pinnedGpuFirmware(policy: GpuPolicyPins): string | undefined {
  const [driver, ...moreDrivers] = policy.allowedDriverVersions ?? [];
  const [vbios, ...moreVbios] = policy.allowedVbiosVersions ?? [];
  const [model, ...moreModels] = policy.allowedHwModels ?? [];
  const count = policy.expectedGpuCount;
  if (
    !driver ||
    !vbios ||
    !model ||
    count === undefined ||
    moreDrivers.length + moreVbios.length + moreModels.length > 0
  )
    return undefined;
  return nvidiaGpuFirmwareDigest(
    Array.from({ length: count }, () => ({
      hwModel: model,
      driverVersion: driver,
      vbiosVersion: vbios,
    })),
  );
}

/** Intersects pinned deployment identity with every stricter caller constraint. */
export function mergeDstackCpuProductionProfile(
  policy: TeeEvidencePolicy | undefined,
  env: Record<string, string | undefined>,
): TeeEvidencePolicy {
  try {
    const config = resolveDstackEvidenceConfiguration(env);
    const base = policy ?? {};
    const kind = config.variant === "dstack-tdx" ? "tdx" : "nitro";
    const gpuFirmware = config.gpu
      ? pinnedGpuFirmware(config.gpu.policy)
      : undefined;
    const pinned: Record<string, string> = {
      app: config.appId,
      compose: config.composeHash,
      os: config.osImageHash,
      ...(gpuFirmware === undefined ? {} : { gpuFirmware }),
    };
    for (const name of Object.keys(pinned)) {
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
    const merged: TeeEvidencePolicy = {
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
    if (!config.gpu) return merged;
    if (config.variant !== "dstack-tdx")
      throw new Error("GPU attestation is supported only on dstack TDX");
    // A GPU deployment is held to the dstack TDX cloud-inference floor.
    return mergeTeeProductionProfile(merged, {
      inference: "cloud",
      platform: "dstack-tdx",
    });
  } catch (error) {
    // error-policy:J2 Reject a missing or conflicting production admission policy.
    throw new ElizaError("Invalid dstack CPU production profile", {
      code: "TEE_DSTACK_PROFILE_INVALID",
      cause: error,
    });
  }
}
