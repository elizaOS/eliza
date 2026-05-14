/**
 * IdentityVerificationGatekeeper (Wave D).
 *
 * Validates the signature attached to an approval request and binds the
 * verified identity to a session. SIWE/EVM signatures are verified through
 * viem (the same path used by `wallet-auth.ts`); Ed25519 (Solana) signatures
 * are verified through @noble/ed25519 with bs58 decoding of the signer
 * identity.
 *
 * Session binding currently writes to an in-memory map. Wave H will swap in
 * a persistent session-settings repo without changing the public surface
 * (`bindIdentityToSession`).
 */

import { verifyMessage } from "viem";
import type { ApprovalRequestsService } from "@/lib/services/approval-requests";
import { logger } from "@/lib/utils/logger";

export interface IdentityVerificationResult {
  valid: boolean;
  signerIdentityId?: string;
  error?: string;
}

export interface VerifyArgs {
  approvalId: string;
  signature: string;
  expectedSignerIdentityId?: string;
}

export interface BindIdentityArgs {
  sessionId: string;
  identityId: string;
}

export interface BindIdentityResult {
  bound: boolean;
  sessionId: string;
  identityId: string;
  persisted: boolean;
}

export interface SessionIdentityBindingStore {
  put(sessionId: string, identityId: string): Promise<void>;
  get(sessionId: string): Promise<string | null>;
}

export interface IdentityVerificationGatekeeperDeps {
  approvalRequests: ApprovalRequestsService;
  bindingStore?: SessionIdentityBindingStore;
}

export interface IdentityVerificationGatekeeper {
  verify(args: VerifyArgs): Promise<IdentityVerificationResult>;
  bindIdentityToSession(args: BindIdentityArgs): Promise<BindIdentityResult>;
  getBoundIdentity(sessionId: string): Promise<string | null>;
}

const HEX_SIG_PATTERN = /^0x[0-9a-fA-F]+$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Heuristic: distinguish EVM identities (`0x` + 40 hex) from Solana identities
 * (base58 string, ~44 chars). Identity strings carry no scheme prefix today;
 * if Wave H introduces a scheme tag this can be replaced with a parser.
 */
function detectScheme(identityId: string): "evm" | "ed25519" {
  if (EVM_ADDRESS_PATTERN.test(identityId)) return "evm";
  return "ed25519";
}

function buildChallengeMessage(
  approvalId: string,
  challengeKind: string,
  payload: Record<string, unknown>,
): string {
  // TODO Wave H: build per-kind canonical message (SIWE for login, EIP-712 for
  // structured signature). For now we use a deterministic line-based encoding
  // so verifier and signer agree on the bytes.
  const payloadLines = Object.keys(payload)
    .sort()
    .map((key) => `${key}: ${JSON.stringify(payload[key])}`);
  return [`Eliza Approval`, `Id: ${approvalId}`, `Kind: ${challengeKind}`, ...payloadLines].join(
    "\n",
  );
}

async function verifyEvmSignature(args: {
  message: string;
  signature: string;
  expectedAddress: string;
}): Promise<boolean> {
  if (!HEX_SIG_PATTERN.test(args.signature)) return false;
  if (!EVM_ADDRESS_PATTERN.test(args.expectedAddress)) return false;
  return verifyMessage({
    address: args.expectedAddress as `0x${string}`,
    message: args.message,
    signature: args.signature as `0x${string}`,
  });
}

async function verifyEd25519Signature(args: {
  message: string;
  signature: string;
  expectedSignerIdentityId: string;
}): Promise<boolean> {
  // Lazy-load to avoid pulling crypto deps into bundles that never reach this
  // path, and to keep the module loadable in environments where the libs are
  // optional (tests with mocked verify).
  const [{ verifyAsync }, bs58Module] = await Promise.all([
    import("@noble/ed25519"),
    import("bs58"),
  ]);
  const bs58Namespace = bs58Module as unknown as {
    default?: { decode: (s: string) => Uint8Array };
    decode?: (s: string) => Uint8Array;
  };
  const bs58 = bs58Namespace.default ?? bs58Namespace;

  const decodeBs58 = (input: string): Uint8Array => {
    return bs58.decode(input);
  };

  let publicKey: Uint8Array;
  let sig: Uint8Array;
  try {
    publicKey = decodeBs58(args.expectedSignerIdentityId);
    sig = HEX_SIG_PATTERN.test(args.signature)
      ? hexToBytes(args.signature.slice(2))
      : decodeBs58(args.signature);
  } catch {
    return false;
  }
  const messageBytes = new TextEncoder().encode(args.message);
  return verifyAsync(sig, messageBytes, publicKey);
}

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length;
  if (len % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

class InMemorySessionBindingStore implements SessionIdentityBindingStore {
  private readonly bindings = new Map<string, string>();
  async put(sessionId: string, identityId: string): Promise<void> {
    this.bindings.set(sessionId, identityId);
  }
  async get(sessionId: string): Promise<string | null> {
    return this.bindings.get(sessionId) ?? null;
  }
}

class IdentityVerificationGatekeeperImpl implements IdentityVerificationGatekeeper {
  private readonly approvalRequests: ApprovalRequestsService;
  private readonly bindingStore: SessionIdentityBindingStore;
  private readonly persistentStoreInjected: boolean;

  constructor(deps: IdentityVerificationGatekeeperDeps) {
    this.approvalRequests = deps.approvalRequests;
    this.bindingStore = deps.bindingStore ?? new InMemorySessionBindingStore();
    this.persistentStoreInjected = Boolean(deps.bindingStore);
  }

  async verify(args: VerifyArgs): Promise<IdentityVerificationResult> {
    if (!args.approvalId) {
      return { valid: false, error: "approvalId is required" };
    }
    if (!args.signature) {
      return { valid: false, error: "signature is required" };
    }

    const approval = await this.approvalRequests.getPublic(args.approvalId);
    if (!approval) {
      return { valid: false, error: "approval not found" };
    }
    if (approval.status !== "pending" && approval.status !== "delivered") {
      return { valid: false, error: `approval is in terminal status ${approval.status}` };
    }
    if (approval.expiresAt.getTime() < Date.now()) {
      return { valid: false, error: "approval expired" };
    }

    const expectedSigner =
      args.expectedSignerIdentityId ?? approval.expectedSignerIdentityId ?? null;
    if (!expectedSigner) {
      return { valid: false, error: "expectedSignerIdentityId is required" };
    }

    const message = buildChallengeMessage(
      approval.id,
      approval.challengeKind,
      approval.challengePayload,
    );

    const scheme = detectScheme(expectedSigner);
    let valid: boolean;
    try {
      if (scheme === "evm") {
        valid = await verifyEvmSignature({
          message,
          signature: args.signature,
          expectedAddress: expectedSigner,
        });
      } else {
        valid = await verifyEd25519Signature({
          message,
          signature: args.signature,
          expectedSignerIdentityId: expectedSigner,
        });
      }
    } catch (error) {
      logger.warn("[IdentityVerificationGatekeeper] signature verify threw", {
        approvalId: args.approvalId,
        scheme,
        error,
      });
      return { valid: false, error: "signature verification threw" };
    }

    if (!valid) {
      return { valid: false, error: "signature did not verify" };
    }

    return { valid: true, signerIdentityId: expectedSigner };
  }

  async bindIdentityToSession(args: BindIdentityArgs): Promise<BindIdentityResult> {
    if (!args.sessionId) throw new Error("sessionId is required");
    if (!args.identityId) throw new Error("identityId is required");

    await this.bindingStore.put(args.sessionId, args.identityId);

    if (!this.persistentStoreInjected) {
      logger.warn(
        "[IdentityVerificationGatekeeper] bindIdentityToSession using in-memory store; persistence pending Wave H",
        { sessionId: args.sessionId },
      );
    }

    return {
      bound: true,
      sessionId: args.sessionId,
      identityId: args.identityId,
      persisted: this.persistentStoreInjected,
    };
  }

  async getBoundIdentity(sessionId: string): Promise<string | null> {
    return this.bindingStore.get(sessionId);
  }
}

export function createIdentityVerificationGatekeeper(
  deps: IdentityVerificationGatekeeperDeps,
): IdentityVerificationGatekeeper {
  return new IdentityVerificationGatekeeperImpl(deps);
}

export const __testing = {
  buildChallengeMessage,
  detectScheme,
  InMemorySessionBindingStore,
};
