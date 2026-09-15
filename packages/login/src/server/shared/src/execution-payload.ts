import { CHAIN_PROVIDERS_BY_NUMERIC } from "./chains/index.js";
import type { SignRequest } from "./index.js";

/**
 * Canonical normalization + digest for the primary EVM `wallet.sign_transaction`
 * execution payload.
 *
 * ONE implementation, used by both:
 *  - the API when minting an ExecutionAuthorization (packages/api execution-authorization.ts)
 *  - GovernedVault when verifying an authorization immediately before raw signing
 *    (packages/vault governed-vault.ts)
 *
 * The digest binds the transaction *intent* (caller-controlled, policy-relevant
 * fields), NOT the final node-resolved serialized envelope. Node-resolved
 * nonce/gas price may still be finalized inside the Vault after authorization is
 * consumed; those node-resolved fields are deliberately outside the bound intent.
 */

/**
 * Fields that carry a caller-supplied integer we bind into the intent digest.
 * All are validated as non-negative safe integers before they are normalized so
 * a malformed value can never be silently coerced past the digest boundary.
 */
export class ExecutionPayloadNormalizationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "ExecutionPayloadNormalizationError";
  }
}

function normalizeSafeNonNegativeInteger(
  value: number | undefined | null,
  field: string,
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExecutionPayloadNormalizationError(
      `${field} must be a non-negative safe integer`,
      field,
    );
  }
  return value;
}

export interface NormalizedEvmExecutionPayload {
  agentId: string;
  tenantId: string;
  capability: "wallet.sign_transaction";
  backend: "local-vault";
  transaction: {
    to: string;
    value: string;
    data: string;
    chainId: number;
    nonce: number | null;
    gasLimit: string | null;
    broadcast: boolean;
    venue: string | null;
    walletAddress: string | null;
  };
}

/**
 * True only for chains registered as EVM-family. Unknown numeric ids and
 * non-EVM families (Solana/Bitcoin/Monero) return false — fail closed, so a
 * future caller routing on this never mis-handles a non-EVM id as EVM
 * (SEC-193).
 */
export function isEvmChainId(chainId: number): boolean {
  return CHAIN_PROVIDERS_BY_NUMERIC[chainId]?.family === "evm";
}

/**
 * Produce the canonical normalized intent payload for a primary EVM sign
 * request. Throws ExecutionPayloadNormalizationError on any malformed
 * numeric caller field so callers can fail closed rather than digest garbage.
 */
export function normalizeEvmExecutionPayload(
  request: SignRequest,
): NormalizedEvmExecutionPayload {
  const chainId = normalizeSafeNonNegativeInteger(request.chainId, "chainId");
  if (chainId === null) {
    throw new ExecutionPayloadNormalizationError(
      "chainId is required",
      "chainId",
    );
  }
  const nonce = normalizeSafeNonNegativeInteger(request.nonce ?? null, "nonce");
  return {
    agentId: request.agentId,
    tenantId: request.tenantId,
    capability: "wallet.sign_transaction",
    backend: "local-vault",
    transaction: {
      to: request.to,
      value: request.value,
      data: request.data ?? "0x",
      chainId,
      nonce,
      gasLimit: request.gasLimit ?? null,
      broadcast: request.broadcast !== false,
      venue: request.venue ?? null,
      walletAddress: request.walletAddress ?? null,
    },
  };
}

/** Stable stringify with sorted keys. Shared by digest producers/verifiers. */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  const input = value as Record<string, unknown>;
  // Null-prototype output: plain `{}` assignment silently DROPS an own
  // `__proto__` key (present after JSON.parse/JSONB reads), which would let two
  // snapshots differing only in that member digest identically (SEC-115).
  const output: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(input).sort()) {
    const item = input[key];
    if (item !== undefined) output[key] = canonicalize(item);
  }
  return output;
}
