import { describe, expect, it } from "vitest";
import { evaluateTeeEvidencePolicy } from "./tee-policy.ts";

const goodEvidence = {
  kind: "dstack",
  provider: "dstack",
  securityVersion: 7,
  measurements: {
    boot: "sha256:aaaaaaaa",
    os: "bbbbbbbb",
    agent: "cccccccc",
    policy: "dddddddd",
  },
  freshness: {
    nonce: "nonce-1",
    timestamp: "2026-05-20T12:00:00.000Z",
  },
  claims: {
    debugDisabled: true,
    productionLifecycle: true,
    secureBoot: true,
    memoryEncrypted: true,
    ioProtected: true,
  },
};

describe("TEE evidence policy", () => {
  it("accepts evidence that matches kind, measurements, freshness, version, and claims", () => {
    expect(
      evaluateTeeEvidencePolicy(goodEvidence, {
        required: true,
        allowedKinds: ["dstack"],
        allowedProviders: ["dstack"],
        minSecurityVersion: 7,
        expectedNonce: "nonce-1",
        maxAgeMs: 60_000,
        nowMs: Date.parse("2026-05-20T12:00:30.000Z"),
        requiredMeasurements: {
          boot: "aaaaaaaa",
          os: "sha256:bbbbbbbb",
          agent: "cccccccc",
          policy: "dddddddd",
        },
        requiredClaims: {
          debugDisabled: true,
          productionLifecycle: true,
          secureBoot: true,
          memoryEncrypted: true,
          ioProtected: true,
        },
      }),
    ).toMatchObject({
      trusted: true,
      reason: "allowed",
      evidence: { kind: "dstack", provider: "dstack" },
    });
  });

  it("fails closed when evidence is required but missing", () => {
    expect(
      evaluateTeeEvidencePolicy(undefined, { required: true }),
    ).toMatchObject({
      trusted: false,
      reason: "missing-evidence",
    });
  });

  it("rejects stale evidence", () => {
    expect(
      evaluateTeeEvidencePolicy(goodEvidence, {
        required: true,
        maxAgeMs: 10_000,
        nowMs: Date.parse("2026-05-20T12:01:00.000Z"),
      }),
    ).toMatchObject({
      trusted: false,
      reason: "timestamp-stale",
    });
  });

  it("rejects measurement mismatches", () => {
    expect(
      evaluateTeeEvidencePolicy(goodEvidence, {
        required: true,
        requiredMeasurements: { agent: "wrong" },
      }),
    ).toMatchObject({
      trusted: false,
      reason: "measurement-mismatch",
    });
  });

  it("rejects missing required claims", () => {
    expect(
      evaluateTeeEvidencePolicy(
        {
          ...goodEvidence,
          claims: { ...goodEvidence.claims, ioProtected: false },
        },
        {
          required: true,
          requiredClaims: { ioProtected: true },
        },
      ),
    ).toMatchObject({
      trusted: false,
      reason: "claim-mismatch",
    });
  });

  it("rejects revoked measurements even when required measurements match", () => {
    expect(
      evaluateTeeEvidencePolicy(goodEvidence, {
        required: true,
        requiredMeasurements: { agent: "sha256:cccccccc" },
        revokedMeasurements: { agent: ["sha256:cccccccc"] },
      }),
    ).toMatchObject({
      trusted: false,
      reason: "measurement-revoked",
    });
  });

  it("rejects revoked security versions", () => {
    expect(
      evaluateTeeEvidencePolicy(goodEvidence, {
        required: true,
        revokedSecurityVersions: [7],
      }),
    ).toMatchObject({
      trusted: false,
      reason: "security-version-revoked",
    });
  });
});
