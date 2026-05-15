import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
}));

import type { ApprovalRequestRow } from "@/db/repositories/approval-requests";
import type { ApprovalRequestsService } from "@/lib/services/approval-requests";
import { createIdentityVerificationGatekeeper } from "@/lib/services/identity-verification-gatekeeper";

function makeRow(overrides: Partial<ApprovalRequestRow> = {}): ApprovalRequestRow {
  return {
    id: "appr_1",
    organizationId: "org-1",
    agentId: null,
    userId: null,
    challengeKind: "login",
    challengePayload: {
      message: "Sign in",
      signerKind: "wallet",
      walletAddress: "0xabcdef0000000000000000000000000000000000",
    },
    expectedSignerIdentityId: null,
    status: "pending",
    signatureText: null,
    signedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeApprovalRequestsService(row: ApprovalRequestRow | null): ApprovalRequestsService {
  return {
    create: async () => row ?? makeRow(),
    get: async () => row,
    getPublic: async () => row,
    list: async () => (row ? [row] : []),
    markDelivered: async () => row ?? makeRow(),
    markApproved: async () => row ?? makeRow(),
    markDenied: async () => row ?? makeRow(),
    cancel: async () => row ?? makeRow(),
    expirePast: async () => [],
  };
}

describe("identityVerificationGatekeeper.verify", () => {
  test("returns invalid when approval request is missing", async () => {
    const gk = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(null),
    });
    const result = await gk.verify({ approvalId: "missing", signature: "0x" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  test("returns invalid when the approval has expired", async () => {
    const row = makeRow({ expiresAt: new Date(Date.now() - 60_000) });
    const gk = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(row),
    });
    const result = await gk.verify({ approvalId: "appr_1", signature: "0x" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/expired/);
  });

  test("returns invalid when the approval was canceled", async () => {
    const row = makeRow({ status: "canceled" });
    const gk = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(row),
    });
    const result = await gk.verify({ approvalId: "appr_1", signature: "0x" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/canceled/);
  });

  test("wallet signer: rejects invalid signature via injected verifier", async () => {
    const row = makeRow();
    const gk = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(row),
      verifyWalletSignature: async () => false,
    });
    const result = await gk.verify({ approvalId: "appr_1", signature: "0xbad" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid signature/);
  });

  test("wallet signer: accepts valid signature and recovers EIP-55 address", async () => {
    const row = makeRow();
    const gk = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(row),
      verifyWalletSignature: async () => true,
    });
    const result = await gk.verify({ approvalId: "appr_1", signature: "0xok" });
    expect(result.valid).toBe(true);
    expect(result.signerIdentityId?.toLowerCase()).toBe(
      "0xabcdef0000000000000000000000000000000000",
    );
  });

  test("rejects when expectedSignerIdentityId does not match recovered identity", async () => {
    const row = makeRow();
    const gk = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(row),
      verifyWalletSignature: async () => true,
    });
    const result = await gk.verify({
      approvalId: "appr_1",
      signature: "0xok",
      expectedSignerIdentityId: "0xDifferent00000000000000000000000000000000",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not match expected/);
  });

  test("ed25519 signer: returns signerIdentityId prefixed with ed25519:", async () => {
    const row = makeRow({
      challengePayload: {
        message: "hello",
        signerKind: "ed25519",
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
    });
    const gk = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(row),
      verifyEd25519Signature: async () => true,
    });
    const result = await gk.verify({ approvalId: "appr_1", signature: "AAAA" });
    expect(result.valid).toBe(true);
    expect(result.signerIdentityId).toBe("ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  });

  test("returns invalid when payload has no signerKind", async () => {
    const row = makeRow({ challengePayload: { message: "no signer kind" } });
    const gk = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(row),
    });
    const result = await gk.verify({ approvalId: "appr_1", signature: "x" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signerKind/);
  });
});

describe("identityVerificationGatekeeper.bindIdentityToSession", () => {
  let gk: ReturnType<typeof createIdentityVerificationGatekeeper>;
  beforeEach(() => {
    gk = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(makeRow()),
    });
  });

  test("stores binding in memory when no repo is provided", async () => {
    await gk.bindIdentityToSession({ sessionId: "sess-1", identityId: "0xabc" });
    const bound = await gk.getBoundIdentity("sess-1");
    expect(bound).toBe("0xabc");
  });

  test("delegates to sessionBindingRepository when provided", async () => {
    const store = new Map<string, string>();
    const repo = {
      set: async (sessionId: string, identityId: string) => {
        store.set(sessionId, identityId);
      },
      get: async (sessionId: string) => store.get(sessionId) ?? null,
    };
    const gkWithRepo = createIdentityVerificationGatekeeper({
      approvalRequests: makeApprovalRequestsService(makeRow()),
      sessionBindingRepository: repo,
    });
    await gkWithRepo.bindIdentityToSession({ sessionId: "sess-2", identityId: "0xdef" });
    expect(store.get("sess-2")).toBe("0xdef");
    expect(await gkWithRepo.getBoundIdentity("sess-2")).toBe("0xdef");
  });

  test("rejects empty session id or identity id", async () => {
    await expect(
      gk.bindIdentityToSession({ sessionId: "", identityId: "0xabc" }),
    ).rejects.toThrow();
    await expect(
      gk.bindIdentityToSession({ sessionId: "sess-1", identityId: "" }),
    ).rejects.toThrow();
  });
});
