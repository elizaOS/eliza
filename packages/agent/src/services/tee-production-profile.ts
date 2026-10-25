/**
 * The non-negotiable production floor for confidential-AI TEE trust: the claim
 * set, simulated-evidence rejection, and freshness ceiling a deployment cannot
 * accidentally relax. `mergeTeeProductionProfile` intersects it into the
 * resolved boot policy, only ever tightening. The evidence provider owns quote
 * verification; this profile alone cannot establish hardware trust.
 */
import type { TeeClaims } from "./tee-evidence.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";

/**
 * Non-negotiable production floor for confidential-AI TEE trust.
 *
 * This profile exists so a caller cannot accidentally accept developer-mode,
 * debug, or stale evidence in production by forgetting to set a claim. It is
 * intersected with the resolved runtime policy at boot (see
 * {@link mergeTeeProductionProfile}); the intersection only ever tightens the
 * policy — it never relaxes a stricter caller setting.
 *
 * It cannot assert hardware trust on its own: the evidence provider must verify
 * quote signatures and platform appraisal. Rejecting self-declared development
 * markers is an additional check, never a substitute for that verification.
 */
export const TEE_PRODUCTION_MAX_AGE_MS = 300_000;

/**
 * Base local-in-TEE production claims. Every claim here MUST be present and
 * true on the evidence or `evaluateTeeEvidencePolicy` fails closed.
 */
const PRODUCTION_BASE_CLAIMS: Required<
  Pick<
    TeeClaims,
    | "debugDisabled"
    | "secureBoot"
    | "memoryEncrypted"
    | "ioProtected"
    | "productionLifecycle"
  >
> = {
  debugDisabled: true,
  secureBoot: true,
  memoryEncrypted: true,
  ioProtected: true,
  productionLifecycle: true,
};

export type TeeProductionProfileOptions = {
  /**
   * Topology of the inference path. `local` requires the NPU confidential-I/O
   * claim; `cloud` requires the H100 confidential-GPU claim. Defaults to
   * `local` (the device's default deployment shape).
   */
  inference?: "local" | "cloud";
  /**
   * `dstack-tdx`: a dstack Intel TDX CVM with NVIDIA CC GPUs (cloud only).
   * See {@link DSTACK_TDX_CLOUD_CLAIMS} for how its floor differs.
   */
  platform?: "generic" | "dstack-tdx";
};

/**
 * Cloud-inference floor for a dstack TDX CVM with NVIDIA CC GPUs: exactly the
 * claims its verified evidence establishes. secureBoot is replaced by the
 * pinned measured-boot OS image (`os` measurement, required by the merge).
 * ioProtected is omitted: NRAS claims 3.0 carries no claim stating GPU CC mode
 * or protected PCIe, so no verified source establishes it; CPU-GPU traffic
 * protection rests on the verified GPU attestation (`gpuProtected`).
 */
export const DSTACK_TDX_CLOUD_CLAIMS: Required<
  Pick<
    TeeClaims,
    "debugDisabled" | "memoryEncrypted" | "productionLifecycle" | "gpuProtected"
  >
> = {
  debugDisabled: true,
  memoryEncrypted: true,
  productionLifecycle: true,
  gpuProtected: true,
};

export type TeeProductionProfile = Required<
  Pick<
    TeeEvidencePolicy,
    "required" | "requiredClaims" | "rejectSimulatedEvidence"
  >
> &
  Pick<TeeEvidencePolicy, "maxAgeMs">;

export function teeProductionProfile(
  options: TeeProductionProfileOptions = {},
): TeeProductionProfile {
  const inference = options.inference ?? "local";
  if (options.platform === "dstack-tdx") {
    if (inference !== "cloud")
      throw new Error(
        "dstack TDX production profile supports cloud inference only.",
      );
    return {
      required: true,
      rejectSimulatedEvidence: true,
      requiredClaims: { ...DSTACK_TDX_CLOUD_CLAIMS },
      maxAgeMs: TEE_PRODUCTION_MAX_AGE_MS,
    };
  }
  return {
    required: true,
    rejectSimulatedEvidence: true,
    requiredClaims: {
      ...PRODUCTION_BASE_CLAIMS,
      ...(inference === "local"
        ? { npuProtected: true }
        : { gpuProtected: true }),
    },
    maxAgeMs: TEE_PRODUCTION_MAX_AGE_MS,
  };
}

/**
 * Intersect the production profile into a resolved policy. The merge only
 * tightens: the profile's required claims are unioned in, `required` and
 * `rejectSimulatedEvidence` are forced on, and `maxAgeMs` is clamped to the
 * smaller (stricter) of the caller's value and the production ceiling.
 */
export function mergeTeeProductionProfile(
  policy: TeeEvidencePolicy | undefined,
  options: TeeProductionProfileOptions = {},
): TeeEvidencePolicy {
  const profile = teeProductionProfile(options);
  const base = policy ?? {};
  if (
    options.platform === "dstack-tdx" &&
    !base.requiredMeasurements?.os?.trim()
  ) {
    // Measured boot stands in for secureBoot only when the OS image is pinned.
    throw new Error(
      "dstack TDX cloud profile requires a pinned `os` (measured-boot image) measurement.",
    );
  }
  const callerMaxAge = base.maxAgeMs;
  return {
    ...base,
    required: true,
    rejectSimulatedEvidence: true,
    requiredClaims: {
      ...(base.requiredClaims ?? {}),
      ...profile.requiredClaims,
    },
    maxAgeMs:
      callerMaxAge === undefined
        ? profile.maxAgeMs
        : Math.min(callerMaxAge, TEE_PRODUCTION_MAX_AGE_MS),
  };
}
