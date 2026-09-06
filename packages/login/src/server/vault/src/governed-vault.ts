import { createHash } from "node:crypto";
import {
  canonicalJsonStringify,
  type ExecutionAuthorization,
  normalizeEvmExecutionPayload,
  type SignRequest,
} from "../../shared/src/index.ts";
import type { SignTransactionOptions, Vault } from "./vault";

export type ExecutionAuthorizationConsumeCallback = (
  authorization: ExecutionAuthorization,
  expected: {
    tenantId: string;
    agentId: string;
    capability: "wallet.sign_transaction";
    backend: "local-vault" | "external-custody";
    backendIdentityDigest?: string;
    payloadDigest: string;
  },
) => Promise<void>;

export class GovernedVaultError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_authorization"
      | "missing_payload_digest"
      | "payload_digest_mismatch"
      | "unsupported_chain_family"
      | "authorization_rejected",
  ) {
    super(message);
    this.name = "GovernedVaultError";
  }
}

export interface GovernedSignTransactionOptions extends SignTransactionOptions {
  executionAuthorization?: ExecutionAuthorization;
  executionPayloadDigest?: string;
}

/**
 * Digest binds the normalized transaction INTENT (caller-controlled,
 * policy-relevant fields) via the SINGLE shared canonicalizer/normalizer in
 * @stwd/shared. It does NOT bind the node-resolved final serialized envelope;
 * nonce/gas price may still be finalized inside the raw Vault after the
 * authorization is consumed. The normalizer validates chainId/nonce as
 * non-negative safe integers and throws on malformed caller fields so a bad
 * request can never be digested past this boundary.
 */
export function executionPayloadDigestForGovernedEvmSign(
  request: SignRequest,
): string {
  return createHash("sha256")
    .update(canonicalJsonStringify(normalizeEvmExecutionPayload(request)))
    .digest("hex");
}

export class GovernedVault {
  constructor(
    private readonly rawVault: Vault,
    private readonly consumeExecutionAuthorization: ExecutionAuthorizationConsumeCallback,
  ) {}

  async signTransactionAuthorized(
    request: SignRequest,
    options: GovernedSignTransactionOptions,
  ): Promise<string> {
    const chainId = request.chainId || 8453;
    if (chainId === 101 || chainId === 102) {
      throw new GovernedVaultError(
        "GovernedVault.signTransaction is scoped to the EVM transaction path",
        "unsupported_chain_family",
      );
    }
    if (!options.executionAuthorization) {
      throw new GovernedVaultError(
        "Execution authorization is required for governed EVM transaction signing",
        "missing_authorization",
      );
    }
    if (!options.executionPayloadDigest) {
      throw new GovernedVaultError(
        "Execution payload digest is required for governed EVM transaction signing",
        "missing_payload_digest",
      );
    }
    const requestPayloadDigest =
      executionPayloadDigestForGovernedEvmSign(request);
    if (options.executionPayloadDigest !== requestPayloadDigest) {
      throw new GovernedVaultError(
        "Execution payload digest does not match governed EVM transaction request",
        "payload_digest_mismatch",
      );
    }

    try {
      const backend = options.executionAuthorization.backend;
      if (backend !== "local-vault" && backend !== "external-custody") {
        throw new GovernedVaultError(
          "Unsupported custody backend",
          "authorization_rejected",
        );
      }
      await this.consumeExecutionAuthorization(options.executionAuthorization, {
        tenantId: request.tenantId,
        agentId: request.agentId,
        capability: "wallet.sign_transaction",
        backend,
        backendIdentityDigest:
          options.executionAuthorization.backendIdentityDigest,
        payloadDigest: options.executionPayloadDigest,
      });
    } catch (error) {
      if (error instanceof GovernedVaultError) throw error;
      const message =
        error instanceof Error
          ? error.message
          : "Execution authorization was rejected";
      throw new GovernedVaultError(message, "authorization_rejected");
    }

    const {
      executionAuthorization: _authorization,
      executionPayloadDigest: _digest,
      ...rawOptions
    } = options;
    // Bind the raw signer to the SAME custody backend this governed
    // authorization was consumed against. The raw vault
    // re-resolves the backend from the fresh wallet lookup it will sign with
    // and fails closed (BackendBindingMismatchError) if the wallet has flipped
    // to third-party custody since resolveExecutionBackend ran, closing the
    // resolution->sign TOCTOU before any external provider is reached.
    return this.rawVault.signTransaction(request, {
      ...rawOptions,
      expectedBackend: options.executionAuthorization.backend as
        | "local-vault"
        | "external-custody",
      expectedBackendIdentityDigest:
        options.executionAuthorization.backendIdentityDigest,
    });
  }
}
