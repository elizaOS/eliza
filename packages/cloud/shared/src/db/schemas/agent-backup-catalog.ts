/**
 * Durable object-level authority for v2 sandbox backups.
 *
 * `agent_sandbox_backups` remains the logical operation/catalogue row. These
 * child tables retain exact provider locators and deletion receipts so no SQL
 * row is removed before every remote object has been proven absent. Multipart
 * authority is introduced with the streaming publisher that can execute it.
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
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentBackupCatalogAuthorities, agentSandboxBackups } from "./agent-sandboxes";
import { organizations } from "./organizations";

export { agentBackupCatalogAuthorities } from "./agent-sandboxes";

export type AgentBackupCopyRole = "primary" | "secondary";
export type AgentBackupObjectTransport = "worker-r2" | "s3-compatible";
export type AgentBackupObjectProvider = "cloudflare-r2" | "hetzner-object-storage";
export type AgentBackupObjectState =
  | "reserved"
  | "uploading"
  | "present"
  | "verified"
  | "delete_pending"
  | "deleting"
  | "deleted"
  | "quarantined";

export const agentBackupObjects = pgTable(
  "agent_backup_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    backup_id: uuid("backup_id").notNull(),
    copy_role: text("copy_role").$type<AgentBackupCopyRole>().notNull(),
    component: text("component").notNull(),
    chunk_index: integer("chunk_index").notNull(),
    state: text("state").$type<AgentBackupObjectState>().notNull().default("reserved"),
    transport: text("transport").$type<AgentBackupObjectTransport>().notNull(),
    provider: text("provider").$type<AgentBackupObjectProvider>().notNull(),
    /** Stable credential/config selector; never a credential or signed URL. */
    endpoint_alias: text("endpoint_alias").notNull(),
    /** SHA-256 of the exact non-secret account/endpoint/binding authority. */
    endpoint_identity_fingerprint: text("endpoint_identity_fingerprint").notNull(),
    bucket: text("bucket").notNull(),
    region: text("region").notNull(),
    object_key: text("object_key").notNull(),
    key_fingerprint: text("key_fingerprint").notNull(),
    /** Persisted before the first provider PUT; never inferred from a later HEAD. */
    provider_write_started: boolean("provider_write_started").notNull().default(false),
    provider_version_id: text("provider_version_id"),
    /** Organization-keyed HMAC from manifest v2; raw plaintext SHA is forbidden. */
    content_hmac_sha256: text("content_hmac_sha256").notNull(),
    ciphertext_sha256: text("ciphertext_sha256").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    provider_etag: text("provider_etag"),
    provider_checksum: text("provider_checksum"),
    upload_receipt_digest: text("upload_receipt_digest"),
    delete_receipt_digest: text("delete_receipt_digest"),
    verified_at: timestamp("verified_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    backup_tenant_fk: foreignKey({
      name: "agent_backup_objects_backup_tenant_fkey",
      columns: [table.backup_id, table.organization_id],
      foreignColumns: [agentSandboxBackups.id, agentSandboxBackups.catalog_organization_id],
    }).onDelete("restrict"),
    object_tenant_unique: unique("agent_backup_objects_tenant_identity_unique").on(
      table.id,
      table.organization_id,
    ),
    chunk_copy_uidx: uniqueIndex("agent_backup_objects_chunk_copy_uidx").on(
      table.backup_id,
      table.component,
      table.chunk_index,
      table.copy_role,
    ),
    immutable_locator_uidx: uniqueIndex("agent_backup_objects_immutable_locator_uidx").on(
      table.provider,
      table.endpoint_alias,
      table.endpoint_identity_fingerprint,
      table.bucket,
      table.object_key,
    ),
    backup_state_idx: index("agent_backup_objects_backup_state_idx").on(
      table.backup_id,
      table.copy_role,
      table.state,
    ),
    state_check: check(
      "agent_backup_objects_state_check",
      sql`${table.state} IN (
        'reserved', 'uploading', 'present', 'verified',
        'delete_pending', 'deleting', 'deleted', 'quarantined'
      )`,
    ),
    copy_authority_check: check(
      "agent_backup_objects_copy_authority_check",
      sql`(${table.copy_role} = 'primary'
          AND ${table.provider} = 'cloudflare-r2'
          AND ${table.transport} IN ('worker-r2', 's3-compatible'))
        OR (${table.copy_role} = 'secondary'
          AND ${table.provider} = 'hetzner-object-storage'
          AND ${table.transport} = 's3-compatible')`,
    ),
    locator_check: check(
      "agent_backup_objects_locator_check",
      sql`${table.endpoint_alias} <> ''
        AND ${table.endpoint_identity_fingerprint} ~ '^sha256:[0-9a-f]{64}$'
        AND ${table.bucket} <> ''
        AND ${table.region} <> ''
        AND ${table.object_key} <> ''
        AND ${table.key_fingerprint} ~ '^[0-9a-f]{64}$'
        AND ${table.content_hmac_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.ciphertext_sha256} ~ '^[0-9a-f]{64}$'
        AND (${table.provider_version_id} IS NULL OR ${table.provider_version_id} <> '')
        AND (${table.provider_etag} IS NULL OR ${table.provider_etag} <> '')
        AND (${table.provider_checksum} IS NULL
          OR ${table.provider_checksum} ~ '^sha256:base64:[A-Za-z0-9+/]{43}=$')
        AND ${table.chunk_index} >= 0
        AND ${table.size_bytes} >= 0`,
    ),
    receipt_shape_check: check(
      "agent_backup_objects_receipt_shape_check",
      sql`((${table.state} NOT IN ('verified', 'deleted') OR
        (${table.state} = 'verified' AND ${table.upload_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND ${table.verified_at} IS NOT NULL) OR
        (${table.state} = 'deleted' AND ${table.delete_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND ${table.deleted_at} IS NOT NULL))) IS TRUE`,
    ),
    provider_write_authority_check: check(
      "agent_backup_objects_provider_write_authority_check",
      sql`((
        ${table.provider_write_started} = FALSE
        AND ${table.state} IN ('reserved', 'delete_pending', 'deleting', 'deleted', 'quarantined')
        AND ${table.provider_version_id} IS NULL
        AND ${table.provider_etag} IS NULL
        AND ${table.provider_checksum} IS NULL
        AND ${table.upload_receipt_digest} IS NULL
      ) OR (
        ${table.provider_write_started} = TRUE
        AND ${table.state} IN ('uploading', 'delete_pending', 'deleting', 'quarantined')
        AND ${table.provider_version_id} IS NULL
        AND ${table.provider_etag} IS NULL
        AND ${table.provider_checksum} IS NULL
        AND ${table.upload_receipt_digest} IS NULL
      ) OR (
        ${table.provider_write_started} = TRUE
        AND ${table.state} IN ('present', 'verified', 'delete_pending', 'deleting', 'deleted', 'quarantined')
        AND (${table.provider_version_id} IS NOT NULL
          OR ${table.provider_etag} IS NOT NULL
          OR ${table.provider_checksum} IS NOT NULL)
        AND ${table.upload_receipt_digest} ~ '^[0-9a-f]{64}$'
      )) IS TRUE`,
    ),
  }),
);

export type AgentBackupGcAction = "delete_object";
export type AgentBackupGcState = "pending" | "leased" | "completed" | "quarantined";

export const agentBackupGcOutbox = pgTable(
  "agent_backup_gc_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    object_id: uuid("object_id").notNull(),
    action: text("action").$type<AgentBackupGcAction>().notNull(),
    state: text("state").$type<AgentBackupGcState>().notNull().default("pending"),
    claim_owner: text("claim_owner"),
    claim_generation: uuid("claim_generation"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    expected_locator_digest: text("expected_locator_digest").notNull(),
    expected_key_fingerprint: text("expected_key_fingerprint").notNull(),
    expected_provider_version_id: text("expected_provider_version_id"),
    expected_provider_etag: text("expected_provider_etag"),
    expected_provider_checksum: text("expected_provider_checksum"),
    expected_provider_write_started: boolean("expected_provider_write_started")
      .notNull()
      .default(false),
    receipt_digest: text("receipt_digest"),
    last_error_code: text("last_error_code"),
    last_error: text("last_error"),
    last_failure_generation: uuid("last_failure_generation"),
    last_failure_digest: text("last_failure_digest"),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    object_tenant_fk: foreignKey({
      name: "agent_backup_gc_outbox_object_tenant_fkey",
      columns: [table.object_id, table.organization_id],
      foreignColumns: [agentBackupObjects.id, agentBackupObjects.organization_id],
    }).onDelete("restrict"),
    action_uidx: uniqueIndex("agent_backup_gc_outbox_action_uidx").on(
      table.object_id,
      table.action,
    ),
    state_check: check(
      "agent_backup_gc_outbox_state_check",
      sql`${table.state} IN ('pending', 'leased', 'completed', 'quarantined')
        AND ${table.action} = 'delete_object'`,
    ),
    due_idx: index("agent_backup_gc_outbox_due_idx")
      .on(table.next_attempt_at, table.created_at)
      .where(sql`${table.state} IN ('pending', 'leased')`),
    claim_shape_check: check(
      "agent_backup_gc_outbox_claim_shape_check",
      sql`(
        ${table.state} <> 'leased'
        AND ${table.claim_owner} IS NULL
        AND ${table.claim_generation} IS NULL
        AND ${table.lease_expires_at} IS NULL
      ) OR (
        ${table.state} = 'leased'
        AND ${table.claim_owner} IS NOT NULL
        AND ${table.claim_owner} <> ''
        AND ${table.claim_generation} IS NOT NULL
        AND ${table.lease_expires_at} IS NOT NULL
      )`,
    ),
    receipt_shape_check: check(
      "agent_backup_gc_outbox_receipt_shape_check",
      sql`(${table.state} <> 'completed'
          AND ${table.completed_at} IS NULL
          AND ${table.receipt_digest} IS NULL)
        OR (${table.state} = 'completed'
          AND ${table.completed_at} IS NOT NULL
          AND ${table.receipt_digest} IS NOT NULL
          AND ${table.receipt_digest} ~ '^[0-9a-f]{64}$')`,
    ),
    counters_check: check(
      "agent_backup_gc_outbox_counters_check",
      sql`${table.attempts} >= 0
        AND ${table.expected_locator_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.expected_key_fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    failure_replay_check: check(
      "agent_backup_gc_outbox_failure_replay_check",
      sql`((${table.last_failure_generation} IS NULL AND ${table.last_failure_digest} IS NULL)
        OR (${table.last_failure_generation} IS NOT NULL
          AND ${table.last_failure_digest} IS NOT NULL
          AND ${table.last_failure_digest} ~ '^[0-9a-f]{64}$')) IS TRUE`,
    ),
  }),
);

export type AgentBackupObject = InferSelectModel<typeof agentBackupObjects>;
export type AgentBackupCatalogAuthority = InferSelectModel<typeof agentBackupCatalogAuthorities>;
export type NewAgentBackupCatalogAuthority = InferInsertModel<typeof agentBackupCatalogAuthorities>;
export type NewAgentBackupObject = InferInsertModel<typeof agentBackupObjects>;
export type AgentBackupGcOutboxRow = InferSelectModel<typeof agentBackupGcOutbox>;
export type NewAgentBackupGcOutboxRow = InferInsertModel<typeof agentBackupGcOutbox>;
