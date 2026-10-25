/**
 * Joins a locally verified NVIDIA GPU attestation to CPU TEE evidence. This is
 * the only way `gpuProtected` / `gpuFirmware` survive evidence normalization:
 * the policy evaluator keeps GPU claims solely on objects branded here, and
 * branding requires a result produced by `NvidiaGpuAttestationVerifier` in
 * this process and bound to the same request nonce as the CPU evidence.
 */
import type { TeeEvidence } from "./tee-evidence.ts";
import {
  gpuClaimsFromVerifiedNvidiaAttestation,
  type NvidiaGpuVerifiedClaims,
} from "./tee-gpu-nvidia.ts";

const gpuVerifiedEvidence = new WeakSet<object>();

/** Merge verified GPU claims into CPU evidence and brand the result. */
export function attachVerifiedNvidiaGpuAttestation(
  evidence: TeeEvidence,
  verified: NvidiaGpuVerifiedClaims,
  nonce: string,
): TeeEvidence {
  const gpu = gpuClaimsFromVerifiedNvidiaAttestation(verified, nonce);
  const merged: TeeEvidence = {
    ...evidence,
    claims: { ...evidence.claims, ...gpu.claims },
    measurements: { ...evidence.measurements, ...gpu.measurements },
    raw: {
      cpu: evidence.raw,
      gpu: {
        verifier: gpu.freshness.verifier,
        verifiedAt: gpu.freshness.timestamp,
        nonce: gpu.freshness.nonce,
        architecture: verified.architecture,
        gpus: verified.gpus,
      },
    },
  };
  gpuVerifiedEvidence.add(merged);
  return merged;
}

/** True only for evidence branded by {@link attachVerifiedNvidiaGpuAttestation}. */
export function isGpuVerifiedEvidence(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    gpuVerifiedEvidence.has(value)
  );
}

/** Keep the brand on a normalized copy of branded evidence. */
export function carryGpuVerification(
  source: unknown,
  normalized: TeeEvidence,
): TeeEvidence {
  if (isGpuVerifiedEvidence(source)) gpuVerifiedEvidence.add(normalized);
  return normalized;
}
