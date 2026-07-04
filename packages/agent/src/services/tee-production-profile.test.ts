/**
 * Covers the non-negotiable TEE production floor: the `teeProductionProfile`
 * shape (required claims, simulated-evidence rejection, max-age ceiling) for
 * local vs cloud inference, and `mergeTeeProductionProfile` only ever tightening
 * a resolved policy (clamping `maxAgeMs`, forcing claims). Deterministic
 * assertions plus a few end-to-end evaluations through
 * `evaluateTeeEvidencePolicy`.
 */
import { describe, expect, it } from "vitest";
import { evaluateTeeEvidencePolicy } from "./tee-policy.ts";
import {
  mergeTeeProductionProfile,
  TEE_PRODUCTION_MAX_AGE_MS,
  teeProductionProfile,
} from "./tee-production-profile.ts";

const trustedEvidence = {
  kind: "tdx",
  provider: "dstack",
  hardwareVendor: "intel",
  securityVersion: 7,
  measurements: { agent: "sha256:aaa", policy: "sha256:bbb" },
  freshness: {
    nonce: "n1",
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

describe("TEE production profile", () => {
  it("requires the non-negotiable local claims and rejects simulated evidence", () => {
    const profile = teeProductionProfile();
    expect(profile).toMatchObject({
      required: true,
      rejectSimulatedEvidence: true,
      maxAgeMs: TEE_PRODUCTION_MAX_AGE_MS,
      requiredClaims: {
        debugDisabled: true,
        secureBoot: true,
        memoryEncrypted: true,
        ioProtected: true,
        productionLifecycle: true,
        npuProtected: true,
      },
    });
  });

  it("requires the GPU claim for cloud-routed inference", () => {
    expect(
      teeProductionProfile({ inference: "cloud" }).requiredClaims,
    ).toMatchObject({ gpuProtected: true });
  });

  it("accepts genuine production-shaped evidence", () => {
    const policy = mergeTeeProductionProfile(
      {
        allowedKinds: ["tdx"],
        requiredMeasurements: { agent: "sha256:aaa", policy: "sha256:bbb" },
        nowMs: Date.parse("2026-05-20T12:00:30.000Z"),
      },
      {},
    );
    expect(evaluateTeeEvidencePolicy(trustedEvidence, policy)).toMatchObject({
      trusted: true,
      reason: "allowed",
    });
  });

  it("rejects DevMode/mock evidence even when claims pass", () => {
    const policy = mergeTeeProductionProfile(
      { nowMs: Date.parse("2026-05-20T12:00:30.000Z") },
      {},
    );
    const devEvidence = {
      ...trustedEvidence,
      hardwareVendor: "mock-macos",
    };
    expect(evaluateTeeEvidencePolicy(devEvidence, policy)).toMatchObject({
      trusted: false,
      reason: "simulated-evidence-rejected",
    });
  });

  it("rejects a simulated quote marker", () => {
    const policy = mergeTeeProductionProfile(
      { nowMs: Date.parse("2026-05-20T12:00:30.000Z") },
      {},
    );
    expect(
      evaluateTeeEvidencePolicy(
        { ...trustedEvidence, quote: "simulated-cove-quote" },
        policy,
      ),
    ).toMatchObject({ trusted: false, reason: "simulated-evidence-rejected" });
  });

  it("rejects debug-enabled evidence under the profile", () => {
    const policy = mergeTeeProductionProfile(
      { nowMs: Date.parse("2026-05-20T12:00:30.000Z") },
      {},
    );
    expect(
      evaluateTeeEvidencePolicy(
        {
          ...trustedEvidence,
          claims: { ...trustedEvidence.claims, debugDisabled: false },
        },
        policy,
      ),
    ).toMatchObject({ trusted: false, reason: "claim-mismatch" });
  });

  it("clamps maxAgeMs to the stricter of caller and ceiling and never relaxes", () => {
    expect(mergeTeeProductionProfile({ maxAgeMs: 10_000 }, {}).maxAgeMs).toBe(
      10_000,
    );
    expect(
      mergeTeeProductionProfile({ maxAgeMs: 9_000_000 }, {}).maxAgeMs,
    ).toBe(TEE_PRODUCTION_MAX_AGE_MS);
    expect(mergeTeeProductionProfile(undefined, {}).maxAgeMs).toBe(
      TEE_PRODUCTION_MAX_AGE_MS,
    );
  });
});
