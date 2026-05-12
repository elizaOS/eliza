/**
 * Field Encryption Service
 *
 * A generic, reusable encryption service for encrypting sensitive fields
 * across any table in the database. Uses organization-scoped encryption keys
 * and an encoded string format that requires zero schema changes.
 *
 * Key Hierarchy:
 * - Master Key (SECRETS_MASTER_KEY env var) wraps ->
 * - Organization DEK (stored in organization_encryption_keys, encrypted) encrypts ->
 * - Sensitive fields (user_database_uri, api_keys, etc.)
 *
 * Encrypted Format: enc:v1:<org_key_id>:<nonce>:<auth_tag>:<ciphertext>
 *
 * @module lib/services/field-encryption
 */

import crypto from "crypto";
import { eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/helpers";
import type { OrganizationEncryptionKey } from "@/db/schemas";
import { organizationEncryptionKeys } from "@/db/schemas";
import { logger } from "@/lib/utils/logger";

// Encryption constants
const ENCRYPTION_PREFIX = "enc";
const FORMAT_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const _AUTH_TAG_LENGTH = 16;
const DEK_LENGTH = 32; // 256 bits

/**
 * Parsed components of an encrypted value
 */
interface ParsedEncryptedValue {
  version: string;
  orgKeyId: string;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * Field Encryption Service
 *
 * Provides encrypt/decrypt operations for sensitive database fields.
 * Uses per-organization Data Encryption Keys (DEKs) for tenant isolation.
 */
export class FieldEncryptionService {
  private masterKey: Buffer | null = null;
  private initialized = false;

  /**
   * Initialize the service with the master key from environment.
   * Called lazily on first use to avoid errors during module load.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;

    const masterKeyHex = process.env.SECRETS_MASTER_KEY;
    if (!masterKeyHex) {
      throw new Error(
        "SECRETS_MASTER_KEY must be set for field encryption. " +
          "Generate with: openssl rand -hex 32",
      );
    }

    if (masterKeyHex.length !== 64) {
      throw new Error(
        "SECRETS_MASTER_KEY must be 64 hex characters (32 bytes). " +
          `Current length: ${masterKeyHex.length}`,
      );
    }

    this.masterKey = Buffer.from(masterKeyHex, "hex");
    this.initialized = true;
  }

  /**
   * Check if a value is encrypted (starts with enc:v1:)
   *
   * @param value - Value to check
   * @returns true if the value is encrypted
   */
  isEncrypted(value: string | null | undefined): boolean {
    if (!value) return false;
    return value.startsWith(`${ENCRYPTION_PREFIX}:${FORMAT_VERSION}:`);
  }

  /**
   * Encrypt a plaintext value for an organization.
   *
   * Returns encoded string: enc:v1:<org_key_id>:<nonce>:<auth_tag>:<ciphertext>
   *
   * @param organizationId - Organization ID to encrypt for
   * @param plaintext - The value to encrypt
   * @returns Encrypted string in encoded format
   */
  async encrypt(organizationId: string, plaintext: string): Promise<string> {
    this.ensureInitialized();

    // Get or create the organization's DEK
    const orgKey = await this.getOrCreateOrgKey(organizationId);
    const dek = this.unwrapDek(orgKey.encrypted_dek);

    // Generate random nonce
    const nonce = crypto.randomBytes(NONCE_LENGTH);

    // Encrypt with AES-256-GCM
    const cipher = crypto.createCipheriv(ALGORITHM, dek, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: enc:v1:<org_key_id>:<nonce>:<auth_tag>:<ciphertext>
    return [
      ENCRYPTION_PREFIX,
      FORMAT_VERSION,
      orgKey.id,
      nonce.toString("base64"),
      authTag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(":");
  }

  /**
   * Decrypt an encrypted value.
   *
   * Input: enc:v1:<org_key_id>:<nonce>:<auth_tag>:<ciphertext>
   *
   * @param encryptedValue - The encrypted string to decrypt
   * @returns Decrypted plaintext
   */
  async decrypt(encryptedValue: string): Promise<string> {
    this.ensureInitialized();

    const parsed = this.parseEncryptedValue(encryptedValue);

    // Get the org's DEK
    const orgKey = await this.getOrgKeyById(parsed.orgKeyId);
    if (!orgKey) {
      throw new Error(`Encryption key not found: ${parsed.orgKeyId}`);
    }
    const dek = this.unwrapDek(orgKey.encrypted_dek);

    // Decrypt with AES-256-GCM
    const decipher = crypto.createDecipheriv(ALGORITHM, dek, parsed.nonce);
    decipher.setAuthTag(parsed.authTag);

    const plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);

    return plaintext.toString("utf8");
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
   * Useful for backward compatibility during migrations.
   *
   * @param value - The value to potentially decrypt
   * @returns Decrypted value or original value if not encrypted
   */
  async decryptIfNeeded(value: string | null | undefined): Promise<string | null> {
    if (!value) return null;
    if (!this.isEncrypted(value)) {
      logger.warn("Found unencrypted value where encrypted was expected");
      return value;
    }
    return this.decrypt(value);
  }

  /**
   * Rotate encryption key for an organization.
   * Re-encrypts the DEK with current master key.
   *
   * @param organizationId - Organization ID to rotate key for
   */
  async rotateOrgKey(organizationId: string): Promise<void> {
    this.ensureInitialized();

    const orgKey = await this.getOrgKeyByOrgId(organizationId);
    if (!orgKey) {
      throw new Error(`No encryption key for org: ${organizationId}`);
    }

    // Decrypt old DEK, re-encrypt with (potentially new) master key
    const dek = this.unwrapDek(orgKey.encrypted_dek);
    const newWrappedDek = this.wrapDek(dek);

    await dbWrite
      .update(organizationEncryptionKeys)
      .set({
        encrypted_dek: newWrappedDek,
        key_version: orgKey.key_version + 1,
        rotated_at: new Date(),
      })
      .where(eq(organizationEncryptionKeys.id, orgKey.id));

    logger.info("Rotated encryption key for organization", {
      organizationId,
      keyVersion: orgKey.key_version + 1,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Parse an encrypted value into its components.
   */
  private parseEncryptedValue(value: string): ParsedEncryptedValue {
    const parts = value.split(":");
    if (parts.length !== 6) {
      throw new Error(`Invalid encrypted value format: expected 6 parts, got ${parts.length}`);
    }

    const [prefix, version, orgKeyId, nonceB64, authTagB64, ciphertextB64] = parts;

    if (prefix !== ENCRYPTION_PREFIX || version !== FORMAT_VERSION) {
      throw new Error(`Unsupported encryption format: ${prefix}:${version}`);
    }

    return {
      version,
      orgKeyId,
      nonce: Buffer.from(nonceB64, "base64"),
      authTag: Buffer.from(authTagB64, "base64"),
      ciphertext: Buffer.from(ciphertextB64, "base64"),
    };
  }

  /**
   * Get or create an encryption key for an organization.
   */
  private async getOrCreateOrgKey(organizationId: string): Promise<OrganizationEncryptionKey> {
    // Try to get existing key
    const existingKey = await this.getOrgKeyByOrgId(organizationId);
    if (existingKey) {
      return existingKey;
    }

    // Generate new DEK for this organization
    const dek = crypto.randomBytes(DEK_LENGTH);
    const wrappedDek = this.wrapDek(dek);

    const [created] = await dbWrite
      .insert(organizationEncryptionKeys)
      .values({
        organization_id: organizationId,
        encrypted_dek: wrappedDek,
      })
      .onConflictDoNothing()
      .returning();

    // Handle race condition - another request may have created it
    if (created) {
      logger.info("Created encryption key for organization", {
        organizationId,
      });
      return created;
    }

    // Race condition: another request created the key, fetch it
    // Use dbWrite (primary) instead of dbRead (replica) to avoid replication lag
    const raceCreatedKey = await dbWrite.query.organizationEncryptionKeys.findFirst({
      where: eq(organizationEncryptionKeys.organization_id, organizationId),
    });
    if (!raceCreatedKey) {
      throw new Error(`Failed to create/get encryption key for org: ${organizationId}`);
    }

    return raceCreatedKey;
  }

  /**
   * Find encryption key by organization ID.
   */
  private async getOrgKeyByOrgId(organizationId: string) {
    return dbRead.query.organizationEncryptionKeys.findFirst({
      where: eq(organizationEncryptionKeys.organization_id, organizationId),
    });
  }

  /**
   * Find encryption key by its ID.
   * Uses dbWrite (primary) to avoid replication lag when key was just created.
   */
  private async getOrgKeyById(keyId: string) {
    return dbWrite.query.organizationEncryptionKeys.findFirst({
      where: eq(organizationEncryptionKeys.id, keyId),
    });
  }

  /**
   * Wrap (encrypt) a DEK with the master key.
   * Format: <nonce>:<authTag>:<encrypted_dek> (all base64)
   */
  private wrapDek(dek: Buffer): string {
    const nonce = crypto.randomBytes(NONCE_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey!, nonce);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      nonce.toString("base64"),
      authTag.toString("base64"),
      encrypted.toString("base64"),
    ].join(":");
  }

  /**
   * Unwrap (decrypt) a DEK using the master key.
   */
  private unwrapDek(wrappedDek: string): Buffer {
    const parts = wrappedDek.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid wrapped DEK format");
    }

    const [nonceB64, authTagB64, encryptedB64] = parts;
    const nonce = Buffer.from(nonceB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const encrypted = Buffer.from(encryptedB64, "base64");

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey!, nonce);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
}

// Singleton instance
export const fieldEncryption = new FieldEncryptionService();
