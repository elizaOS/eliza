import {
  normalizeTeeEvidence,
  type TeeClaims,
  type TeeEvidence,
  type TeeKind,
  type TeeMeasurementName,
  teeMeasurementDigestMatches,
} from "./tee-evidence.ts";

export type TeeEvidencePolicy = {
  required?: boolean;
  allowedKinds?: TeeKind[];
  allowedProviders?: string[];
  requiredMeasurements?: Partial<Record<TeeMeasurementName, string>>;
  revokedMeasurements?: Partial<Record<TeeMeasurementName, string[]>>;
  minSecurityVersion?: number;
  revokedSecurityVersions?: number[];
  expectedNonce?: string;
  maxAgeMs?: number;
  nowMs?: number;
  requiredClaims?: Partial<Record<keyof TeeClaims, boolean>>;
};

export type TeeEvidencePolicyDecision = {
  trusted: boolean;
  reason:
    | "no-policy"
    | "not-required"
    | "allowed"
    | "missing-evidence"
    | "invalid-evidence"
    | "kind-not-allowed"
    | "provider-not-allowed"
    | "measurement-mismatch"
    | "measurement-revoked"
    | "security-version-too-low"
    | "security-version-revoked"
    | "missing-nonce"
    | "nonce-mismatch"
    | "missing-timestamp"
    | "timestamp-invalid"
    | "timestamp-stale"
    | "claim-mismatch";
  detail?: string;
  evidence?: TeeEvidence;
};

export function evaluateTeeEvidencePolicy(
  evidenceInput: unknown,
  policy: TeeEvidencePolicy | undefined,
): TeeEvidencePolicyDecision {
  if (!policy) {
    return { trusted: true, reason: "no-policy" };
  }
  if (!policy.required && evidenceInput === undefined) {
    return { trusted: true, reason: "not-required" };
  }
  if (evidenceInput === undefined) {
    return { trusted: false, reason: "missing-evidence" };
  }

  let evidence: TeeEvidence;
  try {
    evidence = normalizeTeeEvidence(evidenceInput);
  } catch (error) {
    return {
      trusted: false,
      reason: "invalid-evidence",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (
    policy.allowedKinds !== undefined &&
    !policy.allowedKinds.includes(evidence.kind)
  ) {
    return {
      trusted: false,
      reason: "kind-not-allowed",
      detail: `TEE kind "${evidence.kind}" is not allowed.`,
      evidence,
    };
  }

  if (
    policy.allowedProviders !== undefined &&
    (evidence.provider === undefined ||
      !policy.allowedProviders.includes(evidence.provider))
  ) {
    return {
      trusted: false,
      reason: "provider-not-allowed",
      detail: `TEE provider "${evidence.provider ?? "unknown"}" is not allowed.`,
      evidence,
    };
  }

  for (const [name, expected] of Object.entries(
    policy.requiredMeasurements ?? {},
  )) {
    const actual = evidence.measurements?.[name];
    if (!teeMeasurementDigestMatches(actual, expected)) {
      return {
        trusted: false,
        reason: "measurement-mismatch",
        detail: `TEE measurement "${name}" does not match policy.`,
        evidence,
      };
    }
  }

  for (const [name, revokedDigests] of Object.entries(
    policy.revokedMeasurements ?? {},
  )) {
    const actual = evidence.measurements?.[name];
    if (
      actual !== undefined &&
      revokedDigests?.some((digest) =>
        teeMeasurementDigestMatches(actual, digest),
      )
    ) {
      return {
        trusted: false,
        reason: "measurement-revoked",
        detail: `TEE measurement "${name}" has been revoked by policy.`,
        evidence,
      };
    }
  }

  if (
    policy.minSecurityVersion !== undefined &&
    (evidence.securityVersion === undefined ||
      evidence.securityVersion < policy.minSecurityVersion)
  ) {
    return {
      trusted: false,
      reason: "security-version-too-low",
      detail: `TEE security version ${
        evidence.securityVersion ?? "unknown"
      } is below ${policy.minSecurityVersion}.`,
      evidence,
    };
  }
  if (
    evidence.securityVersion !== undefined &&
    policy.revokedSecurityVersions?.includes(evidence.securityVersion)
  ) {
    return {
      trusted: false,
      reason: "security-version-revoked",
      detail: `TEE security version ${evidence.securityVersion} has been revoked by policy.`,
      evidence,
    };
  }

  const nonceDecision = evaluateNonce(evidence, policy);
  if (!nonceDecision.trusted) return nonceDecision;

  const timestampDecision = evaluateTimestamp(evidence, policy);
  if (!timestampDecision.trusted) return timestampDecision;

  for (const [claim, expected] of Object.entries(policy.requiredClaims ?? {})) {
    if (evidence.claims?.[claim as keyof TeeClaims] !== expected) {
      return {
        trusted: false,
        reason: "claim-mismatch",
        detail: `TEE claim "${claim}" does not match policy.`,
        evidence,
      };
    }
  }

  return { trusted: true, reason: "allowed", evidence };
}

function evaluateNonce(
  evidence: TeeEvidence,
  policy: TeeEvidencePolicy,
): TeeEvidencePolicyDecision {
  if (policy.expectedNonce === undefined) {
    return { trusted: true, reason: "allowed", evidence };
  }
  if (evidence.freshness?.nonce === undefined) {
    return {
      trusted: false,
      reason: "missing-nonce",
      detail: "TEE evidence does not include a freshness nonce.",
      evidence,
    };
  }
  if (evidence.freshness.nonce !== policy.expectedNonce) {
    return {
      trusted: false,
      reason: "nonce-mismatch",
      detail: "TEE evidence nonce does not match policy.",
      evidence,
    };
  }
  return { trusted: true, reason: "allowed", evidence };
}

function evaluateTimestamp(
  evidence: TeeEvidence,
  policy: TeeEvidencePolicy,
): TeeEvidencePolicyDecision {
  if (policy.maxAgeMs === undefined) {
    return { trusted: true, reason: "allowed", evidence };
  }
  const timestamp = evidence.freshness?.timestamp;
  if (timestamp === undefined) {
    return {
      trusted: false,
      reason: "missing-timestamp",
      detail: "TEE evidence does not include a freshness timestamp.",
      evidence,
    };
  }
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return {
      trusted: false,
      reason: "timestamp-invalid",
      detail: "TEE evidence timestamp is not parseable.",
      evidence,
    };
  }
  const nowMs = policy.nowMs ?? Date.now();
  if (timestampMs > nowMs + 60_000 || nowMs - timestampMs > policy.maxAgeMs) {
    return {
      trusted: false,
      reason: "timestamp-stale",
      detail: "TEE evidence timestamp is outside the allowed freshness window.",
      evidence,
    };
  }
  return { trusted: true, reason: "allowed", evidence };
}
