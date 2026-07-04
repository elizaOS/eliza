/**
 * Boot-gate fail-closed behavior under test: evaluateTeeBootGate maps
 * env-configured policy plus collected evidence to a single secrets-enabled
 * decision, and assertTeeBootGateAllowsSecrets throws when secrets are disabled.
 * Deterministic — evidence comes from in-memory providers, no TEE hardware.
 */
import { describe, expect, it } from "vitest";
import {
  assertTeeBootGateAllowsSecrets,
  evaluateTeeBootGate,
} from "./tee-boot-gate.ts";
import type { TeeEvidence } from "./tee-evidence.ts";

const NOW = Date.parse("2026-05-20T12:00:00.000Z");

function provider(evidence: TeeEvidence) {
  return { id: "test", collectEvidence: async () => evidence };
}

const trustedEvidence: TeeEvidence = {
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

describe("TEE boot gate", () => {
  it("enables secrets when no TEE policy is configured (local-only)", async () => {
    const gate = await evaluateTeeBootGate({ env: {} });
    expect(gate).toMatchObject({
      teeConfigured: false,
      required: false,
      secretsEnabled: true,
    });
  });

  it("enables secrets when required evidence is trusted", async () => {
    const gate = await evaluateTeeBootGate({
      env: {
        ELIZA_TEE_REQUIRED: "true",
        ELIZA_TEE_PRODUCTION_PROFILE: "true",
        ELIZA_TEE_POLICY_JSON: JSON.stringify({
          required: true,
          allowedKinds: ["tdx"],
          requiredMeasurements: { agent: "sha256:aaa", policy: "sha256:bbb" },
        }),
      },
      nowMs: NOW + 5_000,
      evidenceProvider: provider(trustedEvidence),
    });
    expect(gate.secretsEnabled).toBe(true);
    expect(gate.productionProfile).toBe(true);
    expect(gate.decision?.trusted).toBe(true);
    expect(() =>
      assertTeeBootGateAllowsSecrets(gate, "model-key"),
    ).not.toThrow();
  });

  it("fails closed when evidence is required but not trusted", async () => {
    const gate = await evaluateTeeBootGate({
      env: {
        ELIZA_TEE_REQUIRED: "true",
        ELIZA_TEE_PRODUCTION_PROFILE: "true",
      },
      nowMs: NOW + 5_000,
      evidenceProvider: provider({
        ...trustedEvidence,
        hardwareVendor: "mock",
      }),
    });
    expect(gate.secretsEnabled).toBe(false);
    expect(gate.decision?.reason).toBe("simulated-evidence-rejected");
    expect(() => assertTeeBootGateAllowsSecrets(gate, "model-key")).toThrow(
      /model-key blocked/,
    );
  });

  it("fails closed when required but no evidence provider is configured", async () => {
    const gate = await evaluateTeeBootGate({
      env: { ELIZA_TEE_REQUIRED: "true" },
    });
    expect(gate.secretsEnabled).toBe(false);
    expect(() => assertTeeBootGateAllowsSecrets(gate, "signing")).toThrow(
      /signing blocked/,
    );
  });
});
