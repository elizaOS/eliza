/**
 * Evidence-provider registration seam under test: register/has/clear/resolve for
 * the deployment factory, env-option passthrough, and the boot-gate fail-closed
 * rule — a required policy with no registered provider disables secrets, while a
 * registered provider yielding trusted evidence enables them. Deterministic; the
 * factory is an in-memory stub, not a real dstack/CoVE provider.
 */
import { afterEach, describe, expect, it } from "vitest";
import { evaluateTeeBootGate } from "./tee-boot-gate.ts";
import type { TeeEvidence } from "./tee-evidence.ts";
import {
  clearTeeEvidenceProviderFactory,
  hasTeeEvidenceProviderFactory,
  registerTeeEvidenceProviderFactory,
  resolveTeeEvidenceProvider,
} from "./tee-evidence-provider.ts";

const NOW = Date.parse("2026-05-20T12:00:00.000Z");

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

const requiredEnv = {
  ELIZA_TEE_REQUIRED: "true",
  ELIZA_TEE_PRODUCTION_PROFILE: "true",
  ELIZA_TEE_POLICY_JSON: JSON.stringify({
    required: true,
    allowedKinds: ["tdx"],
    requiredMeasurements: { agent: "sha256:aaa", policy: "sha256:bbb" },
  }),
};

describe("TEE evidence-provider seam", () => {
  afterEach(() => {
    clearTeeEvidenceProviderFactory();
  });

  it("resolves undefined until a deployment registers a factory", () => {
    expect(hasTeeEvidenceProviderFactory()).toBe(false);
    expect(resolveTeeEvidenceProvider({ env: {} })).toBeUndefined();

    registerTeeEvidenceProviderFactory((options) => ({
      id: "dstack",
      collectEvidence: async () => ({
        ...trustedEvidence,
        provider: options?.env?.WHO ?? trustedEvidence.provider,
      }),
    }));

    expect(hasTeeEvidenceProviderFactory()).toBe(true);
    const provider = resolveTeeEvidenceProvider({ env: { WHO: "cvm" } });
    expect(provider?.id).toBe("dstack");
  });

  it("passes the registered provider's env-derived options through the seam", async () => {
    registerTeeEvidenceProviderFactory((options) => ({
      id: "dstack",
      collectEvidence: async () => ({
        ...trustedEvidence,
        provider: options?.env?.WHO ?? "unset",
      }),
    }));
    const provider = resolveTeeEvidenceProvider({ env: { WHO: "cvm" } });
    const evidence = await provider?.collectEvidence();
    expect(evidence?.provider).toBe("cvm");
  });

  it("boot gate stays fail-closed when a required policy has no registered provider", async () => {
    // The host boot path resolves the provider through the seam; with nothing
    // registered it is undefined, and a required policy must disable secrets.
    const evidenceProvider = resolveTeeEvidenceProvider({ env: requiredEnv });
    expect(evidenceProvider).toBeUndefined();

    const gate = await evaluateTeeBootGate({
      env: requiredEnv,
      nowMs: NOW + 5_000,
      ...(evidenceProvider ? { evidenceProvider } : {}),
    });

    expect(gate.required).toBe(true);
    expect(gate.secretsEnabled).toBe(false);
  });

  it("boot gate enables secrets when a registered provider yields trusted evidence", async () => {
    registerTeeEvidenceProviderFactory(() => ({
      id: "dstack",
      collectEvidence: async () => trustedEvidence,
    }));

    const evidenceProvider = resolveTeeEvidenceProvider({ env: requiredEnv });
    expect(evidenceProvider).toBeDefined();

    const gate = await evaluateTeeBootGate({
      env: requiredEnv,
      nowMs: NOW + 5_000,
      ...(evidenceProvider ? { evidenceProvider } : {}),
    });

    expect(gate.required).toBe(true);
    expect(gate.secretsEnabled).toBe(true);
    expect(gate.decision?.trusted).toBe(true);
  });
});
