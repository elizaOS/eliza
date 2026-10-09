/**
 * Field Encryption Service
 *
 * A generic, reusable encryption service for encrypting sensitive fields
 * across any table in the database. Uses organization-scoped encryption keys
 * and an encoded string format that requires zero schema changes.
 *
 * Key Hierarchy:
 * - Master Key (SECRETS_MASTER_KEY env var, optional SECRETS_MASTER_KEY_PREVIOUS
 *   during master-key rotation) wraps ->
 * - Organization DEK (stored in organization_encryption_keys, encrypted) encrypts ->
 * - Sensitive fields (user_database_uri, api_keys, etc.)
 *
 * Encrypted formats:
 * - v1: enc:v1:<org_key_id>:<nonce>:<auth_tag>:<ciphertext>, no AAD. Still the
 *   format for every write WITHOUT coordinates (see rollout rule below). Older
 *   v1 rows may carry `table|rowId|column` AAD; the envelope does not record
 *   which, so v1 counts as unbound for FIELD_ENCRYPTION_REQUIRE_AAD.
 * - v2: enc:v2:<org_key_id>:<flags>:<nonce>:<auth_tag>:<ciphertext>, written
 *   only for writes WITH coordinates (`flags` = `a`). `n` (unbound) is
 *   readable but never written. The AAD binds the envelope header
 *   (`enc:v2:<org_key_id>:<flags>`) plus the coordinates, so the flag cannot
 *   be flipped and a v2 ciphertext cannot be relabelled as v1.
 *
 * Rollout rule: readers that predate v2 (the Worker before deploy, the
 * provisioning daemon) treat `enc:v2:` as plaintext. Coordinate-less writes
 * therefore stay byte-compatible v1 so existing callers (agent env secrets,
 * DSNs, billing secrets) keep working with old readers; only callers that opt
 * into coordinates, and whose readers ship with this code, produce v2.
 *
 * @module lib/services/field-encryption
 */

import { ElizaError } from "@elizaos/core";
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../../db/helpers";
import type { OrganizationEncryptionKey } from "../../db/schemas";
import { organizationEncryptionKeys } from "../../db/schemas";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";

// Encryption constants
const ENCRYPTION_PREFIX = "enc";
const LEGACY_FORMAT_VERSION = "v1";
const FORMAT_VERSION = "v2";
const AAD_FLAG_BOUND = "a";
const AAD_FLAG_NONE = "n";
const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DEK_LENGTH = 32; // 256 bits
const MASTER_KEY_HEX = /^[0-9a-fA-F]{64}$/;

type AadFlag = typeof AAD_FLAG_BOUND | typeof AAD_FLAG_NONE;

/**
 * Parsed components of an encrypted value. `aadFlag` is null for legacy v1
 * envelopes, which do not record whether coordinates were bound.
 */
interface ParsedEncryptedValue {
  version: typeof LEGACY_FORMAT_VERSION | typeof FORMAT_VERSION;
  orgKeyId: string;
  aadFlag: AadFlag | null;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * Table/row/column that a ciphertext belongs to. When supplied, the coordinates
 * are bound into the AES-GCM AAD so a ciphertext cannot be relocated to a
 * different row/column and still decrypt. Mirrors the pattern in
 * `db/crypto/field-crypto.ts` / `@elizaos/auth/kms`.
 */
export interface FieldCoords {
  table: string;
  rowId: string;
  column: string;
}

/** Which master key successfully unwrapped an organization DEK. */
export type MasterKeySlot = "current" | "previous";

/** Result of {@link FieldEncryptionService.rewrapOrgKeyWithCurrentMaster}. */
export interface OrgKeyRewrapResult {
  organizationId: string;
  keyId: string;
  keyVersion: number;
  /** Master key the DEK was wrapped with before the rewrap. */
  unwrappedWith: MasterKeySlot;
}

/**
 * Persistence for organization DEK rows. The default implementation uses the
 * shared Drizzle handles; tests inject an in-memory store.
 */
export interface OrgEncryptionKeyStore {
  findByOrgId(organizationId: string): Promise<OrganizationEncryptionKey | undefined>;
  /** Primary-read lookup (used right after create to avoid replica lag). */
  findByOrgIdPrimary(organizationId: string): Promise<OrganizationEncryptionKey | undefined>;
  findById(keyId: string): Promise<OrganizationEncryptionKey | undefined>;
  /** Insert a key row; returns undefined when a concurrent writer already created one. */
  insertIfAbsent(
    organizationId: string,
    encryptedDek: string,
  ): Promise<OrganizationEncryptionKey | undefined>;
  /**
   * Compare-and-set the wrapped DEK: only updates when the row is still at
   * `expectedVersion`. Returns the updated row, or undefined on a lost race.
   */
  updateWrappedDek(
    keyId: string,
    expectedVersion: number,
    encryptedDek: string,
    nextVersion: number,
  ): Promise<OrganizationEncryptionKey | undefined>;
}

const drizzleOrgKeyStore: OrgEncryptionKeyStore = {
  findByOrgId: (organizationId) =>
    dbRead.query.organizationEncryptionKeys.findFirst({
      where: eq(organizationEncryptionKeys.organization_id, organizationId),
    }),
  findByOrgIdPrimary: (organizationId) =>
    dbWrite.query.organizationEncryptionKeys.findFirst({
      where: eq(organizationEncryptionKeys.organization_id, organizationId),
    }),
  // Primary read: avoids replication lag when the key was just created.
  findById: (keyId) =>
    dbWrite.query.organizationEncryptionKeys.findFirst({
      where: eq(organizationEncryptionKeys.id, keyId),
    }),
  insertIfAbsent: async (organizationId, encryptedDek) => {
    const [created] = await dbWrite
      .insert(organizationEncryptionKeys)
      .values({ organization_id: organizationId, encrypted_dek: encryptedDek })
      .onConflictDoNothing()
      .returning();
    return created;
  },
  updateWrappedDek: async (keyId, expectedVersion, encryptedDek, nextVersion) => {
    const [updated] = await dbWrite
      .update(organizationEncryptionKeys)
      .set({ encrypted_dek: encryptedDek, key_version: nextVersion, rotated_at: new Date() })
      .where(
        and(
          eq(organizationEncryptionKeys.id, keyId),
          eq(organizationEncryptionKeys.key_version, expectedVersion),
        ),
      )
      .returning();
    return updated;
  },
};

/**
 * Whether field encryption at rest is mandatory in this environment: an
 * explicit `FIELD_ENCRYPTION_REQUIRED=true`, or a deployed-environment marker
 * (`ENVIRONMENT` of `production`/`staging`, the same authority `kms-client.ts`
 * uses). Local/dev/test worlds without the marker keep the legacy plaintext
 * compatibility path.
 */
export function isFieldEncryptionRequired(env: NodeJS.ProcessEnv = getCloudAwareEnv()): boolean {
  if (env.FIELD_ENCRYPTION_REQUIRED === "true") return true;
  return env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging";
}

/**
 * Whether ciphertexts must be bound to table/row/column coordinates
 * (`FIELD_ENCRYPTION_REQUIRE_AAD=true`). When on, coordinate-less writes fail
 * with `FIELD_ENCRYPTION_AAD_REQUIRED`, and so do reads of envelopes that are
 * not coordinate-bound (legacy v1 and v2 `n`).
 *
 * Keep this off in deployments until every writer and reader of a field passes
 * coordinates and legacy rows have been re-encrypted as v2 `a`: agent env
 * secrets and user-database URIs do not pass coordinates yet.
 */
export function isFieldEncryptionAadRequired(env: NodeJS.ProcessEnv = getCloudAwareEnv()): boolean {
  return env.FIELD_ENCRYPTION_REQUIRE_AAD === "true";
}

/**
 * Parse and validate a 32-byte hex master key. Errors name the variable and
 * the observed length only — never the key material.
 */
function parseMasterKey(name: string, value: string): Buffer {
  if (!MASTER_KEY_HEX.test(value)) {
    throw new ElizaError(
      `${name} must be 64 hex characters (32 bytes). Current length: ${value.length}`,
      { code: "FIELD_ENCRYPTION_MASTER_KEY_INVALID", severity: "fatal", context: { name } },
    );
  }
  return Buffer.from(value, "hex");
}

function assertCoords(coords: FieldCoords): void {
  for (const field of ["table", "rowId", "column"] as const) {
    if (typeof coords[field] !== "string" || coords[field].length === 0) {
      throw new ElizaError(`Field encryption coordinates require a non-empty ${field}`, {
        code: "FIELD_ENCRYPTION_INVALID_COORDS",
        severity: "fatal",
        context: { field },
      });
    }
  }
}

/** Legacy v1 AAD: `table|rowId|column`, only when the writer passed coords. */
function legacyAadForCoords(coords: FieldCoords): Buffer {
  return Buffer.from(`${coords.table}|${coords.rowId}|${coords.column}`, "utf8");
}

/**
 * v2 AAD: the envelope header plus (for `a`) the coordinates, JSON-encoded so
 * separators inside a coordinate cannot collide with another coordinate set.
 */
function v2Aad(orgKeyId: string, flag: AadFlag, coords?: FieldCoords): Buffer {
  const header = [ENCRYPTION_PREFIX, FORMAT_VERSION, orgKeyId, flag].join(":");
  const parts =
    flag === AAD_FLAG_BOUND && coords
      ? [header, coords.table, coords.rowId, coords.column]
      : [header];
  return Buffer.from(JSON.stringify(parts), "utf8");
}

function invalidEnvelope(message: string, context?: Record<string, unknown>): ElizaError {
  return new ElizaError(message, {
    code: "FIELD_ENCRYPTION_INVALID_ENVELOPE",
    severity: "fatal",
    context,
  });
}

/**
 * Field Encryption Service
 *
 * Provides encrypt/decrypt operations for sensitive database fields.
 * Uses per-organization Data Encryption Keys (DEKs) for tenant isolation.
 */
export class FieldEncryptionService {
  private masterKey: Buffer | null = null;
  private previousMasterKey: Buffer | null = null;
  private initialized = false;
  private readonly warnedPreviousMasterKeyIds = new Set<string>();

  constructor(private readonly keyStore: OrgEncryptionKeyStore = drizzleOrgKeyStore) {}

  /**
   * Initialize the service with the master key(s) from environment.
   * Called lazily on first use to avoid errors during module load.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;

    const env = getCloudAwareEnv();
    const masterKeyHex = env.SECRETS_MASTER_KEY;
    if (!masterKeyHex) {
      throw new ElizaError(
        "SECRETS_MASTER_KEY must be set for field encryption. " +
          "Generate with: openssl rand -hex 32",
        { code: "FIELD_ENCRYPTION_MASTER_KEY_MISSING", severity: "fatal" },
      );
    }
    const masterKey = parseMasterKey("SECRETS_MASTER_KEY", masterKeyHex);

    const previousHex = env.SECRETS_MASTER_KEY_PREVIOUS;
    let previousMasterKey: Buffer | null = null;
    if (previousHex) {
      previousMasterKey = parseMasterKey("SECRETS_MASTER_KEY_PREVIOUS", previousHex);
      if (crypto.timingSafeEqual(previousMasterKey, masterKey)) previousMasterKey = null;
    }

    this.masterKey = masterKey;
    this.previousMasterKey = previousMasterKey;
    this.initialized = true;
  }

  /**
   * Check if a value is an encrypted envelope (enc:v2: or legacy enc:v1:).
   *
   * @param value - Value to check
   * @returns true if the value is encrypted
   */
  isEncrypted(value: string | null | undefined): boolean {
    if (!value) return false;
    return (
      value.startsWith(`${ENCRYPTION_PREFIX}:${FORMAT_VERSION}:`) ||
      value.startsWith(`${ENCRYPTION_PREFIX}:${LEGACY_FORMAT_VERSION}:`)
    );
  }

  /** Verify tenant ownership before accepting an existing envelope for storage. */
  async assertEncryptedValueOrganization(
    organizationId: string,
    encryptedValue: string,
  ): Promise<void> {
    const parsed = this.parseEncryptedValue(encryptedValue);
    const orgKey = await this.keyStore.findById(parsed.orgKeyId);
    if (!orgKey) {
      throw new ElizaError("Encryption key not found for the supplied environment envelope", {
        code: "FIELD_ENCRYPTION_KEY_NOT_FOUND",
        severity: "fatal",
      });
    }
    if (orgKey.organization_id !== organizationId) {
      throw new ElizaError("Encrypted environment value belongs to another organization", {
        code: "FIELD_ENCRYPTION_ORGANIZATION_MISMATCH",
        severity: "fatal",
      });
    }
  }

  /**
   * Encrypt a plaintext value for an organization.
   *
   * Returns enc:v2:<org_key_id>:a:<nonce>:<auth_tag>:<ciphertext> when `coords`
   * are given, otherwise the legacy unbound enc:v1:<org_key_id>:<nonce>:<auth_tag>:<ciphertext>.
   *
   * @param organizationId - Organization ID to encrypt for
   * @param plaintext - The value to encrypt
   * @param coords - Table/row/column to bind into the AAD (required when
   *   FIELD_ENCRYPTION_REQUIRE_AAD=true); pass the same coords to `decrypt`.
   * @returns Encrypted string in encoded format
   */
  async encrypt(organizationId: string, plaintext: string, coords?: FieldCoords): Promise<string> {
    if (!coords && isFieldEncryptionAadRequired()) {
      throw new ElizaError(
        "Field encryption requires table/row/column coordinates (FIELD_ENCRYPTION_REQUIRE_AAD=true)",
        { code: "FIELD_ENCRYPTION_AAD_REQUIRED", severity: "fatal", context: { organizationId } },
      );
    }
    if (coords) assertCoords(coords);
    this.ensureInitialized();

    // Get or create the organization's DEK
    const orgKey = await this.getOrCreateOrgKey(organizationId);
    const dek = this.unwrapOrgDek(orgKey).dek;

    const nonce = crypto.randomBytes(NONCE_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, dek, nonce);
    // Rollout rule (module doc): coordinate-less writes keep the exact legacy
    // unbound v1 envelope so pre-v2 readers can still decrypt them.
    if (coords) cipher.setAAD(v2Aad(orgKey.id, AAD_FLAG_BOUND, coords));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const header = coords
      ? [ENCRYPTION_PREFIX, FORMAT_VERSION, orgKey.id, AAD_FLAG_BOUND]
      : [ENCRYPTION_PREFIX, LEGACY_FORMAT_VERSION, orgKey.id];
    return [
      ...header,
      nonce.toString("base64"),
      authTag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(":");
  }

  /**
   * Decrypt an encrypted value (v2, or legacy v1 while
   * FIELD_ENCRYPTION_REQUIRE_AAD is off).
   *
   * A v2 `a` envelope requires the same `coords` used at encrypt time; a
   * mismatch (or a ciphertext moved to a different row/column) fails with
   * `FIELD_ENCRYPTION_AUTH_FAILED`.
   *
   * @param encryptedValue - The encrypted string to decrypt
   * @param coords - Table/row/column the value was encrypted for
   * @returns Decrypted plaintext
   */
  async decrypt(encryptedValue: string, coords?: FieldCoords): Promise<string> {
    const parsed = this.parseEncryptedValue(encryptedValue);
    if (coords) assertCoords(coords);

    const aad = this.aadForDecrypt(parsed, coords);
    this.ensureInitialized();

    const orgKey = await this.keyStore.findById(parsed.orgKeyId);
    if (!orgKey) {
      throw new ElizaError(`Encryption key not found: ${parsed.orgKeyId}`, {
        code: "FIELD_ENCRYPTION_KEY_NOT_FOUND",
        severity: "fatal",
        context: { orgKeyId: parsed.orgKeyId },
      });
    }
    const dek = this.unwrapOrgDek(orgKey).dek;

    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, dek, parsed.nonce, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      if (aad) decipher.setAAD(aad);
      decipher.setAuthTag(parsed.authTag);
      const plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
      return plaintext.toString("utf8");
    } catch (error) {
      throw new ElizaError(
        "Field decryption failed authentication (tampered ciphertext, wrong key, or coordinate mismatch)",
        {
          code: "FIELD_ENCRYPTION_AUTH_FAILED",
          severity: "fatal",
          cause: error,
          context: {
            orgKeyId: parsed.orgKeyId,
            version: parsed.version,
            aadFlag: parsed.aadFlag,
            coordsSupplied: Boolean(coords),
          },
        },
      );
    }
  }

  /**
   * Encrypt only if not already encrypted.
   * Useful for migrations and gradual encryption.
   *
   * @param organizationId - Organization ID to encrypt for
   * @param value - The value to potentially encrypt
   * @returns Encrypted value or null if input was null/undefined
   */
  async encryptIfNeeded(
    organizationId: string,
    value: string | null | undefined,
  ): Promise<string | null> {
    if (!value) return null;
    if (this.isEncrypted(value)) return value;
    return this.encrypt(organizationId, value);
  }

  /**
   * Decrypt only if encrypted, otherwise return as-is.
   * Useful for backward compatibility during migrations: legacy plaintext rows
   * stay readable. Where encryption is required (production/staging) a
   * plaintext hit is logged at error level so it can be found and backfilled.
   *
   * @param value - The value to potentially decrypt
   * @returns Decrypted value or original value if not encrypted
   */
  async decryptIfNeeded(value: string | null | undefined): Promise<string | null> {
    if (!value) return null;
    if (!this.isEncrypted(value)) {
      if (isFieldEncryptionRequired()) {
        logger.error(
          "[field-encryption] Read a legacy PLAINTEXT value where encryption at rest is required; re-encrypt this row",
          { code: "FIELD_ENCRYPTION_PLAINTEXT_AT_REST" },
        );
      } else {
        logger.warn("Found unencrypted value where encrypted was expected");
      }
      return value;
    }
    return this.decrypt(value);
  }

  /**
   * Rotate encryption key for an organization: re-wraps the DEK with the
   * current master key and bumps key_version.
   *
   * @param organizationId - Organization ID to rotate key for
   */
  async rotateOrgKey(organizationId: string): Promise<void> {
    await this.rewrapOrgKeyWithCurrentMaster(organizationId);
  }

  /**
   * Master-key rotation step for one organization. Unwraps the DEK with the
   * current master key (falling back to SECRETS_MASTER_KEY_PREVIOUS), re-wraps
   * it with the current SECRETS_MASTER_KEY, and bumps key_version with a
   * compare-and-set so a concurrent rotation cannot be lost.
   *
   * The DEK itself is unchanged, so existing field ciphertexts stay valid.
   * Once every org reports `unwrappedWith: "current"`, the previous key can
   * be removed from the environment.
   */
  async rewrapOrgKeyWithCurrentMaster(organizationId: string): Promise<OrgKeyRewrapResult> {
    this.ensureInitialized();

    const orgKey = await this.keyStore.findByOrgIdPrimary(organizationId);
    if (!orgKey) {
      throw new ElizaError(`No encryption key for org: ${organizationId}`, {
        code: "FIELD_ENCRYPTION_KEY_NOT_FOUND",
        severity: "fatal",
        context: { organizationId },
      });
    }

    const { dek, slot } = this.unwrapOrgDek(orgKey, { quiet: true });
    const nextVersion = orgKey.key_version + 1;
    const updated = await this.keyStore.updateWrappedDek(
      orgKey.id,
      orgKey.key_version,
      this.wrapDek(dek),
      nextVersion,
    );
    if (!updated) {
      throw new ElizaError("Organization encryption key changed concurrently; retry the rewrap", {
        code: "FIELD_ENCRYPTION_ROTATION_CONFLICT",
        severity: "ephemeral",
        context: { organizationId, keyId: orgKey.id, expectedVersion: orgKey.key_version },
      });
    }

    logger.info("Re-wrapped organization encryption key with current master key", {
      organizationId,
      keyId: orgKey.id,
      keyVersion: updated.key_version,
      unwrappedWith: slot,
    });

    return {
      organizationId,
      keyId: orgKey.id,
      keyVersion: updated.key_version,
      unwrappedWith: slot,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Enforce the AAD policy for a parsed envelope and return the AAD to verify
   * (null when the legacy envelope was written without coordinates).
   */
  private aadForDecrypt(parsed: ParsedEncryptedValue, coords?: FieldCoords): Buffer | null {
    const requireAad = isFieldEncryptionAadRequired();
    if (parsed.version === LEGACY_FORMAT_VERSION) {
      if (requireAad) {
        throw new ElizaError(
          "Legacy enc:v1 envelopes are not coordinate-bound and are rejected when FIELD_ENCRYPTION_REQUIRE_AAD=true",
          {
            code: "FIELD_ENCRYPTION_AAD_REQUIRED",
            severity: "fatal",
            context: { orgKeyId: parsed.orgKeyId, version: parsed.version },
          },
        );
      }
      return coords ? legacyAadForCoords(coords) : null;
    }

    if (parsed.aadFlag === AAD_FLAG_NONE) {
      if (requireAad) {
        throw new ElizaError(
          "Envelope is not coordinate-bound and is rejected when FIELD_ENCRYPTION_REQUIRE_AAD=true",
          {
            code: "FIELD_ENCRYPTION_AAD_REQUIRED",
            severity: "fatal",
            context: {
              orgKeyId: parsed.orgKeyId,
              version: parsed.version,
              aadFlag: parsed.aadFlag,
            },
          },
        );
      }
      return v2Aad(parsed.orgKeyId, AAD_FLAG_NONE);
    }

    if (!coords) {
      throw new ElizaError(
        "Envelope is bound to table/row/column coordinates; decrypt must pass the same coordinates",
        {
          code: "FIELD_ENCRYPTION_AAD_COORDS_MISSING",
          severity: "fatal",
          context: { orgKeyId: parsed.orgKeyId, version: parsed.version },
        },
      );
    }
    return v2Aad(parsed.orgKeyId, AAD_FLAG_BOUND, coords);
  }

  /**
   * Parse an encrypted value into its components.
   */
  private parseEncryptedValue(value: string): ParsedEncryptedValue {
    const parts = value.split(":");
    const [prefix, version] = parts;
    if (prefix !== ENCRYPTION_PREFIX) {
      throw invalidEnvelope(`Unsupported encryption format: ${prefix}:${version}`);
    }

    let orgKeyId: string;
    let aadFlag: AadFlag | null;
    let rest: string[];
    if (version === FORMAT_VERSION) {
      if (parts.length !== 7) {
        throw invalidEnvelope(
          `Invalid encrypted value format: expected 7 parts, got ${parts.length}`,
          { version },
        );
      }
      const flag = parts[3];
      if (flag !== AAD_FLAG_BOUND && flag !== AAD_FLAG_NONE) {
        throw invalidEnvelope("Invalid encrypted value format: unknown AAD flag", { version });
      }
      orgKeyId = parts[2];
      aadFlag = flag;
      rest = parts.slice(4);
    } else if (version === LEGACY_FORMAT_VERSION) {
      if (parts.length !== 6) {
        throw invalidEnvelope(
          `Invalid encrypted value format: expected 6 parts, got ${parts.length}`,
          { version },
        );
      }
      orgKeyId = parts[2];
      aadFlag = null;
      rest = parts.slice(3);
    } else {
      throw invalidEnvelope(`Unsupported encryption format: ${prefix}:${version}`);
    }

    const [nonceB64, authTagB64, ciphertextB64] = rest;
    const nonce = Buffer.from(nonceB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    if (!orgKeyId || nonce.length !== NONCE_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      throw invalidEnvelope("Invalid encrypted value format: malformed key id, nonce, or tag", {
        version,
      });
    }

    return {
      version,
      orgKeyId,
      aadFlag,
      nonce,
      authTag,
      ciphertext: Buffer.from(ciphertextB64, "base64"),
    };
  }

  /**
   * Get or create an encryption key for an organization.
   */
  private async getOrCreateOrgKey(organizationId: string): Promise<OrganizationEncryptionKey> {
    const existingKey = await this.keyStore.findByOrgId(organizationId);
    if (existingKey) {
      return existingKey;
    }

    // Generate new DEK for this organization
    const dek = crypto.randomBytes(DEK_LENGTH);
    const created = await this.keyStore.insertIfAbsent(organizationId, this.wrapDek(dek));

    if (created) {
      logger.info("Created encryption key for organization", {
        organizationId,
      });
      return created;
    }

    // Race condition: another request created the key; read it from the primary.
    const raceCreatedKey = await this.keyStore.findByOrgIdPrimary(organizationId);
    if (!raceCreatedKey) {
      throw new ElizaError(`Failed to create/get encryption key for org: ${organizationId}`, {
        code: "FIELD_ENCRYPTION_KEY_NOT_FOUND",
        severity: "fatal",
        context: { organizationId },
      });
    }

    return raceCreatedKey;
  }

  /**
   * Wrap (encrypt) a DEK with the current master key.
   * Format: <nonce>:<authTag>:<encrypted_dek> (all base64)
   */
  private wrapDek(dek: Buffer): string {
    const masterKey = this.requireMasterKey();
    const nonce = crypto.randomBytes(NONCE_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, masterKey, nonce);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      nonce.toString("base64"),
      authTag.toString("base64"),
      encrypted.toString("base64"),
    ].join(":");
  }

  /**
   * Unwrap an org DEK with the current master key, falling back to
   * SECRETS_MASTER_KEY_PREVIOUS during a master-key rotation.
   */
  private unwrapOrgDek(
    orgKey: OrganizationEncryptionKey,
    options: { quiet?: boolean } = {},
  ): { dek: Buffer; slot: MasterKeySlot } {
    const parts = orgKey.encrypted_dek.split(":");
    if (parts.length !== 3) {
      throw new ElizaError("Invalid wrapped DEK format", {
        code: "FIELD_ENCRYPTION_INVALID_WRAPPED_DEK",
        severity: "fatal",
        context: { keyId: orgKey.id },
      });
    }
    const [nonceB64, authTagB64, encryptedB64] = parts;
    const nonce = Buffer.from(nonceB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const encrypted = Buffer.from(encryptedB64, "base64");

    const current = tryUnwrap(this.requireMasterKey(), nonce, authTag, encrypted);
    if (current) return { dek: current, slot: "current" };

    if (this.previousMasterKey) {
      const previous = tryUnwrap(this.previousMasterKey, nonce, authTag, encrypted);
      if (previous) {
        if (!options.quiet && !this.warnedPreviousMasterKeyIds.has(orgKey.id)) {
          this.warnedPreviousMasterKeyIds.add(orgKey.id);
          logger.warn(
            "[field-encryption] Organization DEK is wrapped with SECRETS_MASTER_KEY_PREVIOUS; run rewrapOrgKeyWithCurrentMaster",
            { keyId: orgKey.id, organizationId: orgKey.organization_id },
          );
        }
        return { dek: previous, slot: "previous" };
      }
    }

    throw new ElizaError("Failed to unwrap organization DEK with the configured master key(s)", {
      code: "FIELD_ENCRYPTION_DEK_UNWRAP_FAILED",
      severity: "fatal",
      context: { keyId: orgKey.id, triedPrevious: Boolean(this.previousMasterKey) },
    });
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) {
      throw new ElizaError("Field encryption used before the master key was initialized", {
        code: "FIELD_ENCRYPTION_MASTER_KEY_MISSING",
        severity: "fatal",
      });
    }
    return this.masterKey;
  }
}

/** AES-GCM unwrap; returns null on authentication failure (wrong master key). */
function tryUnwrap(key: Buffer, nonce: Buffer, authTag: Buffer, encrypted: Buffer): Buffer | null {
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    const dek = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return dek.length === DEK_LENGTH ? dek : null;
  } catch {
    return null;
  }
}

// Singleton instance
export const fieldEncryption = new FieldEncryptionService();
