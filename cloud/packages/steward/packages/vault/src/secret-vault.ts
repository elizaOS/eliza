/**
 * Secret Vault — encrypted credential storage for tenant API keys and secrets.
 *
 * Reuses the KeyStore's AES-256-GCM encryption. Secrets are encrypted per-tenant
 * using the same master key hierarchy as wallet keys.
 *
 * Decrypted values are NEVER returned via API — only used internally for
 * credential injection into proxied requests.
 */

import { getDb, type Secret, type SecretRoute, secretRoutes, secrets } from "@stwd/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type EncryptedKey, KeyStore } from "./keystore";

export interface SecretMetadata {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  version: number;
  rotatedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSecretOptions {
  description?: string;
  expiresAt?: Date;
}

export class SecretVault {
  private keyStore: KeyStore;

  constructor(masterPassword: string) {
    this.keyStore = new KeyStore(masterPassword);
  }

  /**
   * Encrypt a secret value and store it in the database.
   */
  async createSecret(
    tenantId: string,
    name: string,
    value: string,
    options?: CreateSecretOptions,
  ): Promise<SecretMetadata> {
    const db = getDb();
    const encrypted = this.keyStore.encrypt(value);

    const [row] = await db
      .insert(secrets)
      .values({
        tenantId,
        name,
        description: options?.description ?? null,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.tag,
        salt: encrypted.salt,
        version: 1,
        expiresAt: options?.expiresAt ?? null,
      })
      .returning();

    return this.toMetadata(row);
  }

  /**
   * Get secret metadata by name (latest non-deleted version). Never returns decrypted value.
   */
  async getSecret(tenantId: string, name: string): Promise<SecretMetadata | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.tenantId, tenantId), eq(secrets.name, name), isNull(secrets.deletedAt)))
      .orderBy(desc(secrets.version))
      .limit(1);

    return row ? this.toMetadata(row) : null;
  }

  /**
   * Get secret metadata by ID. Never returns decrypted value.
   */
  async getSecretById(tenantId: string, secretId: string): Promise<SecretMetadata | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(secrets)
      .where(
        and(eq(secrets.id, secretId), eq(secrets.tenantId, tenantId), isNull(secrets.deletedAt)),
      );

    return row ? this.toMetadata(row) : null;
  }

  /**
   * Decrypt a secret for internal use (credential injection). NEVER expose via API.
   */
  async decryptSecret(tenantId: string, secretId: string): Promise<string> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(secrets)
      .where(
        and(eq(secrets.id, secretId), eq(secrets.tenantId, tenantId), isNull(secrets.deletedAt)),
      );

    if (!row) {
      throw new Error(`Secret ${secretId} not found for tenant ${tenantId}`);
    }

    // Check expiration
    if (row.expiresAt && row.expiresAt < new Date()) {
      throw new Error(`Secret ${secretId} has expired`);
    }

    const encrypted: EncryptedKey = {
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.authTag,
      salt: row.salt,
    };

    return this.keyStore.decrypt(encrypted);
  }

  /**
   * Rotate a secret — creates a new version with updated ciphertext.
   */
  async rotateSecret(tenantId: string, name: string, newValue: string): Promise<SecretMetadata> {
    const db = getDb();

    // Find current version
    const current = await this.getSecret(tenantId, name);
    if (!current) {
      throw new Error(`Secret "${name}" not found for tenant ${tenantId}`);
    }

    const encrypted = this.keyStore.encrypt(newValue);
    const newVersion = current.version + 1;

    const [row] = await db
      .insert(secrets)
      .values({
        tenantId,
        name,
        description: current.description,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.tag,
        salt: encrypted.salt,
        version: newVersion,
        rotatedAt: new Date(),
        expiresAt: current.expiresAt,
      })
      .returning();

    // Soft-delete old version
    await db
      .update(secrets)
      .set({ deletedAt: new Date() })
      .where(and(eq(secrets.id, current.id), eq(secrets.tenantId, tenantId)));

    return this.toMetadata(row);
  }

  /**
   * Soft-delete a secret (all versions).
   */
  async deleteSecret(tenantId: string, secretId: string): Promise<boolean> {
    const db = getDb();

    const [row] = await db
      .select()
      .from(secrets)
      .where(
        and(eq(secrets.id, secretId), eq(secrets.tenantId, tenantId), isNull(secrets.deletedAt)),
      );

    if (!row) return false;

    // Soft-delete all versions with this name
    await db
      .update(secrets)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(secrets.tenantId, tenantId), eq(secrets.name, row.name), isNull(secrets.deletedAt)),
      );

    return true;
  }

  /**
   * List all active secrets for a tenant (metadata only).
   */
  async listSecrets(tenantId: string): Promise<SecretMetadata[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.tenantId, tenantId), isNull(secrets.deletedAt)))
      .orderBy(secrets.name, desc(secrets.version));

    // Deduplicate by name — only return latest version
    const seen = new Set<string>();
    const result: SecretMetadata[] = [];
    for (const row of rows) {
      if (!seen.has(row.name)) {
        seen.add(row.name);
        result.push(this.toMetadata(row));
      }
    }
    return result;
  }

  // ─── Route management ────────────────────────────────────────────────────────

  async createRoute(
    tenantId: string,
    secretId: string,
    config: {
      hostPattern: string;
      pathPattern?: string;
      method?: string;
      injectAs: string;
      injectKey: string;
      injectFormat?: string;
      priority?: number;
      enabled?: boolean;
    },
  ): Promise<SecretRoute> {
    const db = getDb();

    // Verify secret exists and belongs to tenant
    const secret = await this.getSecretById(tenantId, secretId);
    if (!secret) {
      throw new Error(`Secret ${secretId} not found for tenant ${tenantId}`);
    }

    const [row] = await db
      .insert(secretRoutes)
      .values({
        tenantId,
        secretId,
        hostPattern: config.hostPattern,
        pathPattern: config.pathPattern ?? "/*",
        method: config.method ?? "*",
        injectAs: config.injectAs,
        injectKey: config.injectKey,
        injectFormat: config.injectFormat ?? "{value}",
        priority: config.priority ?? 0,
        enabled: config.enabled ?? true,
      })
      .returning();

    return row;
  }

  async listRoutes(tenantId: string): Promise<SecretRoute[]> {
    const db = getDb();
    return db
      .select()
      .from(secretRoutes)
      .where(eq(secretRoutes.tenantId, tenantId))
      .orderBy(desc(secretRoutes.priority));
  }

  async getRoute(tenantId: string, routeId: string): Promise<SecretRoute | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(secretRoutes)
      .where(and(eq(secretRoutes.id, routeId), eq(secretRoutes.tenantId, tenantId)));
    return row ?? null;
  }

  async updateRoute(
    tenantId: string,
    routeId: string,
    updates: Partial<{
      hostPattern: string;
      pathPattern: string;
      method: string;
      injectAs: string;
      injectKey: string;
      injectFormat: string;
      priority: number;
      enabled: boolean;
    }>,
  ): Promise<SecretRoute | null> {
    const db = getDb();
    const [row] = await db
      .update(secretRoutes)
      .set(updates)
      .where(and(eq(secretRoutes.id, routeId), eq(secretRoutes.tenantId, tenantId)))
      .returning();
    return row ?? null;
  }

  async deleteRoute(tenantId: string, routeId: string): Promise<boolean> {
    const db = getDb();
    const result = await db
      .delete(secretRoutes)
      .where(and(eq(secretRoutes.id, routeId), eq(secretRoutes.tenantId, tenantId)))
      .returning();
    return result.length > 0;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private toMetadata(row: Secret): SecretMetadata {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description,
      version: row.version,
      rotatedAt: row.rotatedAt,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
