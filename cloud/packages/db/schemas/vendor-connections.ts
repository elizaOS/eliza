/**
 * Vendor Connections schema.
 *
 * Stores OAuth credentials for SaaS vendors that the agent connects to via the
 * `/v1/apis/oauth/{vendor}` flow. Cloud holds the OAuth client per vendor and
 * vends short-lived tokens to the agent on demand. Tokens are encrypted at rest
 * using the same AES-256-GCM envelope encryption pattern as `discord_connections`.
 *
 * Vendors covered in Phase 5: `linear`, `shopify`, `calendly`. Future vendors
 * slot in via the `oauth-vendor-registry` without a schema change.
 */

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Vendor connection metadata (jsonb). Per-vendor shape:
 *   - shopify: `{ shop_domain: "mystore.myshopify.com" }`
 *   - linear:  `{ workspace_id: "...", workspace_name: "..." }`
 *   - calendly: `{ user_uri: "https://api.calendly.com/users/..." }`
 */
export type VendorConnectionMetadata = {
  shop_domain?: string;
  workspace_id?: string;
  workspace_name?: string;
  user_uri?: string;
};

export const vendorConnections = pgTable(
  "vendor_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    /** Lowercase vendor identifier — `linear`, `shopify`, `calendly`, etc. */
    vendor: text("vendor").notNull(),

    /**
     * Optional human-readable label. For Shopify this MUST be set to the
     * shop subdomain (e.g. `mystore`) so the same org can connect multiple
     * stores. For other vendors it's free-form ("personal", "work").
     */
    label: text("label"),

    /** Encrypted access token (envelope-encrypted; see `lib/services/secrets/encryption`). */
    access_token_encrypted: text("access_token_encrypted").notNull(),
    /** Encrypted refresh token. NULL when the vendor doesn't issue refreshes. */
    refresh_token_encrypted: text("refresh_token_encrypted"),
    /** Per-row encrypted DEK + nonce + auth tag (matches discord_connections schema). */
    encrypted_dek: text("encrypted_dek").notNull(),
    token_nonce: text("token_nonce").notNull(),
    token_auth_tag: text("token_auth_tag").notNull(),
    encryption_key_id: text("encryption_key_id").notNull(),

    /** Absolute expiry — NULL when the vendor issues tokens that don't expire. */
    expires_at: timestamp("expires_at", { withTimezone: true }),

    /** Granted scopes (denormalized from the upstream token response). */
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),

    connection_metadata: jsonb("connection_metadata")
      .$type<VendorConnectionMetadata>()
      .notNull()
      .default({}),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("vendor_connections_organization_id_idx").on(table.organization_id),
    index("vendor_connections_vendor_idx").on(table.vendor),
    /** One connection per (org, vendor, label). NULL labels collide as one row. */
    uniqueIndex("vendor_connections_org_vendor_label_unique_idx").on(
      table.organization_id,
      table.vendor,
      table.label,
    ),
  ],
);

export type VendorConnection = InferSelectModel<typeof vendorConnections>;
export type NewVendorConnection = InferInsertModel<typeof vendorConnections>;
