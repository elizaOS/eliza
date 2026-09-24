/**
 * KMS routes — the Steward side of the Eliza `StewardKmsAdapter` wire contract.
 *
 * Mount: app.route("/v1/kms", kmsRoutes)  (behind tenantAuth in app.ts)
 *
 * The client contract is FROZEN in the Eliza repo
 * (packages/security/src/kms/steward-adapter.ts). Steward implements TO that
 * spec; the shapes below must not drift:
 *
 *   POST   /v1/kms/keys                          { keyId, rotationDays? } -> { keyId, version }
 *   POST   /v1/kms/keys/:keyId/rotate            -> { keyId, newVersion }
 *   GET    /v1/kms/keys/:keyId/versions          -> { versions: number[] }
 *   POST   /v1/kms/keys/:keyId/encrypt           { plaintext_b64, aad_b64? } -> { ciphertext_b64, nonce_b64, auth_tag_b64, version }
 *   POST   /v1/kms/keys/:keyId/decrypt           { ciphertext_b64, nonce_b64, auth_tag_b64, aad_b64?, version? } -> { plaintext_b64 }
 *   POST   /v1/kms/keys/:keyId/hmac              { data_b64 } -> { tag_b64 }
 *   POST   /v1/kms/keys/:keyId/hmac/verify       { data_b64, tag_b64 } -> { valid }
 *   POST   /v1/kms/keys/:keyId/sign              { data_b64, algorithm } -> { signature_b64, algorithm, version }
 *   POST   /v1/kms/keys/:keyId/verify            { data_b64, signature_b64, algorithm } -> { valid }
 *   GET    /v1/kms/keys/:keyId/public            -> { public_key_b64, algorithm }
 *
 * Success bodies are TOP-LEVEL JSON (the adapter reads fields directly off the
 * parsed object). Error bodies use Steward's ApiResponse `{ ok:false, error }`
 * — the adapter reads `parsed.error` on non-2xx and carries the HTTP status
 * (404 = key-unavailable classification on the Eliza side).
 *
 * AUTH + SCOPING (fail-closed):
 *   - Agent-token bearer auth ONLY (the existing short-lived agent-token plane
 *     verified by tenantAuth). Session JWTs, tenant API keys, and app secrets
 *     are DENIED — KMS material is always agent-scoped, so there must always
 *     be an agent principal. Expired/invalid tokens are 401s in tenantAuth
 *     before this router runs.
 *   - Per-agent namespace: the wire `keyId` is namespaced internally as the
 *     secret name `kms/<agentId>/<keyId>` where agentId comes from the VERIFIED
 *     token (never the request). Agent A can never address agent B's material:
 *     B's lookups resolve inside B's own namespace, so A's keys are 404 to B,
 *     and a keyId collision creates independent key material.
 *
 * STORAGE (extend, no forks): key roots are rows in the EXISTING `secrets`
 * table, sealed by the EXISTING SecretVault (AES-256-GCM under
 * STEWARD_MASTER_PASSWORD, domain-separated "secret-vault" root). One row per
 * key VERSION via SecretVault's native rotation (rotate soft-deletes the prior
 * version; KMS deliberately reads historical versions so rotation never bricks
 * old ciphertext — standard KMS decrypt-old/encrypt-new semantics). Working
 * keys (AES/HMAC/Ed25519 seed) are derived per use-domain from the version
 * root via HKDF-SHA256, mirroring Eliza's LocalKmsAdapter derivation model.
 * Key material NEVER appears in responses or audit events.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign as nodeSign,
  verify as nodeVerify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import {
  getDb,
  type Secret,
  secrets as secretRows,
} from "../../../db/src/index.ts";
import { SecretVault } from "../../../vault/src/index.ts";
import { type AuditEventInput, writeAuditEvent } from "../services/audit";
import {
  AGENT_SCOPE,
  type ApiResponse,
  type AppVariables,
  hasAgentTokenScope,
  MASTER_PASSWORD,
  safeJsonParse,
  setNoStoreHeaders,
} from "../services/context";

export const kmsRoutes = new Hono<{ Variables: AppVariables }>();

// HKDF domain for deriving per-use working keys from a version root. Versioned
// so a future derivation change can coexist with old material.
const HKDF_DOMAIN = "steward.kms.v1";
const AEAD_NONCE_BYTES = 12;
const AEAD_TAG_BYTES = 16;
// keyId charset: mirrors Eliza's key-namespace ids (e.g. "org:acme:dek/v2").
// Length keeps the namespaced secret name within the 255-char name column.
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_/.-]{0,179}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Only ed25519 is implemented server-side; rsa-pss-sha256 fails closed (400)
// rather than pretending — the adapter surfaces the error loudly.
const SUPPORTED_ALGORITHM = "ed25519";

// Lazily initialised so context.ts can set MASTER_PASSWORD first (same pattern
// as routes/secrets.ts — the SAME SecretVault custody plane, not a fork).
let _secretVault: SecretVault | undefined;
function getSecretVault(): SecretVault {
  _secretVault ??= new SecretVault(MASTER_PASSWORD);
  return _secretVault;
}

kmsRoutes.use("*", async (c, next) => {
  setNoStoreHeaders(c);
  await next();
});

// ── auth gate: verified agent principal or DENY ──────────────────────────────

interface KmsPrincipal {
  tenantId: string;
  agentId: string;
}

/**
 * Resolve the verified agent principal or return null (caller DENIES with 403).
 * tenantAuth has already verified the bearer token, resolved the tenant, and
 * confirmed the agent row exists for that tenant (ensureAgentForTenant); this
 * gate additionally REQUIRES the principal to be an agent token carrying the
 * standard agent scope — a proxy-only token (api:proxy) or any human/tenant
 * credential is denied. Fail-closed on every missing piece.
 */
function requireKmsAgent(
  c: Context<{ Variables: AppVariables }>,
): KmsPrincipal | null {
  if (c.get("authType") !== "agent-token") return null;
  const tenantId = c.get("tenantId");
  const agentId = c.get("agentScope");
  if (!tenantId || !agentId) return null;
  if (!hasAgentTokenScope(c.get("agentScopes"), AGENT_SCOPE)) return null;
  return { tenantId, agentId };
}

function deny(c: Context<{ Variables: AppVariables }>): Response {
  return c.json<ApiResponse>(
    { ok: false, error: "KMS requires an agent token" },
    403,
  );
}

function badRequest(
  c: Context<{ Variables: AppVariables }>,
  error: string,
): Response {
  return c.json<ApiResponse>({ ok: false, error }, 400);
}

// ── wire helpers ─────────────────────────────────────────────────────────────

function parseKeyIdParam(
  c: Context<{ Variables: AppVariables }>,
): string | null {
  const keyId = c.req.param("keyId");
  if (typeof keyId !== "string" || !KEY_ID_RE.test(keyId)) return null;
  return keyId;
}

function secretNameFor(agentId: string, keyId: string): string {
  return `kms/${agentId}/${keyId}`;
}

/**
 * Strict base64 decode: canonical padded base64 only (charset + length gate,
 * then a re-encode round-trip so nothing Buffer would silently mangle passes).
 * Returns null on ANY deviation — the caller responds 400 (malformed DENY).
 */
function decodeB64Field(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  // empty string is canonical base64 for zero bytes (legal AEAD/HMAC input)
  if (!B64_RE.test(value) || value.length % 4 !== 0) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return null;
  return decoded;
}

async function auditKms(
  c: Context<{ Variables: AppVariables }>,
  principal: KmsPrincipal,
  action: string,
  keyId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const event: AuditEventInput = {
    tenantId: principal.tenantId,
    actorType: "agent",
    actorId: principal.agentId,
    action,
    resourceType: "kms-key",
    resourceId: keyId,
    // keys-never-values: metadata carries identifiers/versions only.
    metadata: { keyId, ...metadata },
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  };
  await writeAuditEvent(event);
}

// ── key-material access (existing secrets table, per-version rows) ───────────

/** All version rows for a key, INCLUDING soft-deleted (historical) versions. */
async function listKeyRows(tenantId: string, name: string): Promise<Secret[]> {
  return getDb()
    .select()
    .from(secretRows)
    .where(and(eq(secretRows.tenantId, tenantId), eq(secretRows.name, name)))
    .orderBy(asc(secretRows.version));
}

/** The CURRENT (non-deleted) version row, or null if the key does not exist. */
function currentRow(rows: Secret[]): Secret | null {
  return rows.find((row) => row.deletedAt === null) ?? null;
}

/**
 * Decrypt the 32-byte root for a specific version row via the EXISTING
 * SecretVault (handles domain-separated + legacy KDF roots). Historical
 * (soft-deleted) rows stay decryptable by design: KMS rotation must not brick
 * ciphertext produced under an old version.
 */
async function rootForRow(
  vault: SecretVault,
  tenantId: string,
  row: Secret,
): Promise<Buffer> {
  const hex = await vault.exerciseSecretRow(
    tenantId,
    row,
    (plaintext) => plaintext,
  );
  const root = Buffer.from(hex, "hex");
  if (root.length !== 32) throw new Error("kms root key corrupted");
  return root;
}

function deriveKey(
  root: Buffer,
  use: "sym" | "hmac" | "sign",
  keyId: string,
  version: number,
): Buffer {
  const info = Buffer.from(
    `${HKDF_DOMAIN}|${use}|${keyId}|v${version}`,
    "utf8",
  );
  return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), info, 32));
}

function ed25519PrivateKey(root: Buffer, keyId: string, version: number) {
  const seed = deriveKey(root, "sign", keyId, version);
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

function ed25519PublicRaw(
  root: Buffer,
  keyId: string,
  version: number,
): Buffer {
  const spki = createPublicKey(ed25519PrivateKey(root, keyId, version)).export({
    format: "der",
    type: "spki",
  });
  return Buffer.from(spki.subarray(spki.length - 32));
}

// ── routes ───────────────────────────────────────────────────────────────────

/** POST /keys — get-or-create. { keyId, rotationDays? } -> { keyId, version } */
kmsRoutes.post("/keys", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);

  const body = await safeJsonParse<{ keyId?: unknown }>(c);
  if (!body) return badRequest(c, "Invalid JSON in request body");
  const keyId = body.keyId;
  if (typeof keyId !== "string" || !KEY_ID_RE.test(keyId)) {
    return badRequest(
      c,
      "keyId is required and must match the KMS key-id charset",
    );
  }

  const name = secretNameFor(principal.agentId, keyId);
  const existing = currentRow(await listKeyRows(principal.tenantId, name));
  if (existing) {
    return c.json({ keyId, version: existing.version });
  }

  const rootHex = randomBytes(32).toString("hex");
  try {
    const created = await getSecretVault().createSecret(
      principal.tenantId,
      name,
      rootHex,
      {
        description: `KMS key material for agent ${principal.agentId}`,
      },
    );
    await auditKms(c, principal, "kms.key.created", keyId, {
      version: created.version,
    });
    return c.json({ keyId, version: created.version });
  } catch {
    // lost a create race — the unique (tenant, name, version) index rejected the
    // duplicate. Re-read; fail closed if it still isn't there.
    const raced = currentRow(await listKeyRows(principal.tenantId, name));
    if (raced) return c.json({ keyId, version: raced.version });
    return c.json<ApiResponse>(
      { ok: false, error: "Failed to create KMS key" },
      500,
    );
  }
});

/** POST /keys/:keyId/rotate -> { keyId, newVersion } */
kmsRoutes.post("/keys/:keyId/rotate", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);
  const keyId = parseKeyIdParam(c);
  if (!keyId) return badRequest(c, "invalid keyId");

  const name = secretNameFor(principal.agentId, keyId);
  const existing = currentRow(await listKeyRows(principal.tenantId, name));
  if (!existing)
    return c.json<ApiResponse>({ ok: false, error: "key not found" }, 404);

  const rotated = await getSecretVault().rotateSecret(
    principal.tenantId,
    name,
    randomBytes(32).toString("hex"),
  );
  await auditKms(c, principal, "kms.key.rotated", keyId, {
    newVersion: rotated.version,
  });
  return c.json({ keyId, newVersion: rotated.version });
});

/** GET /keys/:keyId/versions -> { versions: number[] } */
kmsRoutes.get("/keys/:keyId/versions", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);
  const keyId = parseKeyIdParam(c);
  if (!keyId) return badRequest(c, "invalid keyId");

  const rows = await listKeyRows(
    principal.tenantId,
    secretNameFor(principal.agentId, keyId),
  );
  if (rows.length === 0 || !currentRow(rows)) {
    return c.json<ApiResponse>({ ok: false, error: "key not found" }, 404);
  }
  return c.json({ versions: rows.map((row) => row.version) });
});

/** POST /keys/:keyId/encrypt { plaintext_b64, aad_b64? } -> { ciphertext_b64, nonce_b64, auth_tag_b64, version } */
kmsRoutes.post("/keys/:keyId/encrypt", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);
  const keyId = parseKeyIdParam(c);
  if (!keyId) return badRequest(c, "invalid keyId");

  const body = await safeJsonParse<{
    plaintext_b64?: unknown;
    aad_b64?: unknown;
  }>(c);
  if (!body) return badRequest(c, "Invalid JSON in request body");
  const plaintext = decodeB64Field(body.plaintext_b64);
  if (!plaintext)
    return badRequest(c, "plaintext_b64 is required and must be valid base64");
  let aad: Buffer | undefined;
  if (body.aad_b64 !== undefined) {
    const decoded = decodeB64Field(body.aad_b64);
    if (!decoded) return badRequest(c, "aad_b64 must be valid base64");
    aad = decoded;
  }

  const rows = await listKeyRows(
    principal.tenantId,
    secretNameFor(principal.agentId, keyId),
  );
  const row = currentRow(rows);
  if (!row)
    return c.json<ApiResponse>({ ok: false, error: "key not found" }, 404);

  const key = deriveKey(
    await rootForRow(getSecretVault(), principal.tenantId, row),
    "sym",
    keyId,
    row.version,
  );
  const nonce = randomBytes(AEAD_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  await auditKms(c, principal, "kms.encrypt", keyId, { version: row.version });
  return c.json({
    ciphertext_b64: ciphertext.toString("base64"),
    nonce_b64: nonce.toString("base64"),
    auth_tag_b64: authTag.toString("base64"),
    version: row.version,
  });
});

/** POST /keys/:keyId/decrypt { ciphertext_b64, nonce_b64, auth_tag_b64, aad_b64?, version? } -> { plaintext_b64 } */
kmsRoutes.post("/keys/:keyId/decrypt", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);
  const keyId = parseKeyIdParam(c);
  if (!keyId) return badRequest(c, "invalid keyId");

  const body = await safeJsonParse<{
    ciphertext_b64?: unknown;
    nonce_b64?: unknown;
    auth_tag_b64?: unknown;
    aad_b64?: unknown;
    version?: unknown;
  }>(c);
  if (!body) return badRequest(c, "Invalid JSON in request body");
  const ciphertext = decodeB64Field(body.ciphertext_b64);
  const nonce = decodeB64Field(body.nonce_b64);
  const authTag = decodeB64Field(body.auth_tag_b64);
  if (!ciphertext || !nonce || !authTag) {
    return badRequest(
      c,
      "ciphertext_b64, nonce_b64 and auth_tag_b64 are required valid base64",
    );
  }
  if (nonce.length !== AEAD_NONCE_BYTES)
    return badRequest(c, "nonce must be 12 bytes");
  if (authTag.length !== AEAD_TAG_BYTES)
    return badRequest(c, "auth tag must be 16 bytes");
  let aad: Buffer | undefined;
  if (body.aad_b64 !== undefined) {
    const decoded = decodeB64Field(body.aad_b64);
    if (!decoded) return badRequest(c, "aad_b64 must be valid base64");
    aad = decoded;
  }
  if (
    body.version !== undefined &&
    (!Number.isInteger(body.version) || (body.version as number) < 1)
  ) {
    return badRequest(c, "version must be a positive integer");
  }

  const rows = await listKeyRows(
    principal.tenantId,
    secretNameFor(principal.agentId, keyId),
  );
  const current = currentRow(rows);
  if (!current)
    return c.json<ApiResponse>({ ok: false, error: "key not found" }, 404);
  const version = (body.version as number | undefined) ?? current.version;
  // historical versions (soft-deleted by rotation) remain decryptable by design
  const row = rows.find((candidate) => candidate.version === version);
  if (!row)
    return c.json<ApiResponse>(
      { ok: false, error: `key version ${version} not found` },
      404,
    );

  const key = deriveKey(
    await rootForRow(getSecretVault(), principal.tenantId, row),
    "sym",
    keyId,
    version,
  );
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    await auditKms(c, principal, "kms.decrypt", keyId, { version });
    return c.json({ plaintext_b64: plaintext.toString("base64") });
  } catch {
    // wrong key, wrong AAD, or tampered ciphertext — indistinguishable on
    // purpose. Fail closed with no detail beyond the fact of the failure.
    return badRequest(c, "decryption failed");
  }
});

/** POST /keys/:keyId/hmac { data_b64 } -> { tag_b64 } */
kmsRoutes.post("/keys/:keyId/hmac", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);
  const keyId = parseKeyIdParam(c);
  if (!keyId) return badRequest(c, "invalid keyId");

  const body = await safeJsonParse<{ data_b64?: unknown }>(c);
  if (!body) return badRequest(c, "Invalid JSON in request body");
  const data = decodeB64Field(body.data_b64);
  if (!data)
    return badRequest(c, "data_b64 is required and must be valid base64");

  const rows = await listKeyRows(
    principal.tenantId,
    secretNameFor(principal.agentId, keyId),
  );
  const row = currentRow(rows);
  if (!row)
    return c.json<ApiResponse>({ ok: false, error: "key not found" }, 404);

  const macKey = deriveKey(
    await rootForRow(getSecretVault(), principal.tenantId, row),
    "hmac",
    keyId,
    row.version,
  );
  const tag = createHmac("sha256", macKey).update(data).digest();
  await auditKms(c, principal, "kms.hmac", keyId, { version: row.version });
  return c.json({ tag_b64: tag.toString("base64") });
});

/** POST /keys/:keyId/hmac/verify { data_b64, tag_b64 } -> { valid } */
kmsRoutes.post("/keys/:keyId/hmac/verify", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);
  const keyId = parseKeyIdParam(c);
  if (!keyId) return badRequest(c, "invalid keyId");

  const body = await safeJsonParse<{ data_b64?: unknown; tag_b64?: unknown }>(
    c,
  );
  if (!body) return badRequest(c, "Invalid JSON in request body");
  const data = decodeB64Field(body.data_b64);
  const tag = decodeB64Field(body.tag_b64);
  if (!data || !tag)
    return badRequest(c, "data_b64 and tag_b64 are required valid base64");

  const rows = await listKeyRows(
    principal.tenantId,
    secretNameFor(principal.agentId, keyId),
  );
  if (!currentRow(rows))
    return c.json<ApiResponse>({ ok: false, error: "key not found" }, 404);

  // a tag minted under ANY version verifies (mirrors the Eliza local adapter),
  // so rotation does not invalidate outstanding MACs.
  const vault = getSecretVault();
  for (const row of rows) {
    const macKey = deriveKey(
      await rootForRow(vault, principal.tenantId, row),
      "hmac",
      keyId,
      row.version,
    );
    const expected = createHmac("sha256", macKey).update(data).digest();
    if (expected.length === tag.length && timingSafeEqual(expected, tag)) {
      return c.json({ valid: true });
    }
  }
  return c.json({ valid: false });
});

/** POST /keys/:keyId/sign { data_b64, algorithm } -> { signature_b64, algorithm, version } */
kmsRoutes.post("/keys/:keyId/sign", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);
  const keyId = parseKeyIdParam(c);
  if (!keyId) return badRequest(c, "invalid keyId");

  const body = await safeJsonParse<{ data_b64?: unknown; algorithm?: unknown }>(
    c,
  );
  if (!body) return badRequest(c, "Invalid JSON in request body");
  const data = decodeB64Field(body.data_b64);
  if (!data)
    return badRequest(c, "data_b64 is required and must be valid base64");
  if (body.algorithm !== SUPPORTED_ALGORITHM) {
    return badRequest(
      c,
      `unsupported algorithm (only ${SUPPORTED_ALGORITHM} is implemented)`,
    );
  }

  const rows = await listKeyRows(
    principal.tenantId,
    secretNameFor(principal.agentId, keyId),
  );
  const row = currentRow(rows);
  if (!row)
    return c.json<ApiResponse>({ ok: false, error: "key not found" }, 404);

  const root = await rootForRow(getSecretVault(), principal.tenantId, row);
  const signature = nodeSign(
    null,
    data,
    ed25519PrivateKey(root, keyId, row.version),
  );
  await auditKms(c, principal, "kms.sign", keyId, {
    version: row.version,
    algorithm: SUPPORTED_ALGORITHM,
  });
  return c.json({
    signature_b64: Buffer.from(signature).toString("base64"),
    algorithm: SUPPORTED_ALGORITHM,
    version: row.version,
  });
});

/** POST /keys/:keyId/verify { data_b64, signature_b64, algorithm } -> { valid } */
kmsRoutes.post("/keys/:keyId/verify", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);
  const keyId = parseKeyIdParam(c);
  if (!keyId) return badRequest(c, "invalid keyId");

  const body = await safeJsonParse<{
    data_b64?: unknown;
    signature_b64?: unknown;
    algorithm?: unknown;
  }>(c);
  if (!body) return badRequest(c, "Invalid JSON in request body");
  const data = decodeB64Field(body.data_b64);
  const signature = decodeB64Field(body.signature_b64);
  if (!data || !signature) {
    return badRequest(
      c,
      "data_b64 and signature_b64 are required valid base64",
    );
  }
  if (body.algorithm !== SUPPORTED_ALGORITHM) {
    return badRequest(
      c,
      `unsupported algorithm (only ${SUPPORTED_ALGORITHM} is implemented)`,
    );
  }

  const rows = await listKeyRows(
    principal.tenantId,
    secretNameFor(principal.agentId, keyId),
  );
  if (!currentRow(rows))
    return c.json<ApiResponse>({ ok: false, error: "key not found" }, 404);

  // signatures minted under ANY version verify (rotation-safe verification)
  const vault = getSecretVault();
  for (const row of rows) {
    const root = await rootForRow(vault, principal.tenantId, row);
    const publicKey = createPublicKey(
      ed25519PrivateKey(root, keyId, row.version),
    );
    if (nodeVerify(null, data, publicKey, signature)) {
      return c.json({ valid: true });
    }
  }
  return c.json({ valid: false });
});

/** GET /keys/:keyId/public -> { public_key_b64, algorithm } */
kmsRoutes.get("/keys/:keyId/public", async (c) => {
  const principal = requireKmsAgent(c);
  if (!principal) return deny(c);
  const keyId = parseKeyIdParam(c);
  if (!keyId) return badRequest(c, "invalid keyId");

  const rows = await listKeyRows(
    principal.tenantId,
    secretNameFor(principal.agentId, keyId),
  );
  const row = currentRow(rows);
  if (!row)
    return c.json<ApiResponse>({ ok: false, error: "key not found" }, 404);

  const root = await rootForRow(getSecretVault(), principal.tenantId, row);
  return c.json({
    public_key_b64: ed25519PublicRaw(root, keyId, row.version).toString(
      "base64",
    ),
    algorithm: SUPPORTED_ALGORITHM,
  });
});
