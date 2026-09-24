/** Issues and consumes signed, expiring execution authorizations bound to wallet requests and policy decisions. */
import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { requireLoginValue } from "../../../../required";
import {
  executionAuthorizationNonces,
  getDb,
  policies,
} from "../../../db/src/index.ts";
import {
  canonicalJsonStringify,
  type ExecutionAuthorization,
  type ExecutionCapability,
  loadExecutionAuthV2Keys,
  type NormalizedEvmExecutionPayload,
  normalizeEvmExecutionPayload,
  type PolicyRule,
  type SignRequest,
} from "../../../shared/src/index.ts";

export const EXECUTION_AUTHORIZATION_TTL_MS = 60_000;
const EXECUTION_AUTHORIZATION_HKDF_INFO =
  "steward:execution-authorization:hmac:v1";
const EXECUTION_AUTHORIZATION_HKDF_SALT =
  "steward:execution-authorization:salt:v1";

export class ExecutionAuthorizationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_signature"
      | "invalid_signature"
      | "expired"
      | "context_mismatch"
      | "nonce_consumed"
      | "secret_unavailable",
  ) {
    super(message);
    this.name = "ExecutionAuthorizationError";
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonStringify(value);
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");
}

/**
 * Canonical normalized EVM sign intent. Delegates to the SINGLE shared
 * normalizer so the API minting side and the GovernedVault verification side
 * digest byte-identical payloads. Throws on malformed numeric caller fields.
 */
export function executionPayloadForEvmSign(
  request: SignRequest,
): NormalizedEvmExecutionPayload {
  return normalizeEvmExecutionPayload(request);
}

export function executionPayloadDigestForEvmSign(request: SignRequest): string {
  return sha256Hex(executionPayloadForEvmSign(request));
}

export async function policyRevisionHashForAgent(
  agentId: string,
): Promise<string> {
  const rows = await getDb()
    .select({
      id: policies.id,
      type: policies.type,
      enabled: policies.enabled,
      config: policies.config,
      updatedAt: policies.updatedAt,
    })
    .from(policies)
    .where(eq(policies.agentId, agentId));
  return sha256Hex(
    rows
      .map((row) => ({
        id: row.id,
        type: row.type,
        enabled: row.enabled,
        config: row.config,
        updatedAt: row.updatedAt.toISOString(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function policyRevisionHashForPolicySet(
  policySet: readonly PolicyRule[],
): string {
  return sha256Hex(
    policySet
      .map((policy) => ({
        id: policy.id,
        type: policy.type,
        enabled: policy.enabled,
        config: policy.config,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export interface MintExecutionAuthorizationInput {
  requestId: string;
  tenantId: string;
  agentId: string;
  capability: ExecutionCapability;
  payloadDigest: string;
  backend: ExecutionAuthorization["backend"];
  backendIdentityDigest?: string;
  policyRevisionHash?: string;
  approvalId?: string;
  idempotencyKey?: string;
  now?: Date;
}

export async function mintExecutionAuthorization(
  input: MintExecutionAuthorizationInput,
): Promise<ExecutionAuthorization> {
  if (
    (input.backend === "external-custody" &&
      !/^[0-9a-f]{64}$/.test(input.backendIdentityDigest ?? "")) ||
    (input.backend !== "external-custody" &&
      input.backendIdentityDigest !== undefined)
  ) {
    throw new ExecutionAuthorizationError(
      "External custody authorization requires an exact provider/key/address identity digest",
      "context_mismatch",
    );
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + EXECUTION_AUTHORIZATION_TTL_MS);
  const authorization: ExecutionAuthorization = {
    id: randomUUID(),
    requestId: input.requestId,
    tenantId: input.tenantId,
    agentId: input.agentId,
    capability: input.capability,
    payloadDigest: input.payloadDigest,
    backend: input.backend,
    backendIdentityDigest: input.backendIdentityDigest,
    policyRevisionHash: input.policyRevisionHash,
    approvalId: input.approvalId,
    nonce: base64Url(randomBytes(24)),
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: "active",
    idempotencyKey: input.idempotencyKey,
  };
  authorization.signature = signExecutionAuthorization(authorization);

  await getDb().insert(executionAuthorizationNonces).values({
    authorizationId: authorization.id,
    requestId: authorization.requestId,
    tenantId: authorization.tenantId,
    agentId: authorization.agentId,
    capability: authorization.capability,
    backend: authorization.backend,
    backendIdentityDigest: authorization.backendIdentityDigest,
    payloadDigest: authorization.payloadDigest,
    policyRevisionHash: authorization.policyRevisionHash,
    approvalId: authorization.approvalId,
    nonce: authorization.nonce,
    signature: authorization.signature,
    idempotencyKey: authorization.idempotencyKey,
    status: "active",
    issuedAt: now,
    expiresAt,
  });

  return authorization;
}

export interface ConsumeExecutionAuthorizationContext {
  tenantId: string;
  agentId: string;
  capability: ExecutionCapability;
  backend: ExecutionAuthorization["backend"];
  backendIdentityDigest?: string;
  payloadDigest: string;
}

export async function consumeExecutionAuthorization(
  authorization: ExecutionAuthorization,
  expected: ConsumeExecutionAuthorizationContext,
): Promise<void> {
  verifyExecutionAuthorization(authorization, expected);
  const [row] = await getDb()
    .update(executionAuthorizationNonces)
    .set({ status: "consumed", consumedAt: new Date() })
    .where(
      and(
        eq(executionAuthorizationNonces.authorizationId, authorization.id),
        eq(executionAuthorizationNonces.nonce, authorization.nonce),
        eq(executionAuthorizationNonces.backend, authorization.backend),
        authorization.backendIdentityDigest
          ? eq(
              executionAuthorizationNonces.backendIdentityDigest,
              authorization.backendIdentityDigest,
            )
          : sql`${executionAuthorizationNonces.backendIdentityDigest} IS NULL`,
        eq(executionAuthorizationNonces.status, "active"),
        sql`${executionAuthorizationNonces.expiresAt} > now()`,
      ),
    )
    .returning({ id: executionAuthorizationNonces.id });
  if (!row) {
    throw new ExecutionAuthorizationError(
      "Execution authorization nonce is expired or already consumed",
      Date.parse(authorization.expiresAt) <= Date.now()
        ? "expired"
        : "nonce_consumed",
    );
  }
}

export function verifyExecutionAuthorization(
  authorization: ExecutionAuthorization,
  expected: ConsumeExecutionAuthorizationContext,
): void {
  if (!authorization.signature) {
    throw new ExecutionAuthorizationError(
      "Execution authorization is missing a signature",
      "missing_signature",
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new ExecutionAuthorizationError(
      "Execution authorization has expired",
      "expired",
    );
  }
  if (
    authorization.tenantId !== expected.tenantId ||
    authorization.agentId !== expected.agentId ||
    authorization.capability !== expected.capability ||
    authorization.backend !== expected.backend ||
    authorization.backendIdentityDigest !== expected.backendIdentityDigest ||
    authorization.payloadDigest !== expected.payloadDigest ||
    authorization.status !== "active"
  ) {
    throw new ExecutionAuthorizationError(
      "Execution authorization context does not match the signing request",
      "context_mismatch",
    );
  }
  const expectedSignature = signExecutionAuthorization(authorization);
  if (!constantTimeEqual(authorization.signature, expectedSignature)) {
    throw new ExecutionAuthorizationError(
      "Execution authorization signature is invalid",
      "invalid_signature",
    );
  }
}

function signExecutionAuthorization(
  authorization: ExecutionAuthorization,
): string {
  return base64Url(
    createHmac("sha256", executionAuthorizationKey())
      .update(canonicalJson(signaturePayload(authorization)))
      .digest(),
  );
}

function executionAuthorizationKey(): Uint8Array {
  // SEC-074: derive from the dedicated execution-auth secret, NEVER from
  // STEWARD_JWT_SECRET (the most widely-used secret in the deployment; its
  // compromise must not yield forgeable execution authorizations). Mirrors the
  // v2 mint posture (provider-execution.ts, X7): no JWT-secret fallback. v1
  // authorizations are minted and consumed inside this process within a 60s
  // TTL, so the active (first) key entry suffices; v1 keeps its own HKDF
  // salt/info above for domain separation from the v2 derived keys.
  let secret: Uint8Array;
  try {
    // Reuse the v2 parser so v1 cannot bypass its 32-character entropy floor,
    // malformed-entry rejection, or rotation-list semantics.
    secret = requireLoginValue(
      loadExecutionAuthV2Keys()[0],
      "loadExecutionAuthV2Keys()[0]",
    ).key;
  } catch {
    throw new ExecutionAuthorizationError(
      "STEWARD_EXECUTION_AUTH_SECRET is required for execution authorization",
      "secret_unavailable",
    );
  }
  const key = hkdfSync(
    "sha256",
    secret,
    new TextEncoder().encode(EXECUTION_AUTHORIZATION_HKDF_SALT),
    new TextEncoder().encode(EXECUTION_AUTHORIZATION_HKDF_INFO),
    32,
  );
  return key instanceof ArrayBuffer ? new Uint8Array(key) : (key as Uint8Array);
}

function signaturePayload(
  authorization: ExecutionAuthorization,
): Record<string, unknown> {
  return {
    id: authorization.id,
    requestId: authorization.requestId,
    tenantId: authorization.tenantId,
    agentId: authorization.agentId,
    capability: authorization.capability,
    payloadDigest: authorization.payloadDigest,
    backend: authorization.backend,
    backendIdentityDigest: authorization.backendIdentityDigest ?? null,
    policyRevisionHash: authorization.policyRevisionHash ?? null,
    approvalId: authorization.approvalId ?? null,
    nonce: authorization.nonce,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    status: authorization.status,
    idempotencyKey: authorization.idempotencyKey ?? null,
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBuffer = encoder.encode(left);
  const rightBuffer = encoder.encode(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function base64Url(value: Uint8Array): string {
  const binary = Array.from(value, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
