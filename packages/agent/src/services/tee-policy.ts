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
  /**
   * When true the policy rejects evidence that self-identifies as a
   * developer-mode, simulated, or otherwise non-production attestation
   * (mock hardware vendor, `simulated`/`debug` quote markers, mock kinds).
   * The production profile sets this so a caller cannot accept DevMode
   * evidence by forgetting a claim. Defends against dstack #608 (DevMode
   * allow-all) on the agent side.
   */
  rejectSimulatedEvidence?: boolean;
};

export type TeeEvidencePolicyDecision = {
  trusted: boolean;
  reason:
    | "no-policy"
    | "not-required"
    | "allowed"
    | "missing-evidence"
    | "invalid-evidence"
    | "simulated-evidence-rejected"
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

  if (policy.rejectSimulatedEvidence) {
    const simulated = detectSimulatedEvidence(evidence);
    if (simulated !== undefined) {
      return {
        trusted: false,
        reason: "simulated-evidence-rejected",
        detail: simulated,
        evidence,
      };
    }
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

/**
 * Detect evidence that self-identifies as a developer-mode, simulated, or
 * mock attestation. Returns a human-readable detail string when the evidence
 * must be rejected, or `undefined` when nothing simulated was found.
 *
 * This is an agent-side compensating control against dstack #608 (DevMode
 * allow-all) and #609 (KMS attestation bypass): even when an upstream KMS or
 * provider would accept a DevMode quote, the agent refuses it under the
 * production profile. It does NOT replace real quote-signature verification
 * (BLOCKED on TDX/CoVE hardware) — it only rejects self-declared non-prod
 * markers. Absence of these markers is not evidence of a genuine quote.
 */
function detectSimulatedEvidence(evidence: TeeEvidence): string | undefined {
  const kind = evidence.kind.toLowerCase();
  if (
    kind === "none" ||
    kind.includes("mock") ||
    kind.includes("sim") ||
    kind.includes("fake") ||
    kind.includes("debug")
  ) {
    return `TEE kind "${evidence.kind}" indicates a non-production attestation.`;
  }

  const vendor = evidence.hardwareVendor?.toLowerCase();
  if (
    vendor !== undefined &&
    (vendor.startsWith("mock") || vendor.includes("sim"))
  ) {
    return `TEE hardwareVendor "${evidence.hardwareVendor}" indicates a non-production attestation.`;
  }

  const provider = evidence.provider?.toLowerCase();
  if (
    provider !== undefined &&
    (provider.includes("mock") ||
      provider.includes("sim") ||
      provider.includes("fake"))
  ) {
    return `TEE provider "${evidence.provider}" indicates a non-production attestation.`;
  }

  const quote = evidence.quote?.toLowerCase();
  if (
    quote !== undefined &&
    (quote.includes("simulated") ||
      quote.includes("mock") ||
      quote.includes("fake") ||
      quote.includes("debug") ||
      quote.includes("devmode"))
  ) {
    return "TEE quote is marked simulated/debug/devmode.";
  }

  const verifier = evidence.freshness?.verifier?.toLowerCase();
  if (verifier !== undefined && isSimulatedVerifier(verifier)) {
    return `TEE verifier "${evidence.freshness?.verifier}" indicates a non-production attestation.`;
  }

  return undefined;
}

/**
 * Match genuinely-simulated verifier markers WITHOUT rejecting the legitimate
 * on-device `eliza-local-verifier`. The real CoVE on-device verifier is "local"
 * by design (self-rooted in the device RoT, no cloud QE), so a blanket
 * `includes("local")` would block the real product path. We instead reject the
 * specific dev/mock/smoke markers a simulated verifier carries.
 */
function isSimulatedVerifier(verifier: string): boolean {
  if (verifier === "eliza-local-verifier") return false;
  return (
    verifier.includes("local-smoke") ||
    verifier.includes("localsim") ||
    verifier.includes("mock") ||
    verifier.includes("sim") ||
    verifier.includes("fake") ||
    verifier.includes("devmode") ||
    verifier.includes("debug")
  );
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
