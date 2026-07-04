/**
 * Covers createTeeGatedRemoteSigningService: a signer wrapper that refuses to
 * construct when the TEE boot gate blocks secrets and re-attests TEE evidence on
 * every sign when a policy demands it. Deterministic harness — vi-mocked signer
 * backend and evidence provider over in-memory boot-gate state; no real TEE.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTeeGatedRemoteSigningService,
  type SignerBackend,
} from "./remote-signing-service.ts";
import type { SigningRequest } from "./signing-policy.ts";
import type { TeeBootGate } from "./tee-boot-gate.ts";
import {
  clearTeeBootGateState,
  setTeeBootGateState,
} from "./tee-boot-gate-state.ts";
import type { TeeEvidence, TeeEvidenceProvider } from "./tee-evidence.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";

const request: SigningRequest = {
  requestId: "req-1",
  chainId: 1,
  to: "0x0000000000000000000000000000000000000001",
  value: "0",
  data: "0x",
  createdAt: Date.now(),
};

const blockingGate: TeeBootGate = {
  policy: undefined,
  teeConfigured: true,
  required: true,
  productionProfile: false,
  secretsEnabled: false,
};

function trustedEvidence(): TeeEvidence {
  return {
    kind: "dstack",
    measurements: { agent: "abc" },
    claims: { debugDisabled: true },
  };
}

function signerBackend(): SignerBackend & {
  signTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: vi.fn(async () => "0xsigner"),
    signMessage: vi.fn(async () => "signed-message"),
    signTransaction: vi.fn(async () => "signed-tx"),
  };
}

function evidenceProvider(
  collect: () => Promise<TeeEvidence>,
): TeeEvidenceProvider & { collectEvidence: ReturnType<typeof vi.fn> } {
  return { id: "test", collectEvidence: vi.fn(collect) };
}

const attestingPolicy: TeeEvidencePolicy = {
  required: true,
  allowedKinds: ["dstack"],
  requiredMeasurements: { agent: "abc" },
  requiredClaims: { debugDisabled: true },
};

describe("createTeeGatedRemoteSigningService", () => {
  afterEach(() => {
    clearTeeBootGateState();
    vi.restoreAllMocks();
  });

  it("refuses to construct when the boot gate blocks secrets", () => {
    setTeeBootGateState(blockingGate);
    expect(() =>
      createTeeGatedRemoteSigningService({ signer: signerBackend() }),
    ).toThrow(/TEE boot gate blocks secrets/);
  });

  it("signs by delegating to the inner signer when TEE is not configured", async () => {
    const signer = signerBackend();
    const service = createTeeGatedRemoteSigningService({ signer });

    const result = await service.submitSigningRequest(request);

    expect(result.success).toBe(true);
    expect(result.signature).toBe("signed-tx");
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("re-attests on every sign when the policy requires TEE evidence", async () => {
    const signer = signerBackend();
    const provider = evidenceProvider(async () => trustedEvidence());
    const service = createTeeGatedRemoteSigningService({
      signer,
      teePolicy: attestingPolicy,
      evidenceProvider: provider,
    });

    await service.submitSigningRequest({ ...request, requestId: "req-a" });
    await service.submitSigningRequest({ ...request, requestId: "req-b" });

    // Evidence collected once per sign — proves per-sign re-attestation.
    expect(provider.collectEvidence).toHaveBeenCalledTimes(2);
    expect(signer.signTransaction).toHaveBeenCalledTimes(2);
  });

  it("rejects the sign (inner signer untouched) when per-sign evidence fails policy", async () => {
    const signer = signerBackend();
    const provider = evidenceProvider(async () => ({
      kind: "dstack",
      measurements: { agent: "wrong" },
      claims: { debugDisabled: true },
    }));
    const service = createTeeGatedRemoteSigningService({
      signer,
      teePolicy: attestingPolicy,
      evidenceProvider: provider,
    });

    const result = await service.submitSigningRequest(request);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/TEE signing policy rejected evidence/);
    expect(provider.collectEvidence).toHaveBeenCalledTimes(1);
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  it("requires an evidence provider when the policy demands attestation", () => {
    expect(() =>
      createTeeGatedRemoteSigningService({
        signer: signerBackend(),
        teePolicy: attestingPolicy,
      }),
    ).toThrow(/no evidenceProvider/);
  });
});
