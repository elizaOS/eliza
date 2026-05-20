import { describe, expect, it, vi } from "vitest";
import type { SignerBackend } from "./remote-signing-service.ts";
import { TeeSignerBackend } from "./tee-signer-backend.ts";

const tx = {
  to: "0x0000000000000000000000000000000000000001",
  value: "1",
  data: "0x",
  chainId: 1,
};

describe("TEE signer backend", () => {
  it("delegates signing when TEE evidence satisfies policy", async () => {
    const signer = signerBackend();
    const backend = new TeeSignerBackend({
      signer,
      evidenceProvider: {
        id: "test",
        collectEvidence: async () => evidence("sha256:abc", true),
      },
      policy: {
        required: true,
        allowedKinds: ["dstack"],
        requiredMeasurements: { agent: "abc" },
        requiredClaims: { debugDisabled: true },
      },
    });

    await expect(backend.signTransaction(tx)).resolves.toBe("signed-tx");
    expect(signer.signTransaction).toHaveBeenCalledWith(tx);
  });

  it("rejects signing before the underlying signer sees the request when evidence fails", async () => {
    const signer = signerBackend();
    const backend = new TeeSignerBackend({
      signer,
      evidenceProvider: {
        id: "test",
        collectEvidence: async () => evidence("sha256:wrong", true),
      },
      policy: {
        required: true,
        requiredMeasurements: { agent: "sha256:abc" },
      },
    });

    await expect(backend.signTransaction(tx)).rejects.toThrow(
      /TEE signing policy rejected evidence/,
    );
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });
});

function signerBackend(): SignerBackend & {
  signTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: vi.fn(async () => "0xsigner"),
    signMessage: vi.fn(async () => "signed-message"),
    signTransaction: vi.fn(async () => "signed-tx"),
  };
}

function evidence(agentDigest: string, debugDisabled: boolean) {
  return {
    kind: "dstack",
    measurements: { agent: agentDigest },
    claims: { debugDisabled },
  };
}
