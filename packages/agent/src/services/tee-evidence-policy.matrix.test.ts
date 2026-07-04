/**
 * Exhaustive decision matrix for evaluateTeeEvidencePolicy: a table of golden
 * evidence/policy fixtures asserts each reason in the TeeEvidencePolicyDecision
 * union (allowed, staleness, nonce, kind/provider/measurement/claim/version
 * mismatch and revocation, simulated-evidence rejection, ...) and that every
 * union member is covered. Deterministic — fixed clock and in-memory fixtures.
 */
import { describe, expect, it } from "vitest";
import type { TeeEvidence } from "./tee-evidence.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
  type TeeEvidencePolicyDecision,
} from "./tee-policy.ts";

const NOW = Date.parse("2026-05-20T12:00:00.000Z");

const golden: TeeEvidence = {
  kind: "tdx",
  provider: "dstack",
  hardwareVendor: "intel",
  securityVersion: 7,
  measurements: {
    boot: "sha256:b00t",
    os: "sha256:0505",
    agent: "sha256:a9e7",
    policy: "sha256:9011c4",
    modelWeights: "sha256:we1607",
  },
  freshness: {
    nonce: "issued-nonce",
    timestamp: "2026-05-20T12:00:00.000Z",
    verifier: "intel-pcs",
  },
  claims: {
    debugDisabled: true,
    secureBoot: true,
    memoryEncrypted: true,
    ioProtected: true,
    productionLifecycle: true,
    npuProtected: true,
  },
};

const goldenPolicy: TeeEvidencePolicy = {
  required: true,
  allowedKinds: ["tdx"],
  allowedProviders: ["dstack"],
  minSecurityVersion: 7,
  expectedNonce: "issued-nonce",
  maxAgeMs: 60_000,
  nowMs: NOW + 5_000,
  requiredMeasurements: {
    agent: "sha256:a9e7",
    policy: "sha256:9011c4",
    modelWeights: "sha256:we1607",
  },
  requiredClaims: {
    debugDisabled: true,
    npuProtected: true,
  },
};

type Case = {
  reason: TeeEvidencePolicyDecision["reason"];
  evidence: unknown;
  policy: TeeEvidencePolicy | undefined;
  trusted: boolean;
};

const cases: Case[] = [
  { reason: "no-policy", evidence: golden, policy: undefined, trusted: true },
  {
    reason: "not-required",
    evidence: undefined,
    policy: { required: false },
    trusted: true,
  },
  { reason: "allowed", evidence: golden, policy: goldenPolicy, trusted: true },
  {
    reason: "missing-evidence",
    evidence: undefined,
    policy: { required: true },
    trusted: false,
  },
  {
    reason: "invalid-evidence",
    evidence: { provider: "dstack" },
    policy: { required: true },
    trusted: false,
  },
  {
    reason: "simulated-evidence-rejected",
    evidence: { ...golden, hardwareVendor: "mock-macos" },
    policy: { ...goldenPolicy, rejectSimulatedEvidence: true },
    trusted: false,
  },
  {
    reason: "kind-not-allowed",
    evidence: { ...golden, kind: "sev-snp" },
    policy: goldenPolicy,
    trusted: false,
  },
  {
    reason: "provider-not-allowed",
    evidence: { ...golden, provider: "rogue" },
    policy: goldenPolicy,
    trusted: false,
  },
  {
    reason: "measurement-mismatch",
    evidence: {
      ...golden,
      measurements: { ...golden.measurements, agent: "sha256:tampered" },
    },
    policy: goldenPolicy,
    trusted: false,
  },
  {
    reason: "measurement-revoked",
    evidence: golden,
    policy: {
      ...goldenPolicy,
      revokedMeasurements: { agent: ["sha256:a9e7"] },
    },
    trusted: false,
  },
  {
    reason: "security-version-too-low",
    evidence: { ...golden, securityVersion: 3 },
    policy: goldenPolicy,
    trusted: false,
  },
  {
    reason: "security-version-revoked",
    evidence: golden,
    policy: { ...goldenPolicy, revokedSecurityVersions: [7] },
    trusted: false,
  },
  {
    reason: "missing-nonce",
    evidence: {
      ...golden,
      freshness: { timestamp: golden.freshness?.timestamp },
    },
    policy: goldenPolicy,
    trusted: false,
  },
  {
    reason: "nonce-mismatch",
    evidence: {
      ...golden,
      freshness: { ...golden.freshness, nonce: "different-nonce" },
    },
    policy: goldenPolicy,
    trusted: false,
  },
  {
    reason: "missing-timestamp",
    evidence: { ...golden, freshness: { nonce: "issued-nonce" } },
    policy: goldenPolicy,
    trusted: false,
  },
  {
    reason: "timestamp-invalid",
    evidence: {
      ...golden,
      freshness: { ...golden.freshness, timestamp: "not-a-date" },
    },
    policy: goldenPolicy,
    trusted: false,
  },
  {
    reason: "timestamp-stale",
    evidence: golden,
    policy: { ...goldenPolicy, nowMs: NOW + 10 * 60_000 },
    trusted: false,
  },
  {
    reason: "claim-mismatch",
    evidence: {
      ...golden,
      claims: { ...golden.claims, npuProtected: false },
    },
    policy: goldenPolicy,
    trusted: false,
  },
];

describe("TEE evidence policy decision matrix", () => {
  for (const testCase of cases) {
    it(`yields reason "${testCase.reason}"`, () => {
      const decision = evaluateTeeEvidencePolicy(
        testCase.evidence,
        testCase.policy,
      );
      expect(decision.reason).toBe(testCase.reason);
      expect(decision.trusted).toBe(testCase.trusted);
    });
  }

  it("covers every reason in the decision union", () => {
    const allReasons: TeeEvidencePolicyDecision["reason"][] = [
      "no-policy",
      "not-required",
      "allowed",
      "missing-evidence",
      "invalid-evidence",
      "simulated-evidence-rejected",
      "kind-not-allowed",
      "provider-not-allowed",
      "measurement-mismatch",
      "measurement-revoked",
      "security-version-too-low",
      "security-version-revoked",
      "missing-nonce",
      "nonce-mismatch",
      "missing-timestamp",
      "timestamp-invalid",
      "timestamp-stale",
      "claim-mismatch",
    ];
    const covered = new Set(cases.map((testCase) => testCase.reason));
    expect([...covered].sort()).toEqual([...allReasons].sort());
  });
});
