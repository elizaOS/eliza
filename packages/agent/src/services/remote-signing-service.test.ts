/**
 * Covers createTeeGatedRemoteSigningService: a signer wrapper that refuses to
 * construct when the TEE boot gate blocks secrets and re-attests TEE evidence on
 * every sign when a policy demands it. Deterministic harness — vi-mocked signer
 * backend and evidence provider over in-memory boot-gate state; no real TEE.
 *
 * Also covers RemoteSigningService's rate-limit reservation lifecycle
 * end-to-end (not just the underlying SigningPolicyEvaluator in isolation):
 * concurrent submissions racing for a one-slot budget, and every path that
 * must release an unconsumed reservation (rejection, expiry, sign failure).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTeeGatedRemoteSigningService,
  RemoteSigningService,
  type SignerBackend,
} from "./remote-signing-service.ts";
import {
  createDefaultPolicy,
  type SigningPolicy,
  type SigningRequest,
} from "./signing-policy.ts";
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

function ratePolicy(overrides: Partial<SigningPolicy> = {}): SigningPolicy {
  return {
    ...createDefaultPolicy(),
    maxTransactionsPerHour: 1,
    maxTransactionsPerDay: 10,
    ...overrides,
  };
}

function rateRequest(overrides: Partial<SigningRequest> = {}): SigningRequest {
  return {
    requestId: "req-1",
    chainId: 1,
    to: "0x0000000000000000000000000000000000000001",
    value: "0",
    data: "0x",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("RemoteSigningService rate-limit reservation lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("admits exactly one of two concurrent submissions against a limit of 1", async () => {
    const signer = signerBackend();
    const service = new RemoteSigningService({
      signer,
      policy: ratePolicy(),
    });

    // Both submissions start before either has recorded a reservation —
    // submitSigningRequest's check-and-reserve runs synchronously via
    // tryReserve() before the first `await` (signTransaction), so this
    // reproduces the interleaving a concurrent-caller race depends on.
    const [a, b] = await Promise.all([
      service.submitSigningRequest(rateRequest({ requestId: "race-a" })),
      service.submitSigningRequest(rateRequest({ requestId: "race-b" })),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.success)).toHaveLength(1);
    const rejected = results.find((r) => !r.success);
    expect(rejected?.policyDecision.matchedRule).toBe("rate_limit_hourly");
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("frees the slot on human rejection so a later request is admitted", async () => {
    const signer = signerBackend();
    const service = new RemoteSigningService({
      signer,
      policy: ratePolicy({ requireHumanConfirmation: true }),
    });

    const first = await service.submitSigningRequest(
      rateRequest({ requestId: "needs-approval" }),
    );
    expect(first.success).toBe(false);
    expect(first.policyDecision.requiresHumanConfirmation).toBe(true);

    // A second submission is rejected by the hourly limit while the first
    // reservation is still held pending human confirmation.
    const blocked = await service.submitSigningRequest(
      rateRequest({ requestId: "blocked-while-pending" }),
    );
    expect(blocked.policyDecision.matchedRule).toBe("rate_limit_hourly");

    const rejected = service.rejectRequest("needs-approval");
    expect(rejected).toBe(true);

    const after = await service.submitSigningRequest(
      rateRequest({ requestId: "after-rejection" }),
    );
    // The policy still requires human confirmation for every request, so
    // this can't reach success:true — the reservation freeing itself is
    // proven by getting past the rate limit (matchedRule "allowed") instead
    // of "rate_limit_hourly".
    expect(after.policyDecision.matchedRule).toBe("allowed");
  });

  it("frees the slot on approval expiry so a later request is admitted", async () => {
    const signer = signerBackend();
    const now = Date.parse("2026-08-20T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const service = new RemoteSigningService({
      signer,
      policy: ratePolicy({ requireHumanConfirmation: true }),
      approvalTimeoutMs: 1000,
    });

    await service.submitSigningRequest(
      rateRequest({ requestId: "expires-soon" }),
    );

    vi.spyOn(Date, "now").mockImplementation(() => now + 2000);
    const approveResult = await service.approveRequest("expires-soon");
    expect(approveResult.error).toBe("Approval expired");

    const after = await service.submitSigningRequest(
      rateRequest({ requestId: "after-expiry" }),
    );
    expect(after.policyDecision.matchedRule).toBe("allowed");
  });

  it("frees the slot when the signer itself fails", async () => {
    const signer = signerBackend();
    signer.signTransaction.mockRejectedValueOnce(new Error("signer offline"));
    const service = new RemoteSigningService({
      signer,
      policy: ratePolicy(),
    });

    const failed = await service.submitSigningRequest(
      rateRequest({ requestId: "sign-fails" }),
    );
    expect(failed.success).toBe(false);
    expect(failed.error).toMatch(/Signing failed/);

    const retry = await service.submitSigningRequest(
      rateRequest({ requestId: "sign-fails" }),
    );
    expect(retry.success).toBe(true);
  });
});
