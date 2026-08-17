/**
 * Defines durable idempotency, quota, provider-attempt, and reconciliation receipts for R2 mutations.
 * Copy-on-write reserves the full target and releases the full source only after safe settlement.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { type OrgStorageObjectPresence, orgStorageObjects } from "./org-storage-objects";
import { organizations } from "./organizations";

export type OrgStorageOperationKind = "put" | "delete";
export type OrgStorageOperationState =
  | "prepared"
  | "provider_started"
  | "committed"
  | "aborted"
  | "quarantined";

export const orgStorageOperations = pgTable(
  "org_storage_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    object_id: uuid("object_id").notNull(),
    operation: text("operation").$type<OrgStorageOperationKind>().notNull(),
    state: text("state").$type<OrgStorageOperationState>().notNull().default("prepared"),
    idempotency_key_hash: text("idempotency_key_hash").notNull(),
    request_digest: text("request_digest").notNull(),
    source_presence: text("source_presence").$type<OrgStorageObjectPresence>().notNull(),
    source_generation: bigint("source_generation", { mode: "bigint" }).notNull(),
    target_generation: bigint("target_generation", { mode: "bigint" }).notNull(),
    source_size_bytes: bigint("source_size_bytes", { mode: "bigint" }).notNull(),
    target_size_bytes: bigint("target_size_bytes", { mode: "bigint" }).notNull(),
    quota_delta_bytes: bigint("quota_delta_bytes", { mode: "bigint" }).notNull(),
    quota_reserved_bytes: bigint("quota_reserved_bytes", { mode: "bigint" }).notNull(),
    quota_release_bytes: bigint("quota_release_bytes", { mode: "bigint" }).notNull(),
    source_provider_version: text("source_provider_version"),
    source_provider_etag: text("source_provider_etag"),
    source_provider_key: text("source_provider_key"),
    target_content_type: text("target_content_type"),
    target_content_sha256: text("target_content_sha256"),
    target_provider_key: text("target_provider_key"),
    provider_write_started: boolean("provider_write_started").notNull().default(false),
    provider_started_at: timestamp("provider_started_at", { withTimezone: true }),
    result_provider_version: text("result_provider_version"),
    result_provider_etag: text("result_provider_etag"),
    result_size_bytes: bigint("result_size_bytes", { mode: "bigint" }),
    result_checksum_sha256: text("result_checksum_sha256"),
    result_uploaded_at: timestamp("result_uploaded_at", { withTimezone: true }),
    response_status: smallint("response_status"),
    receipt_digest: text("receipt_digest"),
    claim_owner: text("claim_owner"),
    claim_generation: uuid("claim_generation"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    last_observed_at: timestamp("last_observed_at", { withTimezone: true }),
    last_error_code: text("last_error_code"),
    last_error_digest: text("last_error_digest"),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    object_tenant_fk: foreignKey({
      name: "org_storage_operations_object_tenant_fkey",
      columns: [table.object_id, table.organization_id],
      foreignColumns: [orgStorageObjects.id, orgStorageObjects.organization_id],
    }).onDelete("restrict"),
    idempotency_uidx: uniqueIndex("org_storage_operations_idempotency_uidx").on(
      table.organization_id,
      table.idempotency_key_hash,
    ),
    generation_uidx: uniqueIndex("org_storage_operations_generation_uidx").on(
      table.object_id,
      table.target_generation,
    ),
    target_provider_key_uidx: uniqueIndex("org_storage_operations_target_provider_key_uidx")
      .on(table.target_provider_key)
      .where(sql`${table.target_provider_key} IS NOT NULL`),
    source_provider_key_idx: index("org_storage_operations_source_provider_key_idx")
      .on(table.source_provider_key)
      .where(sql`${table.source_provider_key} IS NOT NULL`),
    active_object_uidx: uniqueIndex("org_storage_operations_active_object_uidx")
      .on(table.object_id)
      .where(sql`${table.state} IN ('prepared', 'provider_started', 'quarantined')`),
    due_idx: index("org_storage_operations_due_idx")
      .on(table.next_attempt_at, table.created_at)
      .where(sql`${table.state} IN ('prepared', 'provider_started')`),
    org_state_idx: index("org_storage_operations_org_state_idx").on(
      table.organization_id,
      table.state,
      table.updated_at,
    ),
    identity_check: check(
      "org_storage_operations_identity_check",
      sql`${table.operation} IN ('put', 'delete')
        AND ${table.state} IN ('prepared', 'provider_started', 'committed', 'aborted', 'quarantined')
        AND ${table.idempotency_key_hash} ~ '^sha256:[0-9a-f]{64}$'
        AND ${table.request_digest} ~ '^sha256:[0-9a-f]{64}$'
        AND ${table.attempts} >= 0`,
    ),
    generation_check: check(
      "org_storage_operations_generation_check",
      sql`${table.source_generation} >= 0
        AND ${table.target_generation} > ${table.source_generation}
        AND ${table.source_size_bytes} >= 0 AND ${table.target_size_bytes} >= 0`,
    ),
    source_shape_check: check(
      "org_storage_operations_source_shape_check",
      sql`((
        ${table.source_presence} = 'absent' AND ${table.source_size_bytes} = 0
        AND ${table.source_provider_version} IS NULL AND ${table.source_provider_etag} IS NULL
      ) OR (
        ${table.source_presence} = 'present' AND ${table.source_generation} > 0
        AND char_length(${table.source_provider_version}) BETWEEN 1 AND 1024
        AND char_length(${table.source_provider_etag}) BETWEEN 1 AND 512
        AND ${table.source_provider_etag} !~ '["\\r\\n]'
      )) IS TRUE`,
    ),
    target_shape_check: check(
      "org_storage_operations_target_shape_check",
      sql`((
        ${table.operation} = 'put'
        AND char_length(${table.target_content_type}) BETWEEN 1 AND 255
        AND ${table.target_content_type} !~ '[\\r\\n]'
        AND ${table.target_content_sha256} ~ '^[0-9a-f]{64}$'
      ) OR (
        ${table.operation} = 'delete' AND ${table.target_size_bytes} = 0
        AND ${table.target_content_type} IS NULL AND ${table.target_content_sha256} IS NULL
      )) IS TRUE`,
    ),
    quota_shape_check: check(
      "org_storage_operations_quota_shape_check",
      sql`${table.quota_delta_bytes} = ${table.target_size_bytes} - ${table.source_size_bytes}
        AND ${table.quota_delta_bytes} = ${table.quota_reserved_bytes} - ${table.quota_release_bytes}
        AND ${table.quota_reserved_bytes} = CASE
          WHEN ${table.operation} = 'put' THEN ${table.target_size_bytes} ELSE 0 END
        AND ${table.quota_release_bytes} = ${table.source_size_bytes}`,
    ),
    provider_state_check: check(
      "org_storage_operations_provider_state_check",
      sql`${table.provider_write_started} = (${table.provider_started_at} IS NOT NULL)
        AND (${table.state} NOT IN ('prepared', 'aborted')
          OR ${table.provider_write_started} = FALSE)
        AND (${table.state} NOT IN ('provider_started', 'committed', 'quarantined')
          OR ${table.provider_write_started} = TRUE)
        AND (${table.last_observed_at} IS NULL OR ${table.provider_write_started} = TRUE)`,
    ),
    claim_shape_check: check(
      "org_storage_operations_claim_shape_check",
      sql`(
        ((${table.claim_owner} IS NULL AND ${table.claim_generation} IS NULL
          AND ${table.lease_expires_at} IS NULL)
        OR (${table.claim_owner} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
          AND ${table.claim_generation} IS NOT NULL AND ${table.lease_expires_at} IS NOT NULL))
        AND (
          ${table.state} NOT IN ('committed', 'aborted', 'quarantined')
          OR (${table.claim_owner} IS NULL AND ${table.claim_generation} IS NULL
            AND ${table.lease_expires_at} IS NULL)
        )
      ) IS TRUE`,
    ),
    error_shape_check: check(
      "org_storage_operations_error_shape_check",
      sql`(
        ((${table.last_error_code} IS NULL AND ${table.last_error_digest} IS NULL)
        OR (${table.last_error_code} ~ '^[A-Z][A-Z0-9_]{0,95}$'
          AND ${table.last_error_digest} ~ '^[0-9a-f]{64}$'))
        AND (${table.state} <> 'quarantined' OR ${table.last_error_code} IS NOT NULL)
      ) IS TRUE`,
    ),
    terminal_shape_check: check(
      "org_storage_operations_terminal_shape_check",
      sql`((
        ${table.state} IN ('committed', 'aborted') AND ${table.completed_at} IS NOT NULL
        AND ${table.receipt_digest} ~ '^[0-9a-f]{64}$' AND ${table.response_status} IS NOT NULL
        AND (${table.state} <> 'aborted' OR (${table.response_status} BETWEEN 400 AND 599
          AND ${table.last_error_code} IS NOT NULL
          AND ${table.provider_write_started} = FALSE))
      ) OR (
        ${table.state} NOT IN ('committed', 'aborted') AND ${table.completed_at} IS NULL
        AND ${table.receipt_digest} IS NULL AND ${table.response_status} IS NULL
      )) IS TRUE`,
    ),
    result_shape_check: check(
      "org_storage_operations_result_shape_check",
      sql`((
        ${table.state} = 'committed' AND ${table.operation} = 'put'
        AND ${table.response_status} = 201
        AND char_length(${table.result_provider_version}) BETWEEN 1 AND 1024
        AND (${table.source_presence} <> 'present'
          OR ${table.result_provider_version} <> ${table.source_provider_version})
        AND char_length(${table.result_provider_etag}) BETWEEN 1 AND 512
        AND ${table.result_provider_etag} !~ '["\\r\\n]'
        AND ${table.result_size_bytes} = ${table.target_size_bytes}
        AND ${table.result_checksum_sha256} = ${table.target_content_sha256}
        AND ${table.result_uploaded_at} IS NOT NULL
      ) OR (
        ${table.state} = 'committed' AND ${table.operation} = 'delete'
        AND ${table.response_status} = 204
        AND ${table.result_provider_version} IS NULL AND ${table.result_provider_etag} IS NULL
        AND ${table.result_size_bytes} IS NULL AND ${table.result_checksum_sha256} IS NULL
        AND ${table.result_uploaded_at} IS NULL
      ) OR (
        ${table.state} <> 'committed'
        AND ${table.result_provider_version} IS NULL AND ${table.result_provider_etag} IS NULL
        AND ${table.result_size_bytes} IS NULL AND ${table.result_checksum_sha256} IS NULL
        AND ${table.result_uploaded_at} IS NULL
      )) IS TRUE`,
    ),
    provider_key_shape_check: check(
      "org_storage_operations_provider_key_shape_check",
      sql`((
        (${table.source_presence} = 'absent' AND ${table.source_provider_key} IS NULL)
        OR (${table.source_presence} = 'present' AND ${table.source_provider_key} IS NOT NULL
          AND octet_length(${table.source_provider_key}) <= 1024
          AND ${table.source_provider_key} IS NFC NORMALIZED
          AND (${table.source_provider_key} = '__eliza_storage_authority/v1/org/'
            || ${table.organization_id}::text || '/' || ${table.object_id}::text || '/'
            || ${table.source_generation}::text
            OR (${table.source_generation} = 1
              AND ${table.source_provider_key} LIKE
                'org/' || ${table.organization_id}::text || '/%'
              AND char_length(${table.source_provider_key}) >
                char_length('org/' || ${table.organization_id}::text || '/')
              AND ${table.source_provider_key} !~ '[[:cntrl:]]'
              AND ${table.source_provider_key} !~ '(^|/)\\.\\.(/|$)')))
      ) AND (
        (${table.operation} = 'put' AND ${table.target_provider_key} IS NOT NULL
          AND octet_length(${table.target_provider_key}) <= 1024
          AND ${table.target_provider_key} IS NFC NORMALIZED
          AND ${table.target_provider_key} = '__eliza_storage_authority/v1/org/'
            || ${table.organization_id}::text || '/' || ${table.object_id}::text || '/'
            || ${table.target_generation}::text)
        OR (${table.operation} = 'delete' AND ${table.target_provider_key} IS NULL)
      ) AND (${table.source_provider_key} IS NULL OR ${table.target_provider_key} IS NULL
        OR ${table.source_provider_key} <> ${table.target_provider_key})
      ) IS TRUE`,
    ),
    observation_shape_check: check(
      "org_storage_operations_observation_shape_check",
      sql`(
        (${table.last_observed_at} IS NULL OR (${table.provider_started_at} IS NOT NULL
          AND ${table.last_observed_at} >= ${table.provider_started_at}))
        AND (${table.state} <> 'committed' OR ${table.source_presence} <> 'present'
          OR ${table.last_observed_at} IS NOT NULL)
        AND (${table.state} <> 'quarantined' OR ${table.last_observed_at} IS NOT NULL)
        AND (${table.state} <> 'aborted' OR ${table.last_observed_at} IS NULL)
      ) IS TRUE`,
    ),
  }),
);

export type OrgStorageOperation = InferSelectModel<typeof orgStorageOperations>;
export type NewOrgStorageOperation = InferInsertModel<typeof orgStorageOperations>;
