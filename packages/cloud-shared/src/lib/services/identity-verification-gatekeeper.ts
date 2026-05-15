import { getAddress, verifyMessage } from "viem";
import type { ApprovalChallengePayload } from "../../db/repositories/approval-requests";
import type { ApprovalRequestsService } from "./approval-requests";
import { logger } from "../utils/logger";

/**
 * IdentityVerificationGatekeeper (Wave D).
 *
 * Verifies a signed challenge against an approval request and binds the
 * resulting identity to a session. Supports two signer kinds:
 *
 *   - "wallet"   — EIP-191 personal_sign over the challenge message text;
 *                  recovered address must match `challengePayload.walletAddress`.
 *                  (Compatible with the SIWE / wallet auth pattern used by
 *                  cloud/packages/lib/auth/wallet-auth.ts.)
 *   - "ed25519"  — base64 signature over the challenge message bytes;
 *                  verified against `challengePayload.publicKey` (base64).
 *
 * Session-binding is persisted via the optional `sessionBindingRepository`
 * when provided; otherwise the gatekeeper keeps an in-memory map. Wave H will
 * land a proper repository.
 */

export interface IdentityVerificationResult {
  valid: boolean;
  signerIdentityId?: string;
  error?: string;
}

export interface VerifyApprovalInput {
  approvalId: string;
  signature: string;
  expectedSignerIdentityId?: string;
}

export interface BindIdentityToSessionInput {
  sessionId: string;
  identityId: string;
}

export interface SessionBindingRepository {
  set(sessionId: string, identityId: string): Promise<void>;
  get(sessionId: string): Promise<string | null>;
}

export interface IdentityVerificationGatekeeperDeps {
  approvalRequests: ApprovalRequestsService;
  sessionBindingRepository?: SessionBindingRepository;
  /** Override the wallet signature verifier (test seam). */
  verifyWalletSignature?: (args: {
    address: string;
    message: string;
    signature: string;
  }) => Promise<boolean>;
  /** Override the ed25519 signature verifier (test seam). */
  verifyEd25519Signature?: (args: {
    publicKey: string;
    message: string;
    signature: string;
  }) => Promise<boolean>;
}

export interface IdentityVerificationGatekeeper {
  verify(input: VerifyApprovalInput): Promise<IdentityVerificationResult>;
  bindIdentityToSession(input: BindIdentityToSessionInput): Promise<void>;
  getBoundIdentity(sessionId: string): Promise<string | null>;
}

async function defaultVerifyWalletSignature(args: {
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  const address = (() => {
    try {
      return getAddress(args.address) as `0x${string}`;
    } catch {
      return null;
    }
  })();
  if (!address) return false;
  if (!args.signature.startsWith("0x")) return false;
  return verifyMessage({
    address,
    message: args.message,
    signature: args.signature as `0x${string}`,
  });
}

async function defaultVerifyEd25519Signature(args: {
  publicKey: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  // Lazy import so callers that never exercise ed25519 don't pay the cost.
  // Throws if the crypto API doesn't support ed25519 raw keys (extremely
  // unlikely on Workers / Bun / Node 20+).
  const { subtle } = globalThis.crypto;
  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    publicKeyBytes = base64ToBytes(args.publicKey);
    signatureBytes = base64ToBytes(args.signature);
  } catch {
    return false;
  }
  if (publicKeyBytes.length !== 32) return false;
  if (signatureBytes.length !== 64) return false;
  const key = await subtle.importKey(
    "raw",
    bytesToArrayBuffer(publicKeyBytes),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const messageBytes = new TextEncoder().encode(args.message);
  return subtle.verify(
    "Ed25519",
    key,
    bytesToArrayBuffer(signatureBytes),
    bytesToArrayBuffer(messageBytes),
  );
}

function base64ToBytes(input: string): Uint8Array {
  const trimmed = input.trim();
  // Accept both standard and URL-safe base64.
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  const copy = new Uint8Array(buffer);
  copy.set(bytes);
  return buffer;
}

function deriveSignerIdentityId(payload: ApprovalChallengePayload): string | null {
  if (payload.signerKind === "wallet" && payload.walletAddress) {
    try {
      return getAddress(payload.walletAddress);
    } catch {
      return null;
    }
  }
  if (payload.signerKind === "ed25519" && payload.publicKey) {
    return `ed25519:${payload.publicKey}`;
  }
  return null;
}

class IdentityVerificationGatekeeperImpl implements IdentityVerificationGatekeeper {
  private readonly approvalRequests: ApprovalRequestsService;
  private readonly sessionBindingRepository: SessionBindingRepository | undefined;
  private readonly verifyWallet: NonNullable<
    IdentityVerificationGatekeeperDeps["verifyWalletSignature"]
  >;
  private readonly verifyEd25519: NonNullable<
    IdentityVerificationGatekeeperDeps["verifyEd25519Signature"]
  >;
  // TODO(Wave H): replace with a persistent session-bindings repository.
  private readonly inMemoryBindings = new Map<string, string>();

  constructor(deps: IdentityVerificationGatekeeperDeps) {
    this.approvalRequests = deps.approvalRequests;
    this.sessionBindingRepository = deps.sessionBindingRepository;
    this.verifyWallet = deps.verifyWalletSignature ?? defaultVerifyWalletSignature;
    this.verifyEd25519 = deps.verifyEd25519Signature ?? defaultVerifyEd25519Signature;
  }

  async verify(input: VerifyApprovalInput): Promise<IdentityVerificationResult> {
    const approval = await this.approvalRequests.getPublic(input.approvalId);
    if (!approval) {
      return { valid: false, error: "approval request not found" };
    }
    if (approval.status === "expired" || approval.expiresAt.getTime() < Date.now()) {
      return { valid: false, error: "approval request expired" };
    }
    if (approval.status === "canceled" || approval.status === "denied") {
      return { valid: false, error: `approval request ${approval.status}` };
    }

    const payload = approval.challengePayload;
    const message = payload.message;
    if (typeof message !== "string" || message.length === 0) {
      return { valid: false, error: "challenge has no message" };
    }
    const signerKind = payload.signerKind;
    if (signerKind !== "wallet" && signerKind !== "ed25519") {
      return { valid: false, error: "challenge has no signerKind" };
    }

    let isValid = false;
    if (signerKind === "wallet") {
      if (!payload.walletAddress) {
        return { valid: false, error: "challenge missing walletAddress" };
      }
      isValid = await this.verifyWallet({
        address: payload.walletAddress,
        message,
        signature: input.signature,
      });
    } else {
      if (!payload.publicKey) {
        return { valid: false, error: "challenge missing publicKey" };
      }
      isValid = await this.verifyEd25519({
        publicKey: payload.publicKey,
        message,
        signature: input.signature,
      });
    }

    if (!isValid) {
      logger.warn("[IdentityVerificationGatekeeper] signature rejected", {
        approvalRequestId: input.approvalId,
        signerKind,
      });
      return { valid: false, error: "invalid signature" };
    }

    const signerIdentityId = deriveSignerIdentityId(payload);
    if (!signerIdentityId) {
      return { valid: false, error: "could not derive signer identity" };
    }

    const expected = input.expectedSignerIdentityId ?? approval.expectedSignerIdentityId ?? null;
    if (expected && expected !== signerIdentityId) {
      logger.warn("[IdentityVerificationGatekeeper] signer mismatch", {
        approvalRequestId: input.approvalId,
        expected,
        signerIdentityId,
      });
      return { valid: false, error: "signer identity does not match expected" };
    }

    return { valid: true, signerIdentityId };
  }

  async bindIdentityToSession(input: BindIdentityToSessionInput): Promise<void> {
    if (!input.sessionId) throw new Error("sessionId is required");
    if (!input.identityId) throw new Error("identityId is required");

    if (this.sessionBindingRepository) {
      await this.sessionBindingRepository.set(input.sessionId, input.identityId);
      return;
    }
    this.inMemoryBindings.set(input.sessionId, input.identityId);
    logger.info("[IdentityVerificationGatekeeper] in-memory session binding", {
      sessionId: input.sessionId,
      identityId: input.identityId,
    });
  }

  async getBoundIdentity(sessionId: string): Promise<string | null> {
    if (this.sessionBindingRepository) {
      return this.sessionBindingRepository.get(sessionId);
    }
    return this.inMemoryBindings.get(sessionId) ?? null;
  }
}

export function createIdentityVerificationGatekeeper(
  deps: IdentityVerificationGatekeeperDeps,
): IdentityVerificationGatekeeper {
  return new IdentityVerificationGatekeeperImpl(deps);
}
