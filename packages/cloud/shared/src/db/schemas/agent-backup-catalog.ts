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
  numeric,
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

/** Exact, owner-bound lease over one immutable restore source. */
export const agentBackupRestoreLeases = pgTable(
  "agent_backup_restore_leases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    backup_id: uuid("backup_id").notNull(),
    operation_id: uuid("operation_id").notNull(),
    activation_generation: uuid("activation_generation").notNull(),
    lifecycle_revision: numeric("lifecycle_revision", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    expected_manifest_sha256: text("expected_manifest_sha256").notNull(),
    copy_role: text("copy_role").$type<AgentBackupCopyRole>().notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    owner_id: text("owner_id").notNull(),
    generation: uuid("generation").notNull(),
    catalog_epoch: bigint("catalog_epoch", { mode: "bigint" }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    released_at: timestamp("released_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    backup_authority_fk: foreignKey({
      name: "agent_backup_restore_leases_backup_authority_fkey",
      columns: [
        table.backup_id,
        table.organization_id,
        table.agent_id,
        table.operation_id,
        table.activation_generation,
        table.lifecycle_revision,
        table.expected_manifest_sha256,
      ],
      foreignColumns: [
        agentSandboxBackups.id,
        agentSandboxBackups.catalog_organization_id,
        agentSandboxBackups.catalog_agent_id,
        agentSandboxBackups.backup_operation_id,
        agentSandboxBackups.lifecycle_generation,
        agentSandboxBackups.lifecycle_revision,
        agentSandboxBackups.manifest_digest,
      ],
    }).onDelete("restrict"),
    catalog_authority_fk: foreignKey({
      name: "agent_backup_restore_leases_catalog_authority_fkey",
      columns: [table.organization_id, table.agent_id],
      foreignColumns: [
        agentBackupCatalogAuthorities.organization_id,
        agentBackupCatalogAuthorities.agent_id,
      ],
    }).onDelete("restrict"),
    generation_uidx: uniqueIndex("agent_backup_restore_leases_generation_uidx").on(
      table.organization_id,
      table.backup_id,
      table.generation,
    ),
    attempt_uidx: uniqueIndex("agent_backup_restore_leases_attempt_uidx").on(
      table.organization_id,
      table.restore_attempt_id,
    ),
    receipt_authority_unique: unique("agent_backup_restore_leases_receipt_authority_unique").on(
      table.id,
      table.organization_id,
      table.agent_id,
      table.backup_id,
      table.restore_attempt_id,
      table.owner_id,
      table.generation,
    ),
    operation_authority_unique: unique("agent_backup_restore_leases_operation_authority_unique").on(
      table.id,
      table.organization_id,
      table.agent_id,
      table.backup_id,
      table.restore_attempt_id,
      table.owner_id,
      table.generation,
      table.catalog_epoch,
      table.copy_role,
      table.operation_id,
      table.activation_generation,
      table.lifecycle_revision,
      table.expected_manifest_sha256,
    ),
    one_unreleased_uidx: uniqueIndex("agent_backup_restore_leases_one_unreleased_uidx")
      .on(table.organization_id, table.backup_id)
      .where(sql`${table.released_at} IS NULL`),
    active_idx: index("agent_backup_restore_leases_active_idx")
      .on(table.organization_id, table.backup_id, table.expires_at)
      .where(sql`${table.released_at} IS NULL`),
    shape_check: check(
      "agent_backup_restore_leases_shape_check",
      sql`(${table.owner_id} = btrim(${table.owner_id})
        AND octet_length(${table.owner_id}) BETWEEN 1 AND 255
        AND ${table.lifecycle_revision} BETWEEN 0 AND 18446744073709551615
        AND ${table.catalog_epoch} >= 0
        AND ${table.expected_manifest_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.copy_role} IN ('primary', 'secondary')
        AND ${table.expires_at} > ${table.created_at}
        AND (${table.released_at} IS NULL OR ${table.released_at} >= ${table.created_at})) IS TRUE`,
    ),
  }),
);

/** Phases a restore attempt walks, in order. `failed_retryable` records the phase to re-enter. */
export type AgentBackupRestorePhase =
  | "reserved"
  | "vault_seeded"
  | "container_created"
  | "restoring"
  | "committed"
  | "restart_attested"
  | "probed"
  | "published"
  | "finalized"
  | "failed_retryable"
  | "failed_terminal";

/**
 * Durable per-attempt restore coordination. Mirrors migrations 0251/0252: the
 * `expected_*` columns pre-record each side effect's exact identity so a lost
 * response is re-verified rather than re-executed, and the fencing token is the
 * lease's own `generation` rather than a second minted token.
 */
export const agentBackupRestoreOperations = pgTable(
  "agent_backup_restore_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    backup_id: uuid("backup_id").notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    lease_id: uuid("lease_id").notNull(),
    lease_generation: uuid("lease_generation").notNull(),
    lease_owner_id: text("lease_owner_id").notNull(),
    catalog_epoch: bigint("catalog_epoch", { mode: "bigint" }).notNull(),
    copy_role: text("copy_role").$type<AgentBackupCopyRole>().notNull(),
    phase: text("phase").$type<AgentBackupRestorePhase>().notNull().default("reserved"),
    resume_phase: text("resume_phase").$type<AgentBackupRestorePhase>(),
    claim_owner: text("claim_owner"),
    claim_generation: uuid("claim_generation"),
    claim_expires_at: timestamp("claim_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    expected_manifest_sha256: text("expected_manifest_sha256").notNull(),
    expected_operation_id: uuid("expected_operation_id").notNull(),
    expected_activation_generation: uuid("expected_activation_generation").notNull(),
    expected_lifecycle_revision: numeric("expected_lifecycle_revision", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    expected_node_record_id: uuid("expected_node_record_id"),
    expected_node_incarnation: uuid("expected_node_incarnation"),
    expected_container_id: text("expected_container_id"),
    expected_image_digest: text("expected_image_digest"),
    receipt_digest: text("receipt_digest"),
    last_error_code: text("last_error_code"),
    last_error: text("last_error"),
    last_failure_generation: uuid("last_failure_generation"),
    last_failure_digest: text("last_failure_digest"),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lease_authority_fk: foreignKey({
      name: "agent_backup_restore_operations_lease_authority_fkey",
      columns: [
        table.lease_id,
        table.organization_id,
        table.agent_id,
        table.backup_id,
        table.restore_attempt_id,
        table.lease_owner_id,
        table.lease_generation,
        table.catalog_epoch,
        table.copy_role,
        table.expected_operation_id,
        table.expected_activation_generation,
        table.expected_lifecycle_revision,
        table.expected_manifest_sha256,
      ],
      foreignColumns: [
        agentBackupRestoreLeases.id,
        agentBackupRestoreLeases.organization_id,
        agentBackupRestoreLeases.agent_id,
        agentBackupRestoreLeases.backup_id,
        agentBackupRestoreLeases.restore_attempt_id,
        agentBackupRestoreLeases.owner_id,
        agentBackupRestoreLeases.generation,
        agentBackupRestoreLeases.catalog_epoch,
        agentBackupRestoreLeases.copy_role,
        agentBackupRestoreLeases.operation_id,
        agentBackupRestoreLeases.activation_generation,
        agentBackupRestoreLeases.lifecycle_revision,
        agentBackupRestoreLeases.expected_manifest_sha256,
      ],
    }).onDelete("restrict"),
    catalog_authority_fk: foreignKey({
      name: "agent_backup_restore_operations_catalog_authority_fkey",
      columns: [table.organization_id, table.agent_id],
      foreignColumns: [
        agentBackupCatalogAuthorities.organization_id,
        agentBackupCatalogAuthorities.agent_id,
      ],
    }).onDelete("restrict"),
    attempt_uidx: uniqueIndex("agent_backup_restore_operations_attempt_uidx").on(
      table.organization_id,
      table.restore_attempt_id,
    ),
    one_open_uidx: uniqueIndex("agent_backup_restore_operations_one_open_uidx")
      .on(table.organization_id, table.backup_id)
      .where(sql`${table.phase} NOT IN ('finalized', 'failed_terminal')`),
    due_idx: index("agent_backup_restore_operations_due_idx")
      .on(table.next_attempt_at, table.created_at)
      .where(sql`${table.phase} NOT IN ('finalized', 'failed_terminal')`),
    phase_check: check(
      "agent_backup_restore_operations_phase_check",
      sql`(${table.phase} IN ('reserved','vault_seeded','container_created','restoring','committed',
          'restart_attested','probed','published','finalized','failed_retryable','failed_terminal')
        AND (${table.resume_phase} IS NULL) = (${table.phase} <> 'failed_retryable')
        AND (${table.resume_phase} IS NULL OR ${table.resume_phase} IN ('reserved','vault_seeded',
          'container_created','restoring','committed','restart_attested','probed','published'))
      ) IS TRUE`,
    ),
    claim_shape_check: check(
      "agent_backup_restore_operations_claim_shape_check",
      sql`((${table.claim_owner} IS NULL AND ${table.claim_generation} IS NULL
          AND ${table.claim_expires_at} IS NULL)
        OR (${table.claim_owner} IS NOT NULL AND btrim(${table.claim_owner}) = ${table.claim_owner}
          AND octet_length(${table.claim_owner}) BETWEEN 1 AND 255
          AND ${table.claim_generation} IS NOT NULL AND ${table.claim_expires_at} IS NOT NULL)
      ) IS TRUE`,
    ),
    receipt_shape_check: check(
      "agent_backup_restore_operations_receipt_shape_check",
      sql`((${table.phase} <> 'finalized' AND ${table.completed_at} IS NULL
          AND ${table.receipt_digest} IS NULL)
        OR (${table.phase} = 'finalized' AND ${table.completed_at} IS NOT NULL
          AND ${table.receipt_digest} ~ '^[0-9a-f]{64}$')
      ) IS TRUE`,
    ),
    failure_replay_check: check(
      "agent_backup_restore_operations_failure_replay_check",
      sql`((${table.last_failure_generation} IS NULL AND ${table.last_failure_digest} IS NULL)
        OR (${table.last_failure_generation} IS NOT NULL
          AND ${table.last_failure_digest} ~ '^[0-9a-f]{64}$')
      ) IS TRUE`,
    ),
    expected_shape_check: check(
      "agent_backup_restore_operations_expected_shape_check",
      sql`(${table.attempts} >= 0
        AND ${table.catalog_epoch} >= 0
        AND ${table.expected_lifecycle_revision} BETWEEN 0 AND 18446744073709551615
        AND ${table.expected_manifest_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.copy_role} IN ('primary','secondary')
        AND btrim(${table.lease_owner_id}) = ${table.lease_owner_id}
        AND octet_length(${table.lease_owner_id}) BETWEEN 1 AND 255
        AND (${table.expected_container_id} IS NULL
          OR ${table.expected_container_id} ~ '^[0-9a-f]{64}$')
        AND (${table.expected_image_digest} IS NULL
          OR ${table.expected_image_digest} ~ '^sha256:[0-9a-f]{64}$')
        AND (${table.expected_node_record_id} IS NULL) = (${table.expected_node_incarnation} IS NULL)
      ) IS TRUE`,
    ),
  }),
);

export type AgentBackupObject = InferSelectModel<typeof agentBackupObjects>;
export type AgentBackupCatalogAuthority = InferSelectModel<typeof agentBackupCatalogAuthorities>;
export type NewAgentBackupCatalogAuthority = InferInsertModel<typeof agentBackupCatalogAuthorities>;
export type NewAgentBackupObject = InferInsertModel<typeof agentBackupObjects>;
export type AgentBackupGcOutboxRow = InferSelectModel<typeof agentBackupGcOutbox>;
export type NewAgentBackupGcOutboxRow = InferInsertModel<typeof agentBackupGcOutbox>;
export type AgentBackupRestoreLease = InferSelectModel<typeof agentBackupRestoreLeases>;
export type NewAgentBackupRestoreLease = InferInsertModel<typeof agentBackupRestoreLeases>;
export type AgentBackupRestoreOperation = InferSelectModel<typeof agentBackupRestoreOperations>;
export type NewAgentBackupRestoreOperation = InferInsertModel<typeof agentBackupRestoreOperations>;
