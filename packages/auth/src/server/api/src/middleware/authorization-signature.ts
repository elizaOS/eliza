import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import {
  validateApiKey,
  verifyP256Signature,
} from "../../../auth/src/index.ts";
import {
  agentKeyQuorums,
  agentSigners,
  getDb,
  inArray,
  tenantAppClientSecrets,
  tenantAppClients,
  tenantRequestSigningKeys,
} from "../../../db/src/index.ts";
import { type EncryptedKey, KeyStore } from "../../../vault/src/index.ts";
import {
  type ApiResponse,
  type AppVariables,
  isValidTenantId,
} from "../services/context";
import { isSensitivePath } from "./sensitive-paths";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SIGNATURE_PREFIX = "v1=";
// Asymmetric (P-256 / ECDSA) request-signature scheme prefix. Carried in the
// SAME `X-Steward-Signature` header as the HMAC `v1=` scheme; the prefix is
// self-describing and is additionally cross-checked against the signer
// record's `keyType`. This keeps the HMAC path (and all its replay/freshness
// guards) untouched — a `v1=` signature never reaches the P-256 branch and
// vice-versa.
const P256_SIGNATURE_PREFIX = "p256=";
// Nested key-quorum recursion bounds. Both violations fail closed (deny).
const MAX_QUORUM_DEPTH = 8;
// Cap on members evaluated per request to bound work on adversarial graphs.
const MAX_QUORUM_MEMBERS_EVALUATED = 64;
// ±5min skew / TTL, matching request-expiry.ts and the webhook tolerance convention.
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TIMESTAMP_TTL_MS = 5 * 60 * 1000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Accept Unix seconds (SDK client.ts emits seconds) or ms, or an HTTP/ISO date string.
function parseHttpTime(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isSafeInteger(numeric)) return null;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export type AuthorizationSignatureOptions = {
  required?: boolean;
  secrets?: string[];
  appSecretResolver?: (request: Request) => Promise<string[]> | string[];
  tenantKeyStoreFactory?: (
    masterPassword: string,
    masterSalt: string | undefined,
    domain: "secret-vault",
  ) => Pick<KeyStore, "decrypt">;
};

function configuredSecrets(): string[] {
  const combined = [
    process.env.STEWARD_REQUEST_SIGNING_SECRETS,
    process.env.STEWARD_REQUEST_SIGNING_SECRET,
  ]
    .filter(Boolean)
    .join(",");
  return combined
    .split(",")
    .map((secret) => secret.trim())
    .filter(Boolean);
}

function parseAppId(
  value: string | undefined | null,
): { tenantId: string; clientId: string } | null {
  if (!value) return null;
  const index = value.lastIndexOf("/");
  if (index <= 0 || index >= value.length - 1) return null;
  const tenantId = value.slice(0, index);
  const clientId = value.slice(index + 1);
  // Tenant-id validity uses the SAME canonical validator as services/context.ts
  // (the app-secret path there parses the identical `tenantId/clientId` app-id),
  // eliminating the prior regex drift between the two copies.
  if (!isValidTenantId(tenantId)) return null;
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(clientId)) return null;
  return { tenantId, clientId };
}

function parseBasicAuth(
  value: string | undefined | null,
): { username: string; password: string } | null {
  if (!value?.startsWith("Basic ")) return null;
  let decoded = "";
  try {
    decoded = atob(value.slice(6));
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

async function appClientSecretSigningCandidates(
  request: Request,
): Promise<string[]> {
  const appId = request.headers.get("X-Steward-App-Id");
  const basic = parseBasicAuth(request.headers.get("Authorization"));
  if (!appId || !basic || basic.username !== appId) return [];

  const parsedAppId = parseAppId(appId);
  if (!parsedAppId) return [];

  const now = new Date();
  const rows = await getDb()
    .select({
      secretHash: tenantAppClientSecrets.secretHash,
      status: tenantAppClientSecrets.status,
      expiresAt: tenantAppClientSecrets.expiresAt,
      revokedAt: tenantAppClientSecrets.revokedAt,
      clientEnabled: tenantAppClients.enabled,
    })
    .from(tenantAppClientSecrets)
    .innerJoin(
      tenantAppClients,
      and(
        eq(tenantAppClients.tenantId, tenantAppClientSecrets.tenantId),
        eq(tenantAppClients.id, tenantAppClientSecrets.clientId),
      ),
    )
    .where(
      and(
        eq(tenantAppClientSecrets.tenantId, parsedAppId.tenantId),
        eq(tenantAppClientSecrets.clientId, parsedAppId.clientId),
        inArray(tenantAppClientSecrets.status, ["active", "retiring"]),
        eq(tenantAppClients.enabled, true),
      ),
    );

  const valid = rows.some((row) => {
    if (!row.clientEnabled || row.revokedAt) return false;
    if (row.expiresAt && row.expiresAt <= now) return false;
    return validateApiKey(basic.password, row.secretHash);
  });
  return valid ? [basic.password] : [];
}

// Tenant signing-key ids are server-generated UUIDs (tenant-config.ts uses
// `randomUUID()`), so a non-UUID header value can be rejected without a query.
const SIGNING_KEY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function tenantRequestSigningKeyCandidates(
  request: Request,
  createKeyStore: NonNullable<
    AuthorizationSignatureOptions["tenantKeyStoreFactory"]
  >,
): Promise<string[]> {
  const tenantId = request.headers.get("X-Steward-Tenant");
  if (!isValidTenantId(tenantId)) return [];

  // This middleware runs before route authentication, so unauthenticated input
  // must not trigger the signing-key KDF. Only a named, well-formed key ID can
  // reach the indexed lookup and subsequent decrypt.
  const keyId = request.headers.get("X-Steward-Signing-Key-Id");
  if (!keyId || !SIGNING_KEY_ID_PATTERN.test(keyId)) return [];
  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) return [];

  const now = new Date();
  const rows = await getDb()
    .select()
    .from(tenantRequestSigningKeys)
    .where(
      and(
        eq(tenantRequestSigningKeys.tenantId, tenantId),
        eq(tenantRequestSigningKeys.id, keyId),
        inArray(tenantRequestSigningKeys.status, ["active", "retiring"]),
      ),
    );
  // Defer KeyStore construction (itself a scrypt KDF) until a row exists, so
  // an unknown key id costs only the cheap lookup above.
  if (rows.length === 0) return [];
  const keyStore = createKeyStore(masterPassword, undefined, "secret-vault");
  return rows.flatMap((row) => {
    if (row.revokedAt) return [];
    if (row.expiresAt && row.expiresAt <= now) return [];
    const encrypted: EncryptedKey = {
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      tag: row.secretAuthTag,
      salt: row.secretSalt,
    };
    return [
      keyStore.decrypt(encrypted, {
        tenantId: row.tenantId,
        name: `request-signing-key:${row.id}`,
        version: 1,
      }),
    ];
  });
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(input: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256TextHex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  return sha256Hex(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

async function canonicalRequest(request: Request): Promise<string> {
  const url = new URL(request.url);
  const bodyHash = await sha256Hex(await request.clone().arrayBuffer());
  const authHash = await sha256TextHex(
    request.headers.get("authorization") ?? "",
  );
  const apiKeyHash = await sha256TextHex(
    request.headers.get("x-steward-key") ?? "",
  );
  const platformKeyHash = await sha256TextHex(
    request.headers.get("x-steward-platform-key") ?? "",
  );
  const signerIdHash = await sha256TextHex(
    request.headers.get("x-steward-signer-id") ?? "",
  );
  const signerSecretHash = await sha256TextHex(
    request.headers.get("x-steward-signer-secret") ?? "",
  );
  const quorumIdHash = await sha256TextHex(
    request.headers.get("x-steward-key-quorum-id") ?? "",
  );
  const quorumCredentialsHash = await sha256TextHex(
    request.headers.get("x-steward-key-quorum-credentials") ?? "",
  );
  return [
    "steward-request-signature-v1",
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    request.headers.get("x-steward-tenant") ?? "",
    authHash,
    apiKeyHash,
    platformKeyHash,
    signerIdHash,
    signerSecretHash,
    quorumIdHash,
    quorumCredentialsHash,
    request.headers.get("x-steward-request-timestamp") ?? "",
    request.headers.get("x-steward-request-expires-at") ?? "",
    request.headers.get("idempotency-key") ?? "",
    bodyHash,
  ].join("\n");
}

async function hmacSha256Hex(
  secret: string,
  canonical: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extractSignature(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith(SIGNATURE_PREFIX)) return null;
  const signature = trimmed.slice(SIGNATURE_PREFIX.length).trim();
  return /^[0-9a-f]{64}$/i.test(signature) ? signature.toLowerCase() : null;
}

/**
 * Extract an asymmetric P-256 signature from the shared `X-Steward-Signature`
 * header. Returns the raw base64/base64url/hex signature (scheme prefix
 * stripped) or null when the header is absent / not the `p256=` scheme /
 * obviously malformed. The actual cryptographic check happens in
 * `verifyP256Signature` (which also fails closed).
 */
function extractP256Signature(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith(P256_SIGNATURE_PREFIX)) return null;
  const signature = trimmed.slice(P256_SIGNATURE_PREFIX.length).trim();
  if (!signature) return null;
  // Allow base64 / base64url / hex characters only; bound length so a giant
  // header can't be used to burn CPU before the verify call rejects it.
  if (signature.length > 1024) return null;
  return /^[A-Za-z0-9+/_=-]+$/.test(signature) ? signature : null;
}

/**
 * Role gating, mirroring `signerHasPermission` in routes/vault.ts (kept in sync
 * deliberately — vault.ts owns the canonical copy; this is the defense-in-depth
 * copy applied at the request-signature layer for the asymmetric path). A
 * signer/quorum may only authorize an action covered by its `permissions`.
 */
function signerHasPermission(
  permissions: readonly string[],
  required: string,
): boolean {
  const family = required.includes("_")
    ? `${required.split("_")[0]}:*`
    : `${required}:*`;
  return (
    permissions.includes("*") ||
    (required.startsWith("sign_") && permissions.includes("sign:*")) ||
    permissions.includes(required) ||
    permissions.includes(family)
  );
}

/**
 * Coarse path → required-permission mapping for middleware-layer role gating on
 * P-256 authorized requests. This is intentionally conservative: it only
 * constrains the well-known signing/transfer families. Routes that perform
 * finer-grained checks (vault.ts `requireSignerPermission`) still run and are
 * the authoritative gate; returning null here means "no extra constraint at
 * this layer" rather than allow-all.
 */
function requiredPermissionForPath(path: string): string | null {
  if (path.startsWith("/vault")) {
    const segments = path.split("/").filter(Boolean);
    const action = segments[2] ?? "";
    if (action === "sign") return "sign_transaction";
    if (action === "sign-bitcoin-psbt") return "sign_transaction";
    if (action === "sign-message") return "sign_message";
    if (action === "sign-raw-hash" || action === "sign-raw-digest")
      return "sign_raw_hash";
    if (action === "sign-typed-data") return "sign_typed_data";
    if (action === "sign-user-operation") return "sign_user_operation";
    if (action === "sign-authorization") return "sign_authorization";
    if (action === "sign-solana") return "solana_transaction";
    if (action === "actions" && segments[3] === "transfer")
      return "wallet_action_transfer";
    if (action === "actions" && segments[3] === "send-calls")
      return "wallet_action_send_calls";
  }
  if (path.startsWith("/user")) {
    if (path.includes("/sign-raw") || path.endsWith("/sign_raw_hash"))
      return "sign_raw_hash";
    if (path.includes("/sign")) return "sign_message";
    if (path.includes("/transfer")) return "wallet_action_transfer";
  }
  if (path.startsWith("/trade") || path.startsWith("/v1/trade")) return "trade";
  return null;
}

/** Active P-256 signer record loaded for request-signature verification. */
type P256SignerRecord = {
  id: string;
  publicKey: string;
  permissions: string[];
};

/**
 * Load active P-256 signer records for an agent, keyed by signer id. Only
 * `keyType="p256"` signers with a non-empty `publicKey` and `status="active"`
 * are returned, so HMAC signers and disabled signers are ignored (fail closed).
 */
async function loadActiveP256Signers(
  tenantId: string,
  agentId: string,
): Promise<Map<string, P256SignerRecord>> {
  const rows = await getDb()
    .select({
      id: agentSigners.id,
      status: agentSigners.status,
      keyType: agentSigners.keyType,
      publicKey: agentSigners.publicKey,
      permissions: agentSigners.permissions,
    })
    .from(agentSigners)
    .where(
      and(
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, agentId),
      ),
    );
  const map = new Map<string, P256SignerRecord>();
  for (const row of rows) {
    if (row.status !== "active" || row.keyType !== "p256" || !row.publicKey)
      continue;
    map.set(row.id, {
      id: row.id,
      publicKey: row.publicKey,
      permissions: row.permissions ?? [],
    });
  }
  return map;
}

type QuorumRecord = {
  id: string;
  threshold: number;
  memberSignerIds: string[];
  memberQuorumIds: string[];
  permissions: string[];
  status: string;
};

/** Load all active quorums for an agent, keyed by id (for nested resolution). */
async function loadActiveQuorums(
  tenantId: string,
  agentId: string,
): Promise<Map<string, QuorumRecord>> {
  const rows = await getDb()
    .select({
      id: agentKeyQuorums.id,
      threshold: agentKeyQuorums.threshold,
      memberSignerIds: agentKeyQuorums.memberSignerIds,
      memberQuorumIds: agentKeyQuorums.memberQuorumIds,
      permissions: agentKeyQuorums.permissions,
      status: agentKeyQuorums.status,
    })
    .from(agentKeyQuorums)
    .where(
      and(
        eq(agentKeyQuorums.tenantId, tenantId),
        eq(agentKeyQuorums.agentId, agentId),
      ),
    );
  const map = new Map<string, QuorumRecord>();
  for (const row of rows) {
    if (row.status !== "active") continue;
    map.set(row.id, {
      id: row.id,
      threshold: row.threshold,
      memberSignerIds: row.memberSignerIds ?? [],
      memberQuorumIds: row.memberQuorumIds ?? [],
      permissions: row.permissions ?? [],
      status: row.status,
    });
  }
  return map;
}

type QuorumEvalContext = {
  quorums: Map<string, QuorumRecord>;
  /** signerId → whether that signer's P-256 signature over the canonical string verified. */
  verifiedSigners: Map<string, boolean>;
  requiredPermission: string | null;
  /**
   * Memoized satisfying leaf-signer sets per quorum id. A quorum can be reached
   * through multiple parent paths; callers must reason over the distinct
   * underlying signers, not merely a boolean satisfied/not-satisfied flag.
   */
  memo: Map<string, Array<Set<string>>>;
};

/**
 * Recursively evaluate whether a quorum is satisfied. A quorum is satisfied iff
 * the count of satisfied members (a verified leaf signer OR a satisfied child
 * quorum) is ≥ its threshold.
 *
 * Fail-closed guarantees:
 *  - Depth beyond MAX_QUORUM_DEPTH → false.
 *  - Cycle (a quorum that is its own ancestor on the current path) → false.
 *  - Missing/unknown/inactive child quorum → that member simply does not count.
 *  - Non-positive or unsatisfiable threshold → false.
 */
function quorumSatisfactionOptions(
  quorumId: string,
  ctx: QuorumEvalContext,
  ancestry: Set<string>,
  depth: number,
): Array<Set<string>> {
  if (depth > MAX_QUORUM_DEPTH) return [];
  if (ancestry.has(quorumId)) return []; // cycle → deny
  const cached = ctx.memo.get(quorumId);
  if (cached !== undefined) return cached;

  const quorum = ctx.quorums.get(quorumId);
  if (!quorum) return [];
  if (!Number.isInteger(quorum.threshold) || quorum.threshold <= 0) return [];
  if (
    ctx.requiredPermission &&
    !signerHasPermission(quorum.permissions, ctx.requiredPermission)
  ) {
    return [];
  }

  const nextAncestry = new Set(ancestry);
  nextAncestry.add(quorumId);

  const memberOptions: Array<Set<string>> = [];
  for (const signerId of quorum.memberSignerIds) {
    if (ctx.verifiedSigners.get(signerId) === true)
      memberOptions.push(new Set([signerId]));
  }
  for (const childId of quorum.memberQuorumIds) {
    memberOptions.push(
      ...quorumSatisfactionOptions(childId, ctx, nextAncestry, depth + 1),
    );
  }

  type State = { count: number; signers: Set<string> };
  let states: State[] = [{ count: 0, signers: new Set() }];
  for (const option of memberOptions) {
    const nextStates = states.map((state) => ({
      count: state.count + 1,
      signers: new Set([...state.signers, ...option]),
    }));
    states = dedupeQuorumStates([...states, ...nextStates]);
    if (states.length > MAX_QUORUM_MEMBERS_EVALUATED) {
      states = states.slice(0, MAX_QUORUM_MEMBERS_EVALUATED);
    }
  }

  const options = dedupeSignerSets(
    states
      .filter(
        (state) =>
          state.count >= quorum.threshold && state.signers.size >= state.count,
      )
      .map((state) => state.signers),
  );
  ctx.memo.set(quorumId, options);
  return options;
}

function signerSetKey(signers: Set<string>): string {
  return [...signers].sort().join("\0");
}

function dedupeSignerSets(sets: Array<Set<string>>): Array<Set<string>> {
  const seen = new Set<string>();
  const result: Array<Set<string>> = [];
  for (const set of sets) {
    const key = signerSetKey(set);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(set);
  }
  return result;
}

function dedupeQuorumStates(
  states: Array<{ count: number; signers: Set<string> }>,
) {
  const seen = new Set<string>();
  const result: Array<{ count: number; signers: Set<string> }> = [];
  for (const state of states) {
    const key = `${state.count}:${signerSetKey(state.signers)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(state);
  }
  return result;
}

function evaluateQuorum(
  quorumId: string,
  ctx: QuorumEvalContext,
  ancestry: Set<string>,
  depth: number,
): boolean {
  return quorumSatisfactionOptions(quorumId, ctx, ancestry, depth).length > 0;
}

/**
 * Derive the agent id an asymmetric request targets. The middleware runs before
 * route-param binding, so we parse the well-known `/vault/<agentId>/...` and
 * `/user/.../wallet/...` shapes from the path and fall back to an explicit
 * `X-Steward-Agent-Id` header. Returns null when no agent scope can be
 * established (caller fails closed).
 */
function resolveAgentId(
  c: Context<{ Variables: AppVariables }>,
): string | null {
  const header = c.req.header("X-Steward-Agent-Id")?.trim();
  if (header && /^[a-zA-Z0-9_-]{1,64}$/.test(header)) return header;
  const segments = c.req.path.split("/").filter(Boolean);
  if (
    segments[0] === "vault" &&
    segments[1] &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(segments[1])
  ) {
    return segments[1];
  }
  return null;
}

type P256VerificationResult = { ok: true } | { ok: false; response: Response };

function p256Deny(
  c: Context<{ Variables: AppVariables }>,
  message: string,
  status: 400 | 401 | 403,
): P256VerificationResult {
  return {
    ok: false,
    response: c.json<ApiResponse>({ ok: false, error: message }, status),
  };
}

/**
 * Verify a P-256 (`p256=`) signed request. Supports two modes, selected by
 * headers, mirroring the HMAC delegated/quorum conventions:
 *   - Single signer: `X-Steward-Signer-Id` names an active `keyType="p256"`
 *     signer; its registered public key must verify `signature` over the
 *     canonical string, and its role must permit the action.
 *   - Key quorum: `X-Steward-Key-Quorum-Id` + `X-Steward-Key-Quorum-Credentials`
 *     (`[{ "signerId", "signature" }]`). Each credential's P-256 signature is
 *     verified independently against that member's registered key over the
 *     SAME canonical string; the quorum (with nested children) must then reach
 *     threshold. Depth/cycle bounded — both deny.
 *
 * Every failure denies (fail closed).
 */
async function verifyP256AuthorizedRequest(
  c: Context<{ Variables: AppVariables }>,
  signature: string,
): Promise<P256VerificationResult> {
  const tenantId = c.req.header("X-Steward-Tenant")?.trim();
  if (!isValidTenantId(tenantId)) {
    return p256Deny(
      c,
      "Asymmetric authorization requires X-Steward-Tenant",
      400,
    );
  }
  const agentId = resolveAgentId(c);
  if (!agentId) {
    return p256Deny(
      c,
      "Could not resolve agent scope for asymmetric authorization",
      400,
    );
  }

  // Canonical string for the asymmetric scheme. Built from the SAME field set
  // and ordering as the HMAC path, but with the per-signer secret and the
  // quorum-credentials header excluded: those carry the ECDSA signatures
  // themselves, so signing over them would be self-referential. Every signer in
  // a quorum therefore signs the identical "bare request" canonical, which is
  // exactly what makes nested M-of-N verification well-defined.
  const url = new URL(c.req.url, "https://steward.local");
  const canonical = await buildAuthorizationCanonicalString({
    method: c.req.method,
    url: `${url.pathname}${url.search}`,
    tenantId,
    authorization: c.req.header("authorization") ?? "",
    apiKey: c.req.header("x-steward-key") ?? "",
    platformKey: c.req.header("x-steward-platform-key") ?? "",
    signerId: c.req.header("x-steward-signer-id") ?? "",
    quorumId: c.req.header("x-steward-key-quorum-id") ?? "",
    timestamp: c.req.header("x-steward-request-timestamp") ?? "",
    expiresAt: c.req.header("x-steward-request-expires-at") ?? "",
    idempotencyKey: c.req.header("idempotency-key") ?? "",
    body: await c.req.raw.clone().arrayBuffer(),
  });
  const requiredPermission = requiredPermissionForPath(c.req.path);
  const quorumId = c.req.header("X-Steward-Key-Quorum-Id")?.trim();

  // ── Single signer ────────────────────────────────────────────────────────
  if (!quorumId) {
    const signerId = c.req.header("X-Steward-Signer-Id")?.trim();
    if (!signerId) {
      return p256Deny(
        c,
        "Asymmetric authorization requires a signer id or key quorum id",
        400,
      );
    }
    const signers = await loadActiveP256Signers(tenantId, agentId);
    const signer = signers.get(signerId);
    if (!signer) {
      return p256Deny(c, "Unknown or inactive P-256 signer", 403);
    }
    const ok = await verifyP256Signature(
      signer.publicKey,
      canonical,
      signature,
    );
    if (!ok) {
      return p256Deny(c, "Invalid request signature", 401);
    }
    if (
      requiredPermission &&
      !signerHasPermission(signer.permissions, requiredPermission)
    ) {
      return p256Deny(c, `Signer lacks ${requiredPermission} permission`, 403);
    }
    return { ok: true };
  }

  // ── Key quorum (possibly nested) ───────────────────────────────────────────
  const credentialsHeader = c.req.header("X-Steward-Key-Quorum-Credentials");
  if (!credentialsHeader) {
    return p256Deny(
      c,
      "Key quorum signing requires X-Steward-Key-Quorum-Credentials",
      403,
    );
  }
  let credentials: Array<{ signerId: string; signature: string }>;
  try {
    const parsed = JSON.parse(credentialsHeader) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.length > MAX_QUORUM_MEMBERS_EVALUATED
    ) {
      throw new Error("invalid quorum credential count");
    }
    credentials = parsed.map((entry) => {
      if (!entry || typeof entry !== "object")
        throw new Error("invalid quorum credential");
      const value = entry as Record<string, unknown>;
      if (typeof value.signerId !== "string" || !value.signerId.trim()) {
        throw new Error("invalid quorum signer id");
      }
      if (typeof value.signature !== "string" || !value.signature.trim()) {
        throw new Error("invalid quorum signature");
      }
      return {
        signerId: value.signerId.trim(),
        signature: value.signature.trim(),
      };
    });
  } catch {
    return p256Deny(c, "Invalid X-Steward-Key-Quorum-Credentials header", 400);
  }

  const uniqueSignerIds = new Set(
    credentials.map((credential) => credential.signerId),
  );
  if (uniqueSignerIds.size !== credentials.length) {
    return p256Deny(
      c,
      "Key quorum credentials must use unique signer ids",
      400,
    );
  }

  const quorums = await loadActiveQuorums(tenantId, agentId);
  const rootQuorum = quorums.get(quorumId);
  if (!rootQuorum) {
    return p256Deny(c, "Invalid or inactive key quorum", 403);
  }
  if (
    requiredPermission &&
    !signerHasPermission(rootQuorum.permissions, requiredPermission)
  ) {
    return p256Deny(
      c,
      `Key quorum lacks ${requiredPermission} permission`,
      403,
    );
  }

  // Verify each presented credential's P-256 signature against that signer's
  // registered key over the canonical string. A signer counts as "verified"
  // only on a cryptographically valid signature.
  const signers = await loadActiveP256Signers(tenantId, agentId);
  const verifiedSigners = new Map<string, boolean>();
  for (const credential of credentials) {
    const signer = signers.get(credential.signerId);
    if (!signer) {
      verifiedSigners.set(credential.signerId, false);
      continue;
    }
    if (
      requiredPermission &&
      !signerHasPermission(signer.permissions, requiredPermission)
    ) {
      verifiedSigners.set(credential.signerId, false);
      continue;
    }
    const ok = await verifyP256Signature(
      signer.publicKey,
      canonical,
      credential.signature,
    );
    verifiedSigners.set(credential.signerId, ok);
  }

  const satisfied = evaluateQuorum(
    quorumId,
    { quorums, verifiedSigners, requiredPermission, memo: new Map() },
    new Set(),
    0,
  );
  if (!satisfied) {
    return p256Deny(c, "Key quorum threshold was not met", 403);
  }
  return { ok: true };
}

export async function createAuthorizationSignature(
  input: {
    method: string;
    url: string;
    tenantId?: string;
    authorization?: string;
    apiKey?: string;
    platformKey?: string;
    signerId?: string;
    signerSecret?: string;
    quorumId?: string;
    quorumCredentials?: string;
    timestamp?: string;
    expiresAt?: string;
    idempotencyKey?: string;
    body?: string | ArrayBuffer;
  },
  secret: string,
): Promise<string> {
  let body: ArrayBuffer;
  if (typeof input.body === "string") {
    const bytes = new TextEncoder().encode(input.body);
    body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  } else {
    body = input.body ?? new ArrayBuffer(0);
  }
  const canonical = await buildAuthorizationCanonicalString({ ...input, body });
  return `${SIGNATURE_PREFIX}${await hmacSha256Hex(secret, canonical)}`;
}

export type AuthorizationCanonicalInput = {
  method: string;
  url: string;
  tenantId?: string;
  authorization?: string;
  apiKey?: string;
  platformKey?: string;
  signerId?: string;
  signerSecret?: string;
  quorumId?: string;
  quorumCredentials?: string;
  timestamp?: string;
  expiresAt?: string;
  idempotencyKey?: string;
  body?: string | ArrayBuffer;
};

/**
 * Build the exact canonical request string that BOTH the HMAC and the P-256
 * verification paths sign. Exported so asymmetric clients (and tests) can
 * reproduce the precise string the middleware reconstructs from the request —
 * keeping the two mechanisms byte-for-byte interchangeable. Changing this
 * changes the wire format for both schemes simultaneously.
 */
export async function buildAuthorizationCanonicalString(
  input: AuthorizationCanonicalInput,
): Promise<string> {
  let body: ArrayBuffer;
  if (typeof input.body === "string") {
    const bytes = new TextEncoder().encode(input.body);
    body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  } else {
    body = input.body ?? new ArrayBuffer(0);
  }
  const bodyHash = await sha256Hex(body);
  const authHash = await sha256TextHex(input.authorization ?? "");
  const apiKeyHash = await sha256TextHex(input.apiKey ?? "");
  const platformKeyHash = await sha256TextHex(input.platformKey ?? "");
  const signerIdHash = await sha256TextHex(input.signerId ?? "");
  const signerSecretHash = await sha256TextHex(input.signerSecret ?? "");
  const quorumIdHash = await sha256TextHex(input.quorumId ?? "");
  const quorumCredentialsHash = await sha256TextHex(
    input.quorumCredentials ?? "",
  );
  const url = new URL(input.url, "https://steward.local");
  return [
    "steward-request-signature-v1",
    input.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    input.tenantId ?? "",
    authHash,
    apiKeyHash,
    platformKeyHash,
    signerIdHash,
    signerSecretHash,
    quorumIdHash,
    quorumCredentialsHash,
    input.timestamp ?? "",
    input.expiresAt ?? "",
    input.idempotencyKey ?? "",
    bodyHash,
  ].join("\n");
}

export function authorizationSignature(
  options?: AuthorizationSignatureOptions,
) {
  const required =
    options?.required ??
    (process.env.STEWARD_REQUIRE_AUTH_SIGNATURE === "true" ||
      process.env.NODE_ENV === "production");
  const secrets = options?.secrets ?? configuredSecrets();
  const appSecretResolver =
    options?.appSecretResolver ?? appClientSecretSigningCandidates;
  const tenantKeyStoreFactory =
    options?.tenantKeyStoreFactory ??
    ((masterPassword, masterSalt, domain) =>
      new KeyStore(masterPassword, masterSalt, domain));
  const maxClockSkewMs = parsePositiveInt(
    process.env.STEWARD_REQUEST_EXPIRY_MAX_SKEW_MS,
    DEFAULT_MAX_CLOCK_SKEW_MS,
  );
  const timestampTtlMs = parsePositiveInt(
    process.env.STEWARD_REQUEST_TIMESTAMP_TTL_MS,
    DEFAULT_TIMESTAMP_TTL_MS,
  );

  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    if (
      !MUTATING_METHODS.has(c.req.method.toUpperCase()) ||
      !isSensitivePath(c.req.path)
    ) {
      return next();
    }

    const rawSignature = c.req.header("X-Steward-Signature");
    if (!rawSignature) {
      if (!required) return next();
      return c.json<ApiResponse>(
        { ok: false, error: "X-Steward-Signature header required" },
        401,
      );
    }

    // Scheme selection: the SAME header carries either an HMAC `v1=` signature
    // or an asymmetric P-256 `p256=` signature. The prefix is self-describing;
    // the P-256 path additionally binds to a registered signer/quorum record.
    const p256Signature = extractP256Signature(rawSignature);
    const signature = p256Signature ? null : extractSignature(rawSignature);
    if (!signature && !p256Signature) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid X-Steward-Signature header" },
        400,
      );
    }
    const timestampHeader = c.req.header("X-Steward-Request-Timestamp");
    const expiresAtHeader = c.req.header("X-Steward-Request-Expires-At");
    if (!timestampHeader && !expiresAtHeader) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Signed requests require a timestamp or expiry header",
        },
        400,
      );
    }
    // Enforce freshness here so a captured signed request cannot be replayed
    // indefinitely on paths that lack idempotency-store enforcement.
    const currentTime = Date.now();
    const expiresAt = parseHttpTime(expiresAtHeader);
    if (expiresAtHeader && expiresAt === null) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid X-Steward-Request-Expires-At header" },
        400,
      );
    }
    if (expiresAt !== null) {
      if (expiresAt + maxClockSkewMs <= currentTime) {
        return c.json<ApiResponse>(
          { ok: false, error: "Signed request has expired" },
          401,
        );
      }
      if (expiresAt - currentTime > timestampTtlMs + maxClockSkewMs) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: "Signed request expiry is too far in the future",
          },
          400,
        );
      }
    }
    const timestamp = parseHttpTime(timestampHeader);
    if (timestampHeader && timestamp === null) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid X-Steward-Request-Timestamp header" },
        400,
      );
    }
    if (timestamp !== null) {
      if (timestamp - currentTime > maxClockSkewMs) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: "Signed request timestamp is too far in the future",
          },
          400,
        );
      }
      if (currentTime - timestamp > timestampTtlMs + maxClockSkewMs) {
        return c.json<ApiResponse>(
          { ok: false, error: "Signed request timestamp is stale" },
          401,
        );
      }
    }
    if (!c.req.header("Idempotency-Key")) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Signed requests require an Idempotency-Key header",
        },
        400,
      );
    }

    // ── Asymmetric P-256 authorization-key path ────────────────────────────
    // Verifies the request signature against a registered secp256r1 public key
    // (single signer) or a nested M-of-N key quorum, over the SAME canonical
    // string the HMAC path uses. Fail closed on every branch.
    if (p256Signature) {
      const verified = await verifyP256AuthorizedRequest(c, p256Signature);
      if (!verified.ok) return verified.response;
      c.set("requestSignatureVerified", true);
      return next();
    }
    if (!signature) {
      // Defensive: should be unreachable given the earlier scheme check.
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid X-Steward-Signature header" },
        400,
      );
    }

    const signingKeyId = c.req.header("X-Steward-Signing-Key-Id");
    // Only a request that NAMES a tenant signing key id pays for the tenant-key
    // lookup (and, for a known id, the scrypt KDF + decrypt). Key-id-less
    // requests fall through to the static/app-secret candidates and never
    // trigger tenant-key work — closing the unauthenticated CPU-amplification
    // DoS the global SEC-010 mount exposed.
    const tenantKeySecrets = signingKeyId
      ? await tenantRequestSigningKeyCandidates(
          c.req.raw,
          tenantKeyStoreFactory,
        )
      : [];
    if (signingKeyId && tenantKeySecrets.length === 0) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid signing key id" },
        401,
      );
    }
    const candidateSecrets = signingKeyId
      ? tenantKeySecrets
      : [...secrets, ...(await appSecretResolver(c.req.raw))];
    if (candidateSecrets.length === 0) {
      return c.json<ApiResponse>(
        { ok: false, error: "Request signing is not configured" },
        500,
      );
    }

    const canonical = await canonicalRequest(c.req.raw);
    const expectedSignatures = await Promise.all(
      candidateSecrets.map((secret) => hmacSha256Hex(secret, canonical)),
    );
    const valid = expectedSignatures.some((expected) =>
      timingSafeEqualHex(expected, signature),
    );
    if (!valid) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid request signature" },
        401,
      );
    }

    c.set("requestSignatureVerified", true);
    return next();
  });
}

export const requireAuthorizationSignature = authorizationSignature({
  required: true,
});
