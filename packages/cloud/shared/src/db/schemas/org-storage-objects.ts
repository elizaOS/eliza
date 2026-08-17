/**
 * Defines the durable per-object authority used to reconcile organization-scoped R2 storage.
 * Logical generations are allocated monotonically; physical provider keys are immutable per generation.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export type OrgStorageObjectPresence = "absent" | "present";

export const orgStorageObjects = pgTable(
  "org_storage_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    storage_namespace: text("storage_namespace").notNull().default("attachment-r2-v1"),
    object_key: text("object_key").notNull(),
    key_fingerprint: text("key_fingerprint").notNull(),
    presence: text("presence").$type<OrgStorageObjectPresence>().notNull(),
    last_allocated_generation: bigint("last_allocated_generation", { mode: "bigint" })
      .notNull()
      .default(0n),
    committed_generation: bigint("committed_generation", { mode: "bigint" }).notNull().default(0n),
    size_bytes: bigint("size_bytes", { mode: "bigint" }).notNull().default(0n),
    provider_version: text("provider_version"),
    provider_etag: text("provider_etag"),
    current_provider_key: text("current_provider_key"),
    content_type: text("content_type"),
    checksum_sha256: text("checksum_sha256"),
    provider_uploaded_at: timestamp("provider_uploaded_at", { withTimezone: true }),
    verified_at: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenant_identity_unique: unique("org_storage_objects_tenant_identity_unique").on(
      table.id,
      table.organization_id,
    ),
    org_key_uidx: uniqueIndex("org_storage_objects_org_key_uidx").on(
      table.organization_id,
      table.storage_namespace,
      table.object_key,
    ),
    org_presence_key_idx: index("org_storage_objects_org_presence_key_idx").on(
      table.organization_id,
      table.presence,
      table.object_key,
    ),
    current_provider_key_uidx: uniqueIndex("org_storage_objects_current_provider_key_uidx")
      .on(table.current_provider_key)
      .where(sql`${table.current_provider_key} IS NOT NULL`),
    locator_check: check(
      "org_storage_objects_locator_check",
      sql`${table.storage_namespace} = 'attachment-r2-v1'
        AND ${table.object_key} LIKE 'org/' || ${table.organization_id}::text || '/%'
        AND char_length(${table.object_key}) >
          char_length('org/' || ${table.organization_id}::text || '/')
        AND octet_length(${table.object_key}) <= 1024
        AND ${table.object_key} IS NFC NORMALIZED
        AND ${table.object_key} !~ '[[:cntrl:]]'
        AND ${table.object_key} !~ '(^|/)\\.\\.(/|$)'
        AND ${table.key_fingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    generation_check: check(
      "org_storage_objects_generation_check",
      sql`${table.committed_generation} >= 0
        AND ${table.last_allocated_generation} >= ${table.committed_generation}
        AND ${table.size_bytes} >= 0
        AND (${table.presence} <> 'present' OR ${table.committed_generation} > 0)`,
    ),
    presence_shape_check: check(
      "org_storage_objects_presence_shape_check",
      sql`((
        ${table.presence} = 'absent' AND ${table.size_bytes} = 0
        AND ${table.provider_version} IS NULL AND ${table.provider_etag} IS NULL
        AND ${table.content_type} IS NULL AND ${table.checksum_sha256} IS NULL
        AND ${table.provider_uploaded_at} IS NULL
      ) OR (
        ${table.presence} = 'present'
        AND char_length(${table.provider_version}) BETWEEN 1 AND 1024
        AND char_length(${table.provider_etag}) BETWEEN 1 AND 512
        AND ${table.provider_etag} !~ '["\\r\\n]'
        AND char_length(${table.content_type}) BETWEEN 1 AND 255
        AND ${table.content_type} !~ '[\\r\\n]'
        AND (${table.checksum_sha256} IS NULL
          OR ${table.checksum_sha256} ~ '^[0-9a-f]{64}$')
        AND ${table.provider_uploaded_at} IS NOT NULL
      )) IS TRUE`,
    ),
    presence_check: check(
      "org_storage_objects_presence_check",
      sql`${table.presence} IN ('absent', 'present')`,
    ),
    provider_key_shape_check: check(
      "org_storage_objects_provider_key_shape_check",
      sql`((
        ${table.presence} = 'absent' AND ${table.current_provider_key} IS NULL
      ) OR (
        ${table.presence} = 'present' AND ${table.current_provider_key} IS NOT NULL
        AND octet_length(${table.current_provider_key}) <= 1024
        AND ${table.current_provider_key} IS NFC NORMALIZED
        AND (${table.current_provider_key} = '__eliza_storage_authority/v1/org/'
          || ${table.organization_id}::text || '/' || ${table.id}::text || '/'
          || ${table.committed_generation}::text
          OR (${table.committed_generation} = 1
            AND ${table.current_provider_key} = ${table.object_key}))
      )) IS TRUE`,
    ),
  }),
);

export type OrgStorageObject = InferSelectModel<typeof orgStorageObjects>;
export type NewOrgStorageObject = InferInsertModel<typeof orgStorageObjects>;
