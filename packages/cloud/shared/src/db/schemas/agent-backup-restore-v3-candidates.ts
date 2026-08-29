/**
 * Durable, metadata-only authority for restore-v3 isolated candidates.
 *
 * Plaintext payload bytes never enter PostgreSQL. The stage ledger retains only
 * bounded metadata, byte counts, and digests needed to make every command an
 * exact replay. Cleanup is a parent authority so it can be armed before the
 * candidate row (and therefore before any isolated plaintext is materialized).
 */

import { AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS } from "@elizaos/shared";
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  type AgentBackupCopyRole,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "./agent-backup-catalog";
import { organizations } from "./organizations";

/** The DB authority deliberately aliases the runtime-neutral contract export. */
export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_COMPONENTS =
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS;

export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_STATES = ["active", "sealed", "aborted"] as const;
export type AgentBackupRestoreV3CandidateState =
  (typeof AGENT_BACKUP_RESTORE_V3_CANDIDATE_STATES)[number];

export const AGENT_BACKUP_RESTORE_V3_STAGE_COMMAND_KINDS = ["record", "finish"] as const;
export type AgentBackupRestoreV3StageCommandKind =
  (typeof AGENT_BACKUP_RESTORE_V3_STAGE_COMMAND_KINDS)[number];

export const AGENT_BACKUP_RESTORE_V3_AUTHORIZATION_STATES = [
  "active",
  "consumed",
  "revoked",
] as const;
export type AgentBackupRestoreV3AuthorizationState =
  (typeof AGENT_BACKUP_RESTORE_V3_AUTHORIZATION_STATES)[number];

export const AGENT_BACKUP_RESTORE_V3_CLEANUP_STATES = [
  "armed",
  "held",
  "pending",
  "leased",
  "completed",
  "quarantined",
] as const;
export type AgentBackupRestoreV3CleanupState =
  (typeof AGENT_BACKUP_RESTORE_V3_CLEANUP_STATES)[number];

export const AGENT_BACKUP_RESTORE_V3_TERMINAL_COMMAND_KINDS = ["seal", "abort"] as const;
export type AgentBackupRestoreV3TerminalCommandKind =
  (typeof AGENT_BACKUP_RESTORE_V3_TERMINAL_COMMAND_KINDS)[number];

export const AGENT_BACKUP_RESTORE_V3_GC_TOMBSTONE_STATES = ["armed", "completed"] as const;
export type AgentBackupRestoreV3GcTombstoneState =
  (typeof AGENT_BACKUP_RESTORE_V3_GC_TOMBSTONE_STATES)[number];

/**
 * First durable write of `begin`: a UUID cleanup handle plus a digest of the
 * exact cleanup command. It deliberately has no candidate FK.
 */
export const agentBackupRestoreV3CandidateCleanupOutbox = pgTable(
  "agent_backup_restore_v3_candidate_cleanup_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    backup_id: uuid("backup_id").notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    operation_id: uuid("operation_id").notNull(),
    cleanup_command_sha256: text("cleanup_command_sha256").notNull(),
    state: text("state").$type<AgentBackupRestoreV3CleanupState>().notNull().default("armed"),
    claim_owner: text("claim_owner"),
    claim_generation: uuid("claim_generation"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    receipt_sha256: text("receipt_sha256"),
    quarantine_reason_sha256: text("quarantine_reason_sha256"),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    quarantined_at: timestamp("quarantined_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    authority_unique: unique("agent_backup_restore_v3_cleanup_outbox_authority_unique").on(
      table.id,
      table.organization_id,
      table.agent_id,
      table.backup_id,
      table.restore_attempt_id,
      table.operation_id,
    ),
    attempt_uidx: uniqueIndex("agent_backup_restore_v3_cleanup_outbox_attempt_uidx").on(
      table.organization_id,
      table.restore_attempt_id,
    ),
    due_idx: index("agent_backup_restore_v3_cleanup_outbox_due_idx")
      .on(table.next_attempt_at, table.created_at)
      .where(sql`${table.state} IN ('armed', 'pending', 'leased')`),
    identity_check: check(
      "agent_backup_restore_v3_cleanup_outbox_identity_check",
      sql`(${table.cleanup_command_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.attempts} >= 0
        AND ${table.next_attempt_at} >= ${table.created_at}) IS TRUE`,
    ),
    claim_shape_check: check(
      "agent_backup_restore_v3_cleanup_outbox_claim_shape_check",
      sql`((
          ${table.state} <> 'leased'
          AND ${table.claim_owner} IS NULL
          AND ${table.claim_generation} IS NULL
          AND ${table.lease_expires_at} IS NULL
        ) OR (
          ${table.state} = 'leased'
          AND btrim(${table.claim_owner}) = ${table.claim_owner}
          AND octet_length(${table.claim_owner}) BETWEEN 1 AND 255
          AND ${table.claim_generation} IS NOT NULL
          AND ${table.lease_expires_at} IS NOT NULL
        )) IS TRUE`,
    ),
    terminal_shape_check: check(
      "agent_backup_restore_v3_cleanup_outbox_terminal_shape_check",
      sql`((
          ${table.state} IN ('armed', 'held', 'pending', 'leased')
          AND num_nonnulls(${table.receipt_sha256}, ${table.quarantine_reason_sha256},
            ${table.completed_at}, ${table.quarantined_at}) = 0
        ) OR (
          ${table.state} = 'completed'
          AND ${table.receipt_sha256} ~ '^[0-9a-f]{64}$'
          AND ${table.completed_at} IS NOT NULL
          AND ${table.quarantine_reason_sha256} IS NULL
          AND ${table.quarantined_at} IS NULL
        ) OR (
          ${table.state} = 'quarantined'
          AND ${table.quarantine_reason_sha256} ~ '^[0-9a-f]{64}$'
          AND ${table.quarantined_at} IS NOT NULL
          AND ${table.receipt_sha256} IS NULL
          AND ${table.completed_at} IS NULL
        )) IS TRUE`,
    ),
  }),
);

/** One exact execution of one restore operation and lease authority. */
export const agentBackupRestoreV3Candidates = pgTable(
  "agent_backup_restore_v3_candidates",
  {
    /** Non-secret UUID staging handle. */
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    backup_id: uuid("backup_id").notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    operation_id: uuid("operation_id").notNull(),
    restore_operation_id: uuid("restore_operation_id").notNull(),
    lease_id: uuid("lease_id").notNull(),
    lease_owner_id: text("lease_owner_id").notNull(),
    /** The restore lease generation is the fencing token. */
    lease_generation: uuid("lease_generation").notNull(),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    catalog_epoch: bigint("catalog_epoch", { mode: "bigint" }).notNull(),
    source_copy_role: text("source_copy_role").$type<AgentBackupCopyRole>().notNull(),
    source_activation_generation: uuid("source_activation_generation").notNull(),
    source_lifecycle_revision: numeric("source_lifecycle_revision", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    expected_manifest_sha256: text("expected_manifest_sha256").notNull(),
    key_bundle_generation_id: uuid("key_bundle_generation_id").notNull(),
    /** Privacy-safe canonical source authority; its UTF-8 SHA-256 is DB-recomputed. */
    source_authority_canonical: text("source_authority_canonical").notNull(),
    source_authority_sha256: text("source_authority_sha256").notNull(),
    object_count: integer("object_count").notNull(),
    cleanup_outbox_id: uuid("cleanup_outbox_id").notNull(),
    /** Only a digest crosses the PostgreSQL boundary; the bearer token does not. */
    execution_token_sha256: text("execution_token_sha256").notNull(),
    state: text("state").$type<AgentBackupRestoreV3CandidateState>().notNull().default("active"),
    /** Exact canonical JSON metadata needed for sealed response-loss replay. */
    sealed_receipt_canonical: text("sealed_receipt_canonical"),
    sealed_receipt_sha256: text("sealed_receipt_sha256"),
    sealed_staged_payload_bytes: bigint("sealed_staged_payload_bytes", { mode: "number" }),
    sealed_staged_data_record_count: integer("sealed_staged_data_record_count"),
    abort_reason_sha256: text("abort_reason_sha256"),
    sealed_at: timestamp("sealed_at", { withTimezone: true }),
    aborted_at: timestamp("aborted_at", { withTimezone: true }),
    /** Terminal evidence remains replayable for a bounded 30-day window. */
    retention_until: timestamp("retention_until", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cleanup_authority_fk: foreignKey({
      name: "agent_backup_restore_v3_candidates_cleanup_authority_fkey",
      columns: [
        table.cleanup_outbox_id,
        table.organization_id,
        table.agent_id,
        table.backup_id,
        table.restore_attempt_id,
        table.operation_id,
      ],
      foreignColumns: [
        agentBackupRestoreV3CandidateCleanupOutbox.id,
        agentBackupRestoreV3CandidateCleanupOutbox.organization_id,
        agentBackupRestoreV3CandidateCleanupOutbox.agent_id,
        agentBackupRestoreV3CandidateCleanupOutbox.backup_id,
        agentBackupRestoreV3CandidateCleanupOutbox.restore_attempt_id,
        agentBackupRestoreV3CandidateCleanupOutbox.operation_id,
      ],
    }).onDelete("restrict"),
    lease_authority_fk: foreignKey({
      name: "agent_backup_restore_v3_candidates_lease_authority_fkey",
      columns: [
        table.lease_id,
        table.organization_id,
        table.agent_id,
        table.backup_id,
        table.restore_attempt_id,
        table.lease_owner_id,
        table.lease_generation,
        table.catalog_epoch,
        table.source_copy_role,
        table.operation_id,
        table.source_activation_generation,
        table.source_lifecycle_revision,
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
    operation_authority_fk: foreignKey({
      name: "agent_backup_restore_v3_candidates_operation_authority_fkey",
      columns: [
        table.restore_operation_id,
        table.organization_id,
        table.agent_id,
        table.backup_id,
        table.restore_attempt_id,
        table.lease_id,
        table.lease_owner_id,
        table.lease_generation,
        table.catalog_epoch,
        table.source_copy_role,
        table.operation_id,
        table.source_activation_generation,
        table.source_lifecycle_revision,
        table.expected_manifest_sha256,
      ],
      foreignColumns: [
        agentBackupRestoreOperations.id,
        agentBackupRestoreOperations.organization_id,
        agentBackupRestoreOperations.agent_id,
        agentBackupRestoreOperations.backup_id,
        agentBackupRestoreOperations.restore_attempt_id,
        agentBackupRestoreOperations.lease_id,
        agentBackupRestoreOperations.lease_owner_id,
        agentBackupRestoreOperations.lease_generation,
        agentBackupRestoreOperations.catalog_epoch,
        agentBackupRestoreOperations.copy_role,
        agentBackupRestoreOperations.expected_operation_id,
        agentBackupRestoreOperations.expected_activation_generation,
        agentBackupRestoreOperations.expected_lifecycle_revision,
        agentBackupRestoreOperations.expected_manifest_sha256,
      ],
    }).onDelete("restrict"),
    attempt_uidx: uniqueIndex("agent_backup_restore_v3_candidates_attempt_uidx").on(
      table.organization_id,
      table.restore_attempt_id,
    ),
    cleanup_uidx: uniqueIndex("agent_backup_restore_v3_candidates_cleanup_uidx").on(
      table.cleanup_outbox_id,
    ),
    execution_token_uidx: uniqueIndex(
      "agent_backup_restore_v3_candidates_execution_token_sha256_uidx",
    ).on(table.execution_token_sha256),
    execution_authority_unique: unique(
      "agent_backup_restore_v3_candidates_execution_authority_unique",
    ).on(
      table.id,
      table.organization_id,
      table.agent_id,
      table.backup_id,
      table.restore_attempt_id,
      table.operation_id,
      table.execution_token_sha256,
    ),
    seal_binding_unique: unique("agent_backup_restore_v3_candidates_seal_binding_unique").on(
      table.id,
      table.organization_id,
      table.agent_id,
      table.backup_id,
      table.restore_attempt_id,
      table.operation_id,
      table.execution_token_sha256,
      table.expected_manifest_sha256,
      table.key_bundle_generation_id,
      table.source_copy_role,
      table.source_authority_sha256,
      table.object_count,
    ),
    state_idx: index("agent_backup_restore_v3_candidates_state_idx").on(
      table.state,
      table.created_at,
    ),
    authority_shape_check: check(
      "agent_backup_restore_v3_candidates_authority_shape_check",
      sql`(${table.catalog_epoch} >= 0
        AND ${table.source_lifecycle_revision} BETWEEN 0 AND 18446744073709551615
        AND ${table.source_copy_role} IN ('primary', 'secondary')
        AND btrim(${table.lease_owner_id}) = ${table.lease_owner_id}
        AND octet_length(${table.lease_owner_id}) BETWEEN 1 AND 255
        AND ${table.expected_manifest_sha256} ~ '^[0-9a-f]{64}$'
        AND octet_length(${table.source_authority_canonical}) BETWEEN 2 AND 16777216
        AND ${table.source_authority_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.execution_token_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.object_count} BETWEEN 1 AND 8192
        AND ${table.lease_expires_at} > ${table.created_at}) IS TRUE`,
    ),
    terminal_shape_check: check(
      "agent_backup_restore_v3_candidates_terminal_shape_check",
      sql`((
          ${table.state} = 'active'
          AND num_nonnulls(${table.sealed_receipt_canonical}, ${table.sealed_receipt_sha256},
            ${table.sealed_staged_payload_bytes}, ${table.sealed_staged_data_record_count},
            ${table.abort_reason_sha256}, ${table.sealed_at}, ${table.aborted_at},
            ${table.retention_until}) = 0
        ) OR (
          ${table.state} = 'sealed'
          AND octet_length(${table.sealed_receipt_canonical}) BETWEEN 2 AND 16777216
          AND left(${table.sealed_receipt_canonical}, 1) = '{'
          AND right(${table.sealed_receipt_canonical}, 1) = '}'
          AND jsonb_typeof(${table.sealed_receipt_canonical}::jsonb) = 'object'
          AND ${table.sealed_receipt_sha256} ~ '^[0-9a-f]{64}$'
          AND ${table.sealed_staged_payload_bytes} BETWEEN 0 AND 1073741824
          AND ${table.sealed_staged_data_record_count} BETWEEN 0 AND 16384
          AND ${table.sealed_at} IS NOT NULL
          AND ${table.retention_until} > ${table.sealed_at}
          AND ${table.abort_reason_sha256} IS NULL
          AND ${table.aborted_at} IS NULL
        ) OR (
          ${table.state} = 'aborted'
          AND ${table.abort_reason_sha256} ~ '^[0-9a-f]{64}$'
          AND ${table.aborted_at} IS NOT NULL
          AND ${table.sealed_receipt_canonical} IS NULL
          AND ${table.sealed_receipt_sha256} IS NULL
          AND ${table.sealed_staged_payload_bytes} IS NULL
          AND ${table.sealed_staged_data_record_count} IS NULL
          AND ${table.sealed_at} IS NULL
          AND ${table.retention_until} > ${table.aborted_at}
        )) IS TRUE`,
    ),
  }),
);

/**
 * Append-only stage command ledger. Receipt metadata uses an exact scalar
 * whitelist; payload bytes remain solely in the isolated materializer.
 */
export const agentBackupRestoreV3CandidateStageLedger = pgTable(
  "agent_backup_restore_v3_candidate_stage_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    candidate_id: uuid("candidate_id").notNull(),
    organization_id: uuid("organization_id").notNull(),
    agent_id: uuid("agent_id").notNull(),
    backup_id: uuid("backup_id").notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    operation_id: uuid("operation_id").notNull(),
    execution_token_sha256: text("execution_token_sha256").notNull(),
    command_kind: text("command_kind").$type<AgentBackupRestoreV3StageCommandKind>().notNull(),
    component_index: smallint("component_index").notNull(),
    component_name: text("component_name").notNull(),
    data_index: integer("data_index"),
    offset_bytes: bigint("offset_bytes", { mode: "number" }),
    entry_path: text("entry_path"),
    entry_file_offset_bytes: bigint("entry_file_offset_bytes", { mode: "number" }),
    entry_file_size_bytes: bigint("entry_file_size_bytes", { mode: "number" }),
    entry_mode: integer("entry_mode"),
    entry_mtime_ms: bigint("entry_mtime_ms", { mode: "number" }),
    entry_metadata_sha256: text("entry_metadata_sha256"),
    payload_bytes: bigint("payload_bytes", { mode: "number" }).notNull(),
    payload_sha256: text("payload_sha256").notNull(),
    data_frame_count: integer("data_frame_count"),
    descriptor_format: text("descriptor_format"),
    descriptor_compression: text("descriptor_compression"),
    descriptor_content_kind: text("descriptor_content_kind"),
    descriptor_consistency: text("descriptor_consistency"),
    descriptor_sha256: text("descriptor_sha256"),
    record_stream_content_hmac_sha256: text("record_stream_content_hmac_sha256"),
    command_sha256: text("command_sha256").notNull(),
    receipt_sha256: text("receipt_sha256").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidate_execution_fk: foreignKey({
      name: "agent_backup_restore_v3_stage_ledger_candidate_execution_fkey",
      columns: [
        table.candidate_id,
        table.organization_id,
        table.agent_id,
        table.backup_id,
        table.restore_attempt_id,
        table.operation_id,
        table.execution_token_sha256,
      ],
      foreignColumns: [
        agentBackupRestoreV3Candidates.id,
        agentBackupRestoreV3Candidates.organization_id,
        agentBackupRestoreV3Candidates.agent_id,
        agentBackupRestoreV3Candidates.backup_id,
        agentBackupRestoreV3Candidates.restore_attempt_id,
        agentBackupRestoreV3Candidates.operation_id,
        agentBackupRestoreV3Candidates.execution_token_sha256,
      ],
    }).onDelete("restrict"),
    record_slot_uidx: uniqueIndex("agent_backup_restore_v3_stage_ledger_record_slot_uidx")
      .on(table.candidate_id, table.component_index, table.data_index)
      .where(sql`${table.command_kind} = 'record'`),
    finish_slot_uidx: uniqueIndex("agent_backup_restore_v3_stage_ledger_finish_slot_uidx")
      .on(table.candidate_id, table.component_index)
      .where(sql`${table.command_kind} = 'finish'`),
    component_idx: index("agent_backup_restore_v3_stage_ledger_component_idx").on(
      table.candidate_id,
      table.component_index,
      table.data_index,
    ),
    digest_check: check(
      "agent_backup_restore_v3_stage_ledger_digest_check",
      sql`(${table.payload_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.command_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.receipt_sha256} ~ '^[0-9a-f]{64}$') IS TRUE`,
    ),
    component_check: check(
      "agent_backup_restore_v3_stage_ledger_component_check",
      sql`((${table.component_index}, ${table.component_name}) IN (
          (0, 'character'), (1, 'database'), (2, 'media'),
          (3, 'state-files'), (4, 'vault')
        )) IS TRUE`,
    ),
    command_shape_check: check(
      "agent_backup_restore_v3_stage_ledger_command_shape_check",
      sql`((
          ${table.command_kind} = 'record'
          AND ${table.data_index} BETWEEN 0 AND 16383
          AND ${table.offset_bytes} BETWEEN 0 AND 1073741824
          AND ${table.entry_metadata_sha256} ~ '^[0-9a-f]{64}$'
          AND ((num_nonnulls(${table.entry_path}, ${table.entry_file_offset_bytes},
              ${table.entry_file_size_bytes}, ${table.entry_mode}, ${table.entry_mtime_ms}) = 0)
            OR (${table.entry_path} IS NOT NULL
              AND octet_length(${table.entry_path}) BETWEEN 1 AND 1024
              AND ${table.entry_path} !~ '(^/|(^|/)\\.\\.(/|$)|[[:cntrl:]])'
              AND ${table.entry_file_offset_bytes} BETWEEN 0 AND 1073741824
              AND ${table.entry_file_size_bytes} BETWEEN 0 AND 1073741824
              AND ${table.entry_mode} BETWEEN 0 AND 511
              AND ${table.entry_mtime_ms} >= 0
              AND num_nonnulls(${table.entry_path}, ${table.entry_file_offset_bytes},
                ${table.entry_file_size_bytes}, ${table.entry_mode}, ${table.entry_mtime_ms}) = 5))
          AND ${table.payload_bytes} BETWEEN 0 AND 262144
          AND ${table.data_frame_count} IS NULL
          AND num_nonnulls(${table.descriptor_format}, ${table.descriptor_compression},
            ${table.descriptor_content_kind}, ${table.descriptor_consistency}) = 0
          AND ${table.descriptor_sha256} IS NULL
          AND ${table.record_stream_content_hmac_sha256} IS NULL
        ) OR (
          ${table.command_kind} = 'finish'
          AND ${table.data_index} IS NULL
          AND ${table.offset_bytes} IS NULL
          AND num_nonnulls(${table.entry_path}, ${table.entry_file_offset_bytes},
            ${table.entry_file_size_bytes}, ${table.entry_mode}, ${table.entry_mtime_ms}) = 0
          AND ${table.entry_metadata_sha256} IS NULL
          AND ${table.payload_bytes} BETWEEN 0 AND 1073741824
          AND ${table.data_frame_count} BETWEEN 0 AND 16384
          AND ((${table.component_name} = 'character'
              AND ROW(${table.descriptor_format}, ${table.descriptor_compression},
                ${table.descriptor_content_kind}, ${table.descriptor_consistency}) =
                ROW('runtime-character-json-v1', 'none', 'opaque', 'best-effort'))
            OR (${table.component_name} = 'database'
              AND ROW(${table.descriptor_format}, ${table.descriptor_compression},
                ${table.descriptor_content_kind}, ${table.descriptor_consistency}) =
                ROW('pglite-data-dir-tar-gzip-v1', 'gzip', 'opaque', 'transactional'))
            OR (${table.component_name} IN ('media', 'state-files', 'vault')
              AND ROW(${table.descriptor_format}, ${table.descriptor_compression},
                ${table.descriptor_content_kind}, ${table.descriptor_consistency}) =
                ROW('file-set-v1', 'none', 'file-set', 'best-effort')))
          AND ${table.descriptor_sha256} ~ '^[0-9a-f]{64}$'
          AND ${table.record_stream_content_hmac_sha256} ~ '^[0-9a-f]{64}$'
        )) IS TRUE`,
    ),
  }),
);

/** One-shot seal proof. The bearer proof and execution token are never stored. */
export const agentBackupRestoreV3CandidateSealAuthorizations = pgTable(
  "agent_backup_restore_v3_candidate_seal_authorizations",
  {
    id: uuid("id").primaryKey(),
    candidate_id: uuid("candidate_id").notNull(),
    organization_id: uuid("organization_id").notNull(),
    agent_id: uuid("agent_id").notNull(),
    backup_id: uuid("backup_id").notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    operation_id: uuid("operation_id").notNull(),
    execution_token_sha256: text("execution_token_sha256").notNull(),
    expected_manifest_sha256: text("expected_manifest_sha256").notNull(),
    key_bundle_generation_id: uuid("key_bundle_generation_id").notNull(),
    source_copy_role: text("source_copy_role").$type<AgentBackupCopyRole>().notNull(),
    source_authority_sha256: text("source_authority_sha256").notNull(),
    object_count: integer("object_count").notNull(),
    candidate_receipt_sha256: text("candidate_receipt_sha256").notNull(),
    authorization_request_sha256: text("authorization_request_sha256").notNull(),
    proof_token_sha256: text("proof_token_sha256").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    state: text("state")
      .$type<AgentBackupRestoreV3AuthorizationState>()
      .notNull()
      .default("active"),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    revocation_reason_sha256: text("revocation_reason_sha256"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidate_binding_fk: foreignKey({
      name: "agent_backup_restore_v3_seal_auth_candidate_binding_fkey",
      columns: [
        table.candidate_id,
        table.organization_id,
        table.agent_id,
        table.backup_id,
        table.restore_attempt_id,
        table.operation_id,
        table.execution_token_sha256,
        table.expected_manifest_sha256,
        table.key_bundle_generation_id,
        table.source_copy_role,
        table.source_authority_sha256,
        table.object_count,
      ],
      foreignColumns: [
        agentBackupRestoreV3Candidates.id,
        agentBackupRestoreV3Candidates.organization_id,
        agentBackupRestoreV3Candidates.agent_id,
        agentBackupRestoreV3Candidates.backup_id,
        agentBackupRestoreV3Candidates.restore_attempt_id,
        agentBackupRestoreV3Candidates.operation_id,
        agentBackupRestoreV3Candidates.execution_token_sha256,
        agentBackupRestoreV3Candidates.expected_manifest_sha256,
        agentBackupRestoreV3Candidates.key_bundle_generation_id,
        agentBackupRestoreV3Candidates.source_copy_role,
        agentBackupRestoreV3Candidates.source_authority_sha256,
        agentBackupRestoreV3Candidates.object_count,
      ],
    }).onDelete("restrict"),
    active_candidate_uidx: uniqueIndex("agent_backup_restore_v3_seal_auth_active_candidate_uidx")
      .on(table.candidate_id)
      .where(sql`${table.state} = 'active'`),
    proof_token_uidx: uniqueIndex("agent_backup_restore_v3_seal_auth_proof_token_sha256_uidx").on(
      table.proof_token_sha256,
    ),
    terminal_command_authority_unique: unique(
      "agent_backup_restore_v3_seal_auth_terminal_command_unique",
    ).on(table.id, table.candidate_id, table.proof_token_sha256, table.candidate_receipt_sha256),
    expiry_idx: index("agent_backup_restore_v3_seal_authorizations_expiry_idx")
      .on(table.expires_at, table.created_at)
      .where(sql`${table.state} = 'active'`),
    authority_shape_check: check(
      "agent_backup_restore_v3_seal_auth_authority_shape_check",
      sql`(${table.expected_manifest_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.source_copy_role} IN ('primary', 'secondary')
        AND ${table.source_authority_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.execution_token_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.candidate_receipt_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.authorization_request_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.proof_token_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.object_count} BETWEEN 1 AND 8192
        AND ${table.expires_at} > ${table.created_at}) IS TRUE`,
    ),
    terminal_shape_check: check(
      "agent_backup_restore_v3_seal_auth_terminal_shape_check",
      sql`((
          ${table.state} = 'active'
          AND num_nonnulls(${table.consumed_at}, ${table.revoked_at},
            ${table.revocation_reason_sha256}) = 0
        ) OR (
          ${table.state} = 'consumed'
          AND ${table.consumed_at} IS NOT NULL
          AND ${table.revoked_at} IS NULL
          AND ${table.revocation_reason_sha256} IS NULL
        ) OR (
          ${table.state} = 'revoked'
          AND ${table.consumed_at} IS NULL
          AND ${table.revoked_at} IS NOT NULL
          AND ${table.revocation_reason_sha256} ~ '^[0-9a-f]{64}$'
        )) IS TRUE`,
    ),
  }),
);

/**
 * Append-only terminal command. Its insert trigger owns the canonical lock
 * order and is the only path allowed to consume/revoke a proof or terminate a
 * candidate.
 */
export const agentBackupRestoreV3CandidateTerminalCommands = pgTable(
  "agent_backup_restore_v3_candidate_terminal_commands",
  {
    id: uuid("id").primaryKey(),
    candidate_id: uuid("candidate_id").notNull(),
    organization_id: uuid("organization_id").notNull(),
    agent_id: uuid("agent_id").notNull(),
    backup_id: uuid("backup_id").notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    operation_id: uuid("operation_id").notNull(),
    execution_token_sha256: text("execution_token_sha256").notNull(),
    command_kind: text("command_kind").$type<AgentBackupRestoreV3TerminalCommandKind>().notNull(),
    authorization_id: uuid("authorization_id"),
    proof_token_sha256: text("proof_token_sha256"),
    sealed_receipt_canonical: text("sealed_receipt_canonical"),
    sealed_receipt_sha256: text("sealed_receipt_sha256"),
    abort_reason_sha256: text("abort_reason_sha256"),
    command_sha256: text("command_sha256").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidate_execution_fk: foreignKey({
      name: "agent_backup_restore_v3_terminal_candidate_execution_fkey",
      columns: [
        table.candidate_id,
        table.organization_id,
        table.agent_id,
        table.backup_id,
        table.restore_attempt_id,
        table.operation_id,
        table.execution_token_sha256,
      ],
      foreignColumns: [
        agentBackupRestoreV3Candidates.id,
        agentBackupRestoreV3Candidates.organization_id,
        agentBackupRestoreV3Candidates.agent_id,
        agentBackupRestoreV3Candidates.backup_id,
        agentBackupRestoreV3Candidates.restore_attempt_id,
        agentBackupRestoreV3Candidates.operation_id,
        agentBackupRestoreV3Candidates.execution_token_sha256,
      ],
    }).onDelete("restrict"),
    authorization_fk: foreignKey({
      name: "agent_backup_restore_v3_terminal_commands_authorization_fkey",
      columns: [
        table.authorization_id,
        table.candidate_id,
        table.proof_token_sha256,
        table.sealed_receipt_sha256,
      ],
      foreignColumns: [
        agentBackupRestoreV3CandidateSealAuthorizations.id,
        agentBackupRestoreV3CandidateSealAuthorizations.candidate_id,
        agentBackupRestoreV3CandidateSealAuthorizations.proof_token_sha256,
        agentBackupRestoreV3CandidateSealAuthorizations.candidate_receipt_sha256,
      ],
    }).onDelete("restrict"),
    candidate_uidx: uniqueIndex("agent_backup_restore_v3_terminal_commands_candidate_uidx").on(
      table.candidate_id,
    ),
    shape_check: check(
      "agent_backup_restore_v3_terminal_commands_shape_check",
      sql`(${table.execution_token_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.command_sha256} ~ '^[0-9a-f]{64}$'
        AND ((${table.command_kind} = 'seal'
            AND ${table.authorization_id} IS NOT NULL
            AND ${table.proof_token_sha256} ~ '^[0-9a-f]{64}$'
            AND octet_length(${table.sealed_receipt_canonical}) BETWEEN 2 AND 16777216
            AND ${table.sealed_receipt_sha256} ~ '^[0-9a-f]{64}$'
            AND ${table.abort_reason_sha256} IS NULL)
          OR (${table.command_kind} = 'abort'
            AND ${table.authorization_id} IS NULL
            AND ${table.proof_token_sha256} IS NULL
            AND ${table.sealed_receipt_canonical} IS NULL
            AND ${table.sealed_receipt_sha256} IS NULL
            AND ${table.abort_reason_sha256} ~ '^[0-9a-f]{64}$'))
      ) IS TRUE`,
    ),
  }),
);

/**
 * Permanent proof left by the only bounded terminal-GC path. The trigger
 * verifies the 30-day retention horizon and terminal cleanup before deleting
 * child ledgers; the tombstone itself remains immutable.
 */
export const agentBackupRestoreV3CandidateGcTombstones = pgTable(
  "agent_backup_restore_v3_candidate_gc_tombstones",
  {
    id: uuid("id").primaryKey(),
    candidate_id: uuid("candidate_id").notNull(),
    cleanup_outbox_id: uuid("cleanup_outbox_id").notNull(),
    organization_id: uuid("organization_id").notNull(),
    agent_id: uuid("agent_id").notNull(),
    backup_id: uuid("backup_id").notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    operation_id: uuid("operation_id").notNull(),
    terminal_state: text("terminal_state").$type<"sealed" | "aborted">().notNull(),
    terminal_evidence_sha256: text("terminal_evidence_sha256").notNull(),
    retention_until: timestamp("retention_until", { withTimezone: true }).notNull(),
    gc_command_sha256: text("gc_command_sha256").notNull(),
    state: text("state").$type<AgentBackupRestoreV3GcTombstoneState>().notNull().default("armed"),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidate_uidx: uniqueIndex("agent_backup_restore_v3_candidate_gc_candidate_uidx").on(
      table.candidate_id,
    ),
    tenant_idx: index("agent_backup_restore_v3_candidate_gc_tenant_idx").on(
      table.organization_id,
      table.created_at,
    ),
    shape_check: check(
      "agent_backup_restore_v3_candidate_gc_tombstones_shape_check",
      sql`(${table.terminal_state} IN ('sealed', 'aborted')
        AND ${table.terminal_evidence_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.gc_command_sha256} ~ '^[0-9a-f]{64}$'
        AND ((${table.state} = 'armed' AND ${table.completed_at} IS NULL)
          OR (${table.state} = 'completed' AND ${table.completed_at} IS NOT NULL))
      ) IS TRUE`,
    ),
  }),
);

export type AgentBackupRestoreV3CandidateCleanup = InferSelectModel<
  typeof agentBackupRestoreV3CandidateCleanupOutbox
>;
export type NewAgentBackupRestoreV3CandidateCleanup = InferInsertModel<
  typeof agentBackupRestoreV3CandidateCleanupOutbox
>;
export type AgentBackupRestoreV3Candidate = InferSelectModel<typeof agentBackupRestoreV3Candidates>;
export type NewAgentBackupRestoreV3Candidate = InferInsertModel<
  typeof agentBackupRestoreV3Candidates
>;
export type AgentBackupRestoreV3CandidateStageEntry = InferSelectModel<
  typeof agentBackupRestoreV3CandidateStageLedger
>;
export type NewAgentBackupRestoreV3CandidateStageEntry = InferInsertModel<
  typeof agentBackupRestoreV3CandidateStageLedger
>;
export type AgentBackupRestoreV3CandidateSealAuthorizationRow = InferSelectModel<
  typeof agentBackupRestoreV3CandidateSealAuthorizations
>;
export type NewAgentBackupRestoreV3CandidateSealAuthorizationRow = InferInsertModel<
  typeof agentBackupRestoreV3CandidateSealAuthorizations
>;
export type AgentBackupRestoreV3CandidateTerminalCommand = InferSelectModel<
  typeof agentBackupRestoreV3CandidateTerminalCommands
>;
export type NewAgentBackupRestoreV3CandidateTerminalCommand = InferInsertModel<
  typeof agentBackupRestoreV3CandidateTerminalCommands
>;
export type AgentBackupRestoreV3CandidateGcTombstone = InferSelectModel<
  typeof agentBackupRestoreV3CandidateGcTombstones
>;
export type NewAgentBackupRestoreV3CandidateGcTombstone = InferInsertModel<
  typeof agentBackupRestoreV3CandidateGcTombstones
>;
