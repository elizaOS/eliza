/**
 * Vendor connections repository — CRUD over the `vendor_connections` table.
 *
 * Tokens are encrypted using `getEncryptionService()` (envelope encryption,
 * AES-256-GCM). Plaintext access/refresh tokens never leave this module
 * unless the caller explicitly invokes `getDecryptedTokens`.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { getEncryptionService } from "../../lib/services/secrets/encryption";
import { db } from "../client";
import {
  type VendorConnection,
  type VendorConnectionMetadata,
  vendorConnections,
} from "../schemas/vendor-connections";

interface UpsertConnectionInput {
  organizationId: string;
  vendor: string;
  label: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  metadata: VendorConnectionMetadata;
}

interface UpdateTokensInput {
  connectionId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes?: string[];
}

interface DecryptedTokens {
  accessToken: string;
  refreshToken: string | null;
}

export function buildOrgBoundAccessTokenAad(organizationId: string, connectionId: string): string {
  return `vendor_connections|${organizationId}|${connectionId}|access_token`;
}

export const vendorConnectionsRepository = {
  /**
   * Store a non-refreshable credential with GCM AAD bound to its tenant and
   * opaque connection id. This is the required path for Plaid Item tokens.
   */
  async upsertOrgBoundAccessToken(
    input: Omit<UpsertConnectionInput, "refreshToken">,
  ): Promise<VendorConnection> {
    const existing = await this.findByVendorLabel(input.organizationId, input.vendor, input.label);
    const connectionId = existing?.id ?? crypto.randomUUID();
    const encryption = getEncryptionService();
    const encrypted = await encryption.encrypt(
      input.accessToken,
      buildOrgBoundAccessTokenAad(input.organizationId, connectionId),
    );
    const metadata: VendorConnectionMetadata = {
      ...input.metadata,
      encryption_context: "org_bound_v1",
    };

    if (existing) {
      const [updated] = await db
        .update(vendorConnections)
        .set({
          access_token_encrypted: encrypted.encryptedValue,
          refresh_token_encrypted: null,
          encrypted_dek: encrypted.encryptedDek,
          token_nonce: encrypted.nonce,
          token_auth_tag: encrypted.authTag,
          encryption_key_id: encrypted.keyId,
          expires_at: input.expiresAt,
          scopes: input.scopes,
          connection_metadata: metadata,
          deleted_at: null,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(vendorConnections.id, connectionId),
            eq(vendorConnections.organization_id, input.organizationId),
          ),
        )
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(vendorConnections)
      .values({
        id: connectionId,
        organization_id: input.organizationId,
        vendor: input.vendor,
        label: input.label,
        access_token_encrypted: encrypted.encryptedValue,
        refresh_token_encrypted: null,
        encrypted_dek: encrypted.encryptedDek,
        token_nonce: encrypted.nonce,
        token_auth_tag: encrypted.authTag,
        encryption_key_id: encrypted.keyId,
        expires_at: input.expiresAt,
        scopes: input.scopes,
        connection_metadata: metadata,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      return created;
    }

    // A concurrent exchange for the same Item may win the unique
    // (organization, vendor, label) insert. Re-bind the credential to that
    // authoritative row id instead of revoking the Item used by the winner.
    const concurrent = await this.findByVendorLabel(
      input.organizationId,
      input.vendor,
      input.label,
    );
    if (!concurrent) {
      throw new Error("Vendor connection insert conflicted without an authoritative row.");
    }
    const rebound = await encryption.encrypt(
      input.accessToken,
      buildOrgBoundAccessTokenAad(input.organizationId, concurrent.id),
    );
    const [updated] = await db
      .update(vendorConnections)
      .set({
        access_token_encrypted: rebound.encryptedValue,
        refresh_token_encrypted: null,
        encrypted_dek: rebound.encryptedDek,
        token_nonce: rebound.nonce,
        token_auth_tag: rebound.authTag,
        encryption_key_id: rebound.keyId,
        expires_at: input.expiresAt,
        scopes: input.scopes,
        connection_metadata: metadata,
        deleted_at: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(vendorConnections.id, concurrent.id),
          eq(vendorConnections.organization_id, input.organizationId),
        ),
      )
      .returning();
    if (!updated) {
      throw new Error("Concurrent vendor connection disappeared during credential binding.");
    }
    return updated;
  },

  /** Insert or replace the connection for `(org, vendor, label)`. */
  async upsert(input: UpsertConnectionInput): Promise<VendorConnection> {
    const encryption = getEncryptionService();

    const accessEncrypted = await encryption.encrypt(input.accessToken);
    const refreshEncrypted = input.refreshToken
      ? await encryption.encrypt(input.refreshToken)
      : null;

    const existing = await this.findByVendorLabel(input.organizationId, input.vendor, input.label);

    if (existing) {
      const [updated] = await db
        .update(vendorConnections)
        .set({
          access_token_encrypted: accessEncrypted.encryptedValue,
          refresh_token_encrypted: refreshEncrypted?.encryptedValue ?? null,
          encrypted_dek: accessEncrypted.encryptedDek,
          token_nonce: accessEncrypted.nonce,
          token_auth_tag: accessEncrypted.authTag,
          encryption_key_id: accessEncrypted.keyId,
          expires_at: input.expiresAt,
          scopes: input.scopes,
          connection_metadata: input.metadata,
          updated_at: new Date(),
        })
        .where(eq(vendorConnections.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(vendorConnections)
      .values({
        organization_id: input.organizationId,
        vendor: input.vendor,
        label: input.label,
        access_token_encrypted: accessEncrypted.encryptedValue,
        refresh_token_encrypted: refreshEncrypted?.encryptedValue ?? null,
        encrypted_dek: accessEncrypted.encryptedDek,
        token_nonce: accessEncrypted.nonce,
        token_auth_tag: accessEncrypted.authTag,
        encryption_key_id: accessEncrypted.keyId,
        expires_at: input.expiresAt,
        scopes: input.scopes,
        connection_metadata: input.metadata,
      })
      .returning();
    return created;
  },

  async updateTokens(input: UpdateTokensInput): Promise<VendorConnection> {
    const encryption = getEncryptionService();
    const accessEncrypted = await encryption.encrypt(input.accessToken);
    const refreshEncrypted = input.refreshToken
      ? await encryption.encrypt(input.refreshToken)
      : null;

    const updateValues: Partial<typeof vendorConnections.$inferInsert> = {
      access_token_encrypted: accessEncrypted.encryptedValue,
      refresh_token_encrypted: refreshEncrypted?.encryptedValue ?? null,
      encrypted_dek: accessEncrypted.encryptedDek,
      token_nonce: accessEncrypted.nonce,
      token_auth_tag: accessEncrypted.authTag,
      encryption_key_id: accessEncrypted.keyId,
      expires_at: input.expiresAt,
      updated_at: new Date(),
    };
    if (input.scopes) {
      updateValues.scopes = input.scopes;
    }

    const [updated] = await db
      .update(vendorConnections)
      .set(updateValues)
      .where(eq(vendorConnections.id, input.connectionId))
      .returning();
    return updated;
  },

  async findById(id: string): Promise<VendorConnection | null> {
    const [row] = await db
      .select()
      .from(vendorConnections)
      .where(eq(vendorConnections.id, id))
      .limit(1);
    return row ?? null;
  },

  async findActiveByIdForOrganization(
    id: string,
    organizationId: string,
    vendor: string,
  ): Promise<VendorConnection | null> {
    const [row] = await db
      .select()
      .from(vendorConnections)
      .where(
        and(
          eq(vendorConnections.id, id),
          eq(vendorConnections.organization_id, organizationId),
          eq(vendorConnections.vendor, vendor),
          isNull(vendorConnections.deleted_at),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async findByVendorLabel(
    organizationId: string,
    vendor: string,
    label: string | null,
  ): Promise<VendorConnection | null> {
    const labelCondition =
      label === null ? eq(vendorConnections.label, "") : eq(vendorConnections.label, label);
    // Postgres unique index treats NULL labels as "one row, NULL"; we model
    // that with a separate query path.
    if (label === null) {
      const [row] = await db
        .select()
        .from(vendorConnections)
        .where(
          and(
            eq(vendorConnections.organization_id, organizationId),
            eq(vendorConnections.vendor, vendor),
          ),
        )
        .orderBy(desc(vendorConnections.created_at))
        .limit(1);
      return row && row.label === null ? row : null;
    }
    const [row] = await db
      .select()
      .from(vendorConnections)
      .where(
        and(
          eq(vendorConnections.organization_id, organizationId),
          eq(vendorConnections.vendor, vendor),
          labelCondition,
        ),
      )
      .limit(1);
    return row ?? null;
  },

  /** Pick the most-recently-updated connection for this `(org, vendor)`. */
  async findLatestByVendor(
    organizationId: string,
    vendor: string,
  ): Promise<VendorConnection | null> {
    const [row] = await db
      .select()
      .from(vendorConnections)
      .where(
        and(
          eq(vendorConnections.organization_id, organizationId),
          eq(vendorConnections.vendor, vendor),
        ),
      )
      .orderBy(desc(vendorConnections.updated_at))
      .limit(1);
    return row ?? null;
  },

  async listByOrganization(organizationId: string): Promise<VendorConnection[]> {
    return db
      .select()
      .from(vendorConnections)
      .where(eq(vendorConnections.organization_id, organizationId))
      .orderBy(desc(vendorConnections.updated_at));
  },

  async deleteById(id: string): Promise<boolean> {
    const result = await db
      .delete(vendorConnections)
      .where(eq(vendorConnections.id, id))
      .returning({ id: vendorConnections.id });
    return result.length > 0;
  },

  async deleteActiveByIdForOrganization(
    id: string,
    organizationId: string,
    vendor: string,
  ): Promise<boolean> {
    const result = await db
      .delete(vendorConnections)
      .where(
        and(
          eq(vendorConnections.id, id),
          eq(vendorConnections.organization_id, organizationId),
          eq(vendorConnections.vendor, vendor),
        ),
      )
      .returning({ id: vendorConnections.id });
    return result.length > 0;
  },

  async getOrgBoundAccessToken(connection: VendorConnection): Promise<string> {
    if (connection.connection_metadata.encryption_context !== "org_bound_v1") {
      throw new Error("Connection credential is not organization-bound.");
    }
    const encryption = getEncryptionService();
    return encryption.decrypt(
      {
        encryptedValue: connection.access_token_encrypted,
        encryptedDek: connection.encrypted_dek,
        nonce: connection.token_nonce,
        authTag: connection.token_auth_tag,
      },
      buildOrgBoundAccessTokenAad(connection.organization_id, connection.id),
    );
  },

  async getDecryptedTokens(connection: VendorConnection): Promise<DecryptedTokens> {
    const encryption = getEncryptionService();
    const accessToken = await encryption.decrypt({
      encryptedValue: connection.access_token_encrypted,
      encryptedDek: connection.encrypted_dek,
      nonce: connection.token_nonce,
      authTag: connection.token_auth_tag,
    });
    let refreshToken: string | null = null;
    if (connection.refresh_token_encrypted) {
      refreshToken = await encryption.decrypt({
        encryptedValue: connection.refresh_token_encrypted,
        encryptedDek: connection.encrypted_dek,
        nonce: connection.token_nonce,
        authTag: connection.token_auth_tag,
      });
    }
    return { accessToken, refreshToken };
  },
};
