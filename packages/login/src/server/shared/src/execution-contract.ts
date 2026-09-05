export type ExecutionCapability =
  | "wallet.sign_transaction"
  | "wallet.sign_message"
  | "wallet.sign_raw_hash"
  | "wallet.sign_raw_digest"
  | "wallet.sign_typed_data"
  | "wallet.sign_user_operation"
  | "wallet.sign_authorization"
  | "wallet.sign_solana_transaction"
  | "wallet.sign_bitcoin_psbt"
  | "wallet.prepare_monero_transfer"
  | "wallet.relay_monero_transfer"
  | "wallet.export_private_key"
  | "credential.inject_http";

export type ExecutionDecisionStatus =
  | "approved"
  | "rejected"
  | "requires_approval";
export type ExecutionAuthorizationStatus =
  | "active"
  | "consumed"
  | "expired"
  | "revoked";

export interface ExecutionPolicyResult {
  policyId: string;
  type: string;
  passed: boolean;
  reason?: string;
}

/**
 * Canonical request envelope for a consequential operation.
 *
 * This is a types-only contract for the policy-bound execution gateway. Current
 * signing routes still build their own route-local policy context; future
 * integrations can use this shape to bind wallet and credential actions to one
 * authorization path without changing the raw Vault API.
 */
export interface ExecutionRequest<Payload = unknown> {
  id: string;
  tenantId: string;
  agentId: string;
  capability: ExecutionCapability;
  payload: Payload;
  payloadDigest: string;
  idempotencyKey?: string;
  requestedAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Policy result for an ExecutionRequest before any secret, key, or custodian is
 * used. `policyRevisionHash` is intended to bind approval decisions to the
 * exact policy snapshot evaluated for the request.
 */
export interface ExecutionDecision {
  requestId: string;
  status: ExecutionDecisionStatus;
  policyResults: ExecutionPolicyResult[];
  policyRevisionHash?: string;
  approvalId?: string;
  decidedAt: string;
  reason?: string;
}

/**
 * Single-use authorization produced after policy and approval gates pass.
 *
 * The authorization is meant to be verified immediately before decrypting local
 * key material, asking an external custodian to sign, or injecting a credential.
 * It binds the operation to tenant, agent, capability, backend, payload digest,
 * policy revision, nonce, and expiry.
 */
export interface ExecutionAuthorization {
  id: string;
  requestId: string;
  tenantId: string;
  agentId: string;
  capability: ExecutionCapability;
  payloadDigest: string;
  backend: "local-vault" | "external-custody" | "credential-proxy";
  /** SHA-256 commitment to provider/key/version/region/address for external custody. */
  backendIdentityDigest?: string;
  policyRevisionHash?: string;
  approvalId?: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  status: ExecutionAuthorizationStatus;
  /**
   * HMAC-SHA256 over the canonical authorization fields. Optional for
   * compatibility with callers compiled against the original append-only
   * contract, but required by the governed-execution gateway verifier.
   */
  signature?: string;
  /** Caller-supplied idempotency key bound into the signed authorization. */
  idempotencyKey?: string;
}

/**
 * Provider execution authorization v2.
 *
 * A `version: 2` authorization row in `execution_authorization_nonces`. It is a
 * subordinate, per-execution claim object keyed 1:1 to the intent; it NEVER
 * independently advances the provider action (that is the binding lifecycle).
 * Every bound fact below is re-checked at DB time by the single-winner claim
 * (spec §2.3) and again at the signing boundary (§4.1 step 3). The HMAC
 * `signature` is over the domain-separated v2 commitment (see @stwd/shared
 * `providerExecutionSignatureInput`), derived from `STEWARD_EXECUTION_AUTH_SECRET`
 * via HKDF — NEVER `STEWARD_JWT_SECRET` (X7 fail-closed, domain separation).
 */
export type ProviderExecutionDispatchState =
  | "none"
  | "claimed"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

export interface ProviderExecutionAuthorizationV2 {
  version: 2;
  authorizationId: string;
  executionId: string;
  intentId: string;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  actorAgentId: string;
  providerAccountId: string;
  operationId: string;
  operationRevision: number;
  requestHash: string;
  actionDigest: string;
  grantDependencyHash: string;
  policyRevisionHash: string;
  accessDecisionHash: string;
  approvalId: string;
  approvalCommitmentHash: string;
  routeId: string;
  routeRevision: number;
  secretId: string;
  secretVersion: number;
  backend: "credential-proxy";
  providerIdempotencyKey: string;
  commitmentHash: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  status: ExecutionAuthorizationStatus;
  dispatchState: ProviderExecutionDispatchState;
  keyId: string;
  signature: string;
}

/**
 * Portable evidence container for an executed or rejected operation.
 *
 * The bundle intentionally references request, decision, authorization, audit,
 * and optional chain/provider artifacts without prescribing a runtime storage
 * format. Later evidence PRs can sign this bundle and ship an offline verifier.
 */
export interface EvidenceBundle<Payload = unknown> {
  request: ExecutionRequest<Payload>;
  decision: ExecutionDecision;
  authorization?: ExecutionAuthorization;
  auditEventIds: string[];
  chainArtifacts?: Array<{
    chainId?: number;
    transactionHash?: string;
    signature?: string;
    signedPayloadDigest?: string;
  }>;
  createdAt: string;
}
