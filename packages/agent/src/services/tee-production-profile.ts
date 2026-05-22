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
 * It does NOT and cannot assert hardware trust on its own: real TDX/CoVE quote
 * signature verification is BLOCKED on hardware (plan Phase B/C). Until that
 * lands the profile rejects self-declared non-production markers
 * (`rejectSimulatedEvidence`) but the system must not claim hardware-verified
 * trust.
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
