/** Dedicated durable authorities for backup admission, ordering, and fairness. */

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentBackupGcOutbox, agentBackupObjects } from "./agent-backup-catalog";
import { agentNodeIncarnationHistories } from "./agent-node-incarnation-histories";
import { agentSandboxBackups, agentSandboxes } from "./agent-sandboxes";
import { organizations } from "./organizations";

const pgSnapshot = customType<{ data: string }>({
  dataType() {
    return "pg_snapshot";
  },
});

const pgXid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});

export const AGENT_BACKUP_ADMISSION_SHARD_COUNT = 64;
export const MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS = 12;

export const AGENT_BACKUP_ADMISSION_WORK_KINDS = [
  "schedule_capture",
  "catalog_operation",
  "gc_object",
] as const;

export type AgentBackupAdmissionWorkKind = (typeof AGENT_BACKUP_ADMISSION_WORK_KINDS)[number];

export const AGENT_BACKUP_ADMISSION_WORK_STAGES = [
  "reserve_capture",
  "capture",
  "primary_publication",
  "primary_verification",
  "secondary_replication",
  "deletion_prepare",
  "delete_object",
  "deletion_finalize",
] as const;

export type AgentBackupAdmissionWorkStage = (typeof AGENT_BACKUP_ADMISSION_WORK_STAGES)[number];

export const AGENT_BACKUP_ADMISSION_PRIORITY_CLASSES = [
  "lifecycle_safety",
  "active_rpo",
  "drain_recovery",
  "periodic_capture",
  "secondary_replication",
  "verification_compaction",
  "garbage_collection",
] as const;

export type AgentBackupAdmissionPriorityClass =
  (typeof AGENT_BACKUP_ADMISSION_PRIORITY_CLASSES)[number];

export type AgentBackupAdmissionState = "queued" | "deferred" | "leased" | "settled";

/** One tenant lane, isolated from the hot organizations lifecycle/billing row. */
export const agentBackupOrganizationAdmissionCursors = pgTable(
  "agent_backup_organization_admission_cursors",
  {
    organization_id: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cursor_at: timestamp("cursor_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** One exact append-only source occurrence lane; reusable boot UUIDs are not authorities. */
export const agentBackupNodeAdmissionCursors = pgTable("agent_backup_node_admission_cursors", {
  node_history_id: uuid("node_history_id")
    .primaryKey()
    .references(() => agentNodeIncarnationHistories.id, { onDelete: "restrict" }),
  cursor_at: timestamp("cursor_at", { withTimezone: true }),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Durable bounded-scan progress. A worker freezes one DB-clock cutoff and
 * resumes the exact `(source_due_at, source_id)` cursor after restart.
 */
export const agentBackupAdmissionEnrollmentShards = pgTable(
  "agent_backup_admission_enrollment_shards",
  {
    work_kind: text("work_kind").$type<AgentBackupAdmissionWorkKind>().notNull(),
    shard_id: smallint("shard_id").notNull(),
    scan_cutoff_at: timestamp("scan_cutoff_at", { withTimezone: true }),
    scan_snapshot: pgSnapshot("scan_snapshot"),
    scan_cursor_due_at: timestamp("scan_cursor_due_at", { withTimezone: true }),
    scan_cursor_id: uuid("scan_cursor_id"),
    scan_cursor_ordinal: integer("scan_cursor_ordinal"),
    scan_schedule_rpo_ms: integer("scan_schedule_rpo_ms"),
    active_cohort: bigint("active_cohort", { mode: "bigint" }),
    lease_owner: text("lease_owner"),
    lease_generation: uuid("lease_generation"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "agent_backup_admission_enrollment_shards_pkey",
      columns: [table.work_kind, table.shard_id],
    }),
    bounds_check: check(
      "agent_backup_admission_enrollment_shards_bounds_check",
      sql`(${table.work_kind} IN ('schedule_capture', 'catalog_operation', 'gc_object')
        AND ${table.shard_id} BETWEEN 0 AND ${AGENT_BACKUP_ADMISSION_SHARD_COUNT - 1}
      ) IS TRUE`,
    ),
    scan_shape_check: check(
      "agent_backup_admission_enrollment_shards_scan_shape_check",
      sql`((
        ${table.scan_cutoff_at} IS NULL
        AND ${table.scan_cursor_due_at} IS NULL
        AND ${table.scan_cursor_id} IS NULL
        AND ${table.scan_cursor_ordinal} IS NULL
        AND ${table.scan_snapshot} IS NULL
        AND ${table.scan_schedule_rpo_ms} IS NULL
        AND ${table.active_cohort} IS NULL
      ) OR (
        ${table.scan_cutoff_at} IS NOT NULL
        AND ${table.scan_snapshot} IS NOT NULL
        AND ${table.active_cohort} IS NOT NULL
        AND ${table.active_cohort} >= 0
        AND (
          (${table.work_kind} = 'schedule_capture'
            AND ${table.scan_schedule_rpo_ms} BETWEEN 60000 AND 900000)
          OR (${table.work_kind} <> 'schedule_capture'
            AND ${table.scan_schedule_rpo_ms} IS NULL)
        )
        AND (
          (${table.scan_cursor_due_at} IS NULL
            AND ${table.scan_cursor_id} IS NULL
            AND ${table.scan_cursor_ordinal} IS NULL)
          OR (
            ${table.scan_cursor_due_at} IS NOT NULL
            AND ${table.scan_cursor_due_at} <= ${table.scan_cutoff_at}
            AND ${table.scan_cursor_id} IS NOT NULL
            AND ${table.scan_cursor_ordinal} IS NOT NULL
            AND ${table.scan_cursor_ordinal} >= 0
            AND agent_backup_admission_expected_shard(${table.scan_cursor_id}) = ${table.shard_id}
          )
        )
      )) IS TRUE`,
    ),
    lease_shape_check: check(
      "agent_backup_admission_enrollment_shards_lease_shape_check",
      sql`((
        ${table.lease_owner} IS NULL
        AND ${table.lease_generation} IS NULL
        AND ${table.lease_expires_at} IS NULL
      ) OR (
        ${table.lease_owner} = btrim(${table.lease_owner})
        AND octet_length(${table.lease_owner}) BETWEEN 1 AND 128
        AND ${table.lease_owner} !~ '[[:cntrl:]]'
        AND ${table.lease_generation} IS NOT NULL
        AND ${table.lease_expires_at} IS NOT NULL
      )) IS TRUE`,
    ),
  }),
);

/**
 * Durable claim-cycle progress. Row locks own one bounded shard turn; the
 * frozen high-water and cursor make every priority pass restartable.
 */
export const agentBackupAdmissionClaimShards = pgTable(
  "agent_backup_admission_claim_shards",
  {
    work_kind: text("work_kind").$type<AgentBackupAdmissionWorkKind>().notNull(),
    shard_id: smallint("shard_id").notNull(),
    last_turn: bigint("last_turn", { mode: "bigint" }).notNull().default(0n),
    /** Start turn and DB-clock high-water for one bounded deferred/lease recovery sweep. */
    recovery_start_turn: bigint("recovery_start_turn", { mode: "bigint" }),
    recovery_cutoff_at: timestamp("recovery_cutoff_at", { withTimezone: true }),
    recovery_cursor_at: timestamp("recovery_cursor_at", { withTimezone: true }),
    /** `0` is deferred readiness and `1` is expired-lease readiness at an equal timestamp. */
    recovery_cursor_state: smallint("recovery_cursor_state"),
    recovery_cursor_id: uuid("recovery_cursor_id"),
    /** At most one recovery sweep may interrupt the same frozen claim cycle. */
    last_recovery_claim_cycle_start_turn: bigint("last_recovery_claim_cycle_start_turn", {
      mode: "bigint",
    }),
    cycle_start_turn: bigint("cycle_start_turn", { mode: "bigint" }),
    cycle_observed_at: timestamp("cycle_observed_at", { withTimezone: true }),
    cycle_max_cohort: bigint("cycle_max_cohort", { mode: "bigint" }),
    cycle_max_ordinal: integer("cycle_max_ordinal"),
    /** Opaque work-row UUID tie-breaker; the source identity, not this ID, owns the shard. */
    cycle_max_id: uuid("cycle_max_id"),
    cycle_aging_interval_ms: integer("cycle_aging_interval_ms"),
    priority_pass: smallint("priority_pass"),
    scan_cursor_cohort: bigint("scan_cursor_cohort", { mode: "bigint" }),
    scan_cursor_ordinal: integer("scan_cursor_ordinal"),
    /** Opaque work-row UUID tie-breaker within this `(work_kind, shard_id)` authority. */
    scan_cursor_id: uuid("scan_cursor_id"),
    last_admitted_work_id: uuid("last_admitted_work_id"),
    last_admission_proof_turn: bigint("last_admission_proof_turn", { mode: "bigint" }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "agent_backup_admission_claim_shards_pkey",
      columns: [table.work_kind, table.shard_id],
    }),
    turn_idx: index("agent_backup_admission_claim_shards_turn_idx").on(
      table.work_kind,
      table.last_turn,
      table.shard_id,
    ),
    bounds_check: check(
      "agent_backup_admission_claim_shards_bounds_check",
      sql`(${table.work_kind} IN ('schedule_capture', 'catalog_operation', 'gc_object')
        AND ${table.shard_id} BETWEEN 0 AND ${AGENT_BACKUP_ADMISSION_SHARD_COUNT - 1}
        AND ${table.last_turn} >= 0
      ) IS TRUE`,
    ),
    recovery_shape_check: check(
      "agent_backup_admission_claim_shards_recovery_shape_check",
      sql`((
        ${table.last_recovery_claim_cycle_start_turn} IS NULL
        OR (${table.last_recovery_claim_cycle_start_turn} > 0
          AND ${table.last_recovery_claim_cycle_start_turn} <= ${table.last_turn})
      ) AND (
        (${table.recovery_start_turn} IS NULL
          AND ${table.recovery_cutoff_at} IS NULL
          AND ${table.recovery_cursor_at} IS NULL
          AND ${table.recovery_cursor_state} IS NULL
          AND ${table.recovery_cursor_id} IS NULL)
        OR (${table.recovery_start_turn} > 0
          AND ${table.recovery_start_turn} <= ${table.last_turn}
          AND ${table.recovery_cutoff_at} IS NOT NULL
          AND (
            (${table.recovery_cursor_at} IS NULL
              AND ${table.recovery_cursor_state} IS NULL
              AND ${table.recovery_cursor_id} IS NULL)
            OR (${table.recovery_cursor_at} IS NOT NULL
              AND ${table.recovery_cursor_at} <= ${table.recovery_cutoff_at}
              AND ${table.recovery_cursor_state} BETWEEN 0 AND 1
              AND ${table.recovery_cursor_id} IS NOT NULL)
          ))
      )) IS TRUE`,
    ),
    cycle_shape_check: check(
      "agent_backup_admission_claim_shards_cycle_shape_check",
      sql`((
        ${table.cycle_observed_at} IS NULL
        AND ${table.cycle_max_cohort} IS NULL
        AND ${table.cycle_max_ordinal} IS NULL
        AND ${table.cycle_max_id} IS NULL
        AND ${table.cycle_aging_interval_ms} IS NULL
        AND ${table.priority_pass} IS NULL
        AND ${table.scan_cursor_cohort} IS NULL
        AND ${table.scan_cursor_ordinal} IS NULL
        AND ${table.scan_cursor_id} IS NULL
        AND ${table.last_admitted_work_id} IS NULL
      ) OR (
        ${table.cycle_observed_at} IS NOT NULL
        AND ${table.cycle_max_cohort} >= 0
        AND ${table.cycle_max_ordinal} >= 0
        AND ${table.cycle_max_id} IS NOT NULL
        AND ${table.cycle_aging_interval_ms} BETWEEN 60000 AND 86400000
        AND (
          (${table.work_kind} = 'schedule_capture' AND ${table.priority_pass} BETWEEN 0 AND 3)
          OR (${table.work_kind} = 'catalog_operation' AND ${table.priority_pass} BETWEEN 0 AND 5)
          OR (${table.work_kind} = 'gc_object' AND ${table.priority_pass} BETWEEN 0 AND 6)
        )
        AND (
          (${table.scan_cursor_cohort} IS NULL
            AND ${table.scan_cursor_ordinal} IS NULL
            AND ${table.scan_cursor_id} IS NULL)
          OR (${table.scan_cursor_cohort} BETWEEN 0 AND ${table.cycle_max_cohort}
            AND ${table.scan_cursor_ordinal} >= 0
            AND ${table.scan_cursor_id} IS NOT NULL
            AND (${table.scan_cursor_cohort}, ${table.scan_cursor_ordinal}, ${table.scan_cursor_id})
              <= (${table.cycle_max_cohort}, ${table.cycle_max_ordinal}, ${table.cycle_max_id}))
        )
      )) IS TRUE`,
    ),
    proof_shape_check: check(
      "agent_backup_admission_claim_shards_proof_shape_check",
      sql`((
        ${table.cycle_observed_at} IS NULL
        AND ${table.cycle_start_turn} IS NULL
        AND ${table.last_admitted_work_id} IS NULL
        AND ${table.last_admission_proof_turn} IS NULL
      ) OR (
        ${table.cycle_observed_at} IS NOT NULL
        AND ${table.cycle_start_turn} > 0
        AND ${table.cycle_start_turn} <= ${table.last_turn}
        AND (
          (${table.last_admitted_work_id} IS NULL
            AND ${table.last_admission_proof_turn} IS NULL)
          OR (${table.last_admitted_work_id} IS NOT NULL
            AND ${table.last_admission_proof_turn} > ${table.cycle_start_turn}
            AND ${table.last_admission_proof_turn} < ${table.last_turn})
        )
      )) IS TRUE`,
    ),
  }),
);

/**
 * One logical work item across scheduler reservation, catalogue execution, or
 * exact-object GC. Retry changes readiness/cohort, never the immutable identity
 * or first DB-clock eligibility instant used by age promotion.
 */
export const agentBackupAdmissionWork = pgTable(
  "agent_backup_admission_work",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    work_kind: text("work_kind").$type<AgentBackupAdmissionWorkKind>().notNull(),
    /** Immutable pipeline stage; retries never rewrite one stage into the next. */
    work_stage: text("work_stage").$type<AgentBackupAdmissionWorkStage>().notNull(),
    organization_id: uuid("organization_id").notNull(),
    sandbox_id: uuid("sandbox_id"),
    backup_id: uuid("backup_id"),
    gc_object_id: uuid("gc_object_id"),
    node_history_id: uuid("node_history_id"),
    source_activation_generation: uuid("source_activation_generation"),
    source_lifecycle_revision: bigint("source_lifecycle_revision", { mode: "bigint" }),
    source_provider_handle: text("source_provider_handle"),
    source_container_id: text("source_container_id"),
    source_image_digest: text("source_image_digest"),
    source_rpo_ms: integer("source_rpo_ms"),
    requires_node_lane: boolean("requires_node_lane").notNull(),
    priority_class: text("priority_class").$type<AgentBackupAdmissionPriorityClass>().notNull(),
    base_priority: smallint("base_priority").notNull(),
    source_due_at: timestamp("source_due_at", { withTimezone: true }).notNull(),
    rpo_deadline_at: timestamp("rpo_deadline_at", { withTimezone: true }),
    first_eligible_at: timestamp("first_eligible_at", { withTimezone: true })
      .generatedAlwaysAs(sql`"source_due_at"`)
      .notNull(),
    state: text("state").$type<AgentBackupAdmissionState>().notNull().default("queued"),
    not_before: timestamp("not_before", { withTimezone: true }).notNull().defaultNow(),
    deferred_reason: text("deferred_reason"),
    ready_cohort: bigint("ready_cohort", { mode: "bigint" }).notNull(),
    cohort_ordinal: integer("cohort_ordinal").notNull(),
    shard_id: smallint("shard_id").notNull(),
    lease_owner: text("lease_owner"),
    lease_generation: uuid("lease_generation"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    /** Zero before first claim, then the one-based attempt component of every lease fence. */
    attempts: integer("attempts").notNull().default(0),
    /** Trigger-owned durable proof of the exact claim cycle and transition. */
    claim_cycle_start_turn: bigint("claim_cycle_start_turn", { mode: "bigint" }),
    claim_proof_turn: bigint("claim_proof_turn", { mode: "bigint" }),
    claim_proof_xid: pgXid8("claim_proof_xid"),
    claim_proof_priority_pass: smallint("claim_proof_priority_pass"),
    claim_proof_attempt: integer("claim_proof_attempt"),
    settled_at: timestamp("settled_at", { withTimezone: true }),
    settled_reason: text("settled_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organization_fk: foreignKey({
      name: "agent_backup_admission_work_organization_id_fkey",
      columns: [table.organization_id],
      foreignColumns: [organizations.id],
    }).onDelete("cascade"),
    node_history_fk: foreignKey({
      name: "agent_backup_admission_work_node_history_id_fkey",
      columns: [table.node_history_id],
      foreignColumns: [agentNodeIncarnationHistories.id],
    }).onDelete("restrict"),
    sandbox_tenant_fk: foreignKey({
      name: "agent_backup_admission_work_sandbox_tenant_fkey",
      columns: [table.sandbox_id, table.organization_id],
      foreignColumns: [agentSandboxes.id, agentSandboxes.organization_id],
    }).onDelete("cascade"),
    backup_tenant_fk: foreignKey({
      name: "agent_backup_admission_work_backup_tenant_fkey",
      columns: [table.backup_id, table.organization_id],
      foreignColumns: [agentSandboxBackups.id, agentSandboxBackups.catalog_organization_id],
    }).onDelete("cascade"),
    gc_authority_fk: foreignKey({
      name: "agent_backup_admission_work_gc_authority_fkey",
      columns: [table.gc_object_id, table.work_stage],
      foreignColumns: [agentBackupGcOutbox.object_id, agentBackupGcOutbox.action],
    }).onDelete("cascade"),
    gc_object_tenant_fk: foreignKey({
      name: "agent_backup_admission_work_gc_object_tenant_fkey",
      columns: [table.gc_object_id, table.organization_id],
      foreignColumns: [agentBackupObjects.id, agentBackupObjects.organization_id],
    }).onDelete("restrict"),
    schedule_uidx: uniqueIndex("agent_backup_admission_work_schedule_uidx")
      .on(
        table.sandbox_id,
        table.node_history_id,
        table.source_activation_generation,
        table.source_lifecycle_revision,
        table.source_due_at,
      )
      .where(
        sql`${table.work_kind} = 'schedule_capture'
          AND NOT (${table.state} = 'settled'
            AND ${table.settled_reason} = 'RETRY_EXHAUSTED'
            AND ${table.attempts} = ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS})`,
      ),
    unsettled_schedule_uidx: uniqueIndex("agent_backup_admission_work_unsettled_schedule_uidx")
      .on(table.sandbox_id, table.source_activation_generation, table.source_lifecycle_revision)
      .where(sql`${table.work_kind} = 'schedule_capture' AND ${table.state} <> 'settled'`),
    operation_stage_uidx: uniqueIndex("agent_backup_admission_work_operation_stage_uidx").on(
      table.backup_id,
      table.work_stage,
    ),
    gc_uidx: uniqueIndex("agent_backup_admission_work_gc_uidx").on(
      table.gc_object_id,
      table.work_stage,
    ),
    organization_idx: index("agent_backup_admission_work_organization_idx").on(
      table.organization_id,
      table.id,
    ),
    due_idx: index("agent_backup_admission_work_due_idx")
      .on(
        table.state,
        table.not_before,
        table.base_priority,
        table.first_eligible_at,
        table.ready_cohort,
        table.cohort_ordinal,
        table.id,
      )
      .where(sql`${table.state} IN ('queued', 'deferred', 'leased')`),
    shard_idx: index("agent_backup_admission_work_shard_idx")
      .on(table.work_kind, table.shard_id, table.source_due_at, table.id)
      .where(sql`${table.state} <> 'settled'`),
    claim_scan_idx: index("agent_backup_admission_work_claim_scan_idx")
      .on(table.work_kind, table.shard_id, table.ready_cohort, table.cohort_ordinal, table.id)
      .where(sql`${table.state} = 'queued'`),
    deferred_ready_shard_idx: index("agent_backup_admission_work_deferred_ready_shard_idx")
      .on(table.work_kind, table.shard_id, table.not_before, table.id)
      .where(sql`${table.state} = 'deferred'`),
    expired_lease_shard_idx: index("agent_backup_admission_work_expired_lease_shard_idx")
      .on(table.work_kind, table.shard_id, table.lease_expires_at, table.id)
      .where(sql`${table.state} = 'leased'`),
    leased_organization_uidx: uniqueIndex("agent_backup_admission_work_leased_organization_uidx")
      .on(table.organization_id)
      .where(sql`${table.state} = 'leased'`),
    leased_node_uidx: uniqueIndex("agent_backup_admission_work_leased_node_uidx")
      .on(table.node_history_id)
      .where(sql`${table.state} = 'leased' AND ${table.node_history_id} IS NOT NULL`),
    expired_lease_idx: index("agent_backup_admission_work_expired_lease_idx")
      .on(table.lease_expires_at, table.id)
      .where(sql`${table.state} = 'leased'`),
    reference_shape_check: check(
      "agent_backup_admission_work_reference_shape_check",
      sql`((
        ${table.work_kind} = 'schedule_capture'
        AND ${table.sandbox_id} IS NOT NULL
        AND ${table.backup_id} IS NULL
        AND ${table.gc_object_id} IS NULL
      ) OR (
        ${table.work_kind} = 'catalog_operation'
        AND ${table.sandbox_id} IS NULL
        AND ${table.backup_id} IS NOT NULL
        AND ${table.gc_object_id} IS NULL
      ) OR (
        ${table.work_kind} = 'gc_object'
        AND ${table.sandbox_id} IS NULL
        AND ${table.backup_id} IS NULL
        AND ${table.gc_object_id} IS NOT NULL
      )) IS TRUE`,
    ),
    priority_check: check(
      "agent_backup_admission_work_priority_check",
      sql`((
        (${table.priority_class} = 'lifecycle_safety' AND ${table.base_priority} = 0)
        OR (${table.priority_class} = 'active_rpo' AND ${table.base_priority} = 1)
        OR (${table.priority_class} = 'drain_recovery' AND ${table.base_priority} = 2)
        OR (${table.priority_class} = 'periodic_capture' AND ${table.base_priority} = 3)
        OR (${table.priority_class} = 'secondary_replication' AND ${table.base_priority} = 4)
        OR (${table.priority_class} = 'verification_compaction' AND ${table.base_priority} = 5)
        OR (${table.priority_class} = 'garbage_collection' AND ${table.base_priority} = 6)
      ) AND (
        (${table.work_kind} = 'gc_object')
        = (${table.priority_class} = 'garbage_collection')
      )) IS TRUE`,
    ),
    stage_policy_check: check(
      "agent_backup_admission_work_stage_policy_check",
      sql`((
        ${table.work_kind} = 'schedule_capture'
        AND ${table.work_stage} = 'reserve_capture'
        AND ${table.requires_node_lane}
        AND ${table.base_priority} BETWEEN 0 AND 3
      ) OR (
        ${table.work_kind} = 'catalog_operation'
        AND ${table.work_stage} IN ('capture', 'primary_publication')
        AND ${table.requires_node_lane} = (${table.work_stage} = 'capture')
        AND ${table.base_priority} BETWEEN 0 AND 3
      ) OR (
        ${table.work_kind} = 'catalog_operation'
        AND ${table.work_stage} = 'secondary_replication'
        AND NOT ${table.requires_node_lane}
        AND ${table.base_priority} = 4
      ) OR (
        ${table.work_kind} = 'catalog_operation'
        AND ${table.work_stage} IN (
          'primary_verification', 'deletion_prepare', 'deletion_finalize'
        )
        AND NOT ${table.requires_node_lane}
        AND ${table.base_priority} = 5
      ) OR (
        ${table.work_kind} = 'gc_object'
        AND ${table.work_stage} = 'delete_object'
        AND NOT ${table.requires_node_lane}
        AND ${table.base_priority} = 6
      )) IS TRUE`,
    ),
    lane_check: check(
      "agent_backup_admission_work_lane_check",
      sql`(${table.requires_node_lane} = (${table.node_history_id} IS NOT NULL)) IS TRUE`,
    ),
    schedule_source_shape_check: check(
      "agent_backup_admission_work_schedule_source_shape_check",
      sql`((
        (${table.work_kind} = 'schedule_capture' AND
          ${table.source_activation_generation} IS NOT NULL AND
          ${table.source_lifecycle_revision} >= 0 AND
          ${table.source_provider_handle} IS NOT NULL AND
          btrim(${table.source_provider_handle}) <> '' AND
          ${table.source_provider_handle} = btrim(${table.source_provider_handle}) AND
          ${table.source_provider_handle} !~ '[[:cntrl:]]' AND
          octet_length(${table.source_provider_handle}) <= 512 AND
          ${table.source_container_id} ~ '^[0-9a-f]{64}$' AND
          ${table.source_provider_handle} <> ${table.source_container_id} AND
          ${table.source_image_digest} ~ '^sha256:[0-9a-f]{64}$' AND
          ${table.source_rpo_ms} BETWEEN 60000 AND 900000 AND
          ${table.rpo_deadline_at} IS NOT NULL AND
          ${table.rpo_deadline_at} >= ${table.source_due_at})
        OR (${table.work_kind} <> 'schedule_capture' AND
          num_nonnulls(
            ${table.source_activation_generation},
            ${table.source_lifecycle_revision},
            ${table.source_provider_handle},
            ${table.source_container_id},
            ${table.source_image_digest},
            ${table.source_rpo_ms},
            ${table.rpo_deadline_at}
          ) = 0)
      )) IS TRUE`,
    ),
    state_shape_check: check(
      "agent_backup_admission_work_state_shape_check",
      sql`((
        ${table.state} = 'queued'
        AND ${table.deferred_reason} IS NULL
        AND num_nonnulls(${table.lease_owner}, ${table.lease_generation},
          ${table.lease_expires_at}, ${table.settled_at}, ${table.settled_reason}) = 0
      ) OR (
        ${table.state} = 'deferred'
        AND ${table.deferred_reason} ~ '^[A-Z][A-Z0-9_]{0,95}$'
        AND num_nonnulls(${table.lease_owner}, ${table.lease_generation},
          ${table.lease_expires_at}, ${table.settled_at}, ${table.settled_reason}) = 0
      ) OR (
        ${table.state} = 'leased'
        AND ${table.deferred_reason} IS NULL
        AND ${table.lease_owner} = btrim(${table.lease_owner})
        AND octet_length(${table.lease_owner}) BETWEEN 1 AND 128
        AND ${table.lease_owner} !~ '[[:cntrl:]]'
        AND ${table.lease_generation} IS NOT NULL
        AND ${table.lease_expires_at} > ${table.not_before}
        AND ${table.attempts} >= 1
        AND num_nonnulls(${table.settled_at}, ${table.settled_reason}) = 0
      ) OR (
        ${table.state} = 'settled'
        AND ${table.deferred_reason} IS NULL
        AND num_nonnulls(${table.lease_owner}, ${table.lease_generation},
          ${table.lease_expires_at}) = 0
        AND ${table.settled_at} IS NOT NULL
        AND ${table.settled_reason} ~ '^[A-Z][A-Z0-9_]{0,95}$'
      )) IS TRUE`,
    ),
    retry_exhaustion_check: check(
      "agent_backup_admission_work_retry_exhaustion_check",
      sql`(${table.settled_reason} IS DISTINCT FROM 'RETRY_EXHAUSTED'
        OR (${table.work_kind} = 'schedule_capture'
          AND ${table.state} = 'settled'
          AND ${table.attempts} = ${MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS})
      ) IS TRUE`,
    ),
    counters_check: check(
      "agent_backup_admission_work_counters_check",
      sql`(${table.ready_cohort} >= 0
        AND ${table.cohort_ordinal} >= 0
        AND ${table.not_before} >= ${table.source_due_at}
        AND ${table.shard_id} BETWEEN 0 AND ${AGENT_BACKUP_ADMISSION_SHARD_COUNT - 1}
        AND ${table.shard_id} = agent_backup_admission_expected_shard(
          COALESCE(${table.sandbox_id}, ${table.backup_id}, ${table.gc_object_id})
        )
        AND ${table.attempts} >= 0
      ) IS TRUE`,
    ),
    claim_proof_shape_check: check(
      "agent_backup_admission_work_claim_proof_shape_check",
      sql`((
        ${table.attempts} = 0
        AND num_nonnulls(${table.claim_cycle_start_turn}, ${table.claim_proof_turn},
          ${table.claim_proof_xid}, ${table.claim_proof_priority_pass},
          ${table.claim_proof_attempt}) = 0
      ) OR (
        ${table.attempts} >= 1
        AND ${table.claim_cycle_start_turn} > 0
        AND ${table.claim_proof_turn} > 0
        AND ${table.claim_proof_priority_pass} >= 0
        AND ${table.claim_proof_attempt} = ${table.attempts}
        AND num_nonnulls(${table.claim_cycle_start_turn}, ${table.claim_proof_turn},
          ${table.claim_proof_xid}, ${table.claim_proof_priority_pass},
          ${table.claim_proof_attempt}) = 5
      )) IS TRUE`,
    ),
  }),
);

export type AgentBackupOrganizationAdmissionCursor = InferSelectModel<
  typeof agentBackupOrganizationAdmissionCursors
>;
export type AgentBackupNodeAdmissionCursor = InferSelectModel<
  typeof agentBackupNodeAdmissionCursors
>;
export type AgentBackupAdmissionEnrollmentShard = InferSelectModel<
  typeof agentBackupAdmissionEnrollmentShards
>;
export type AgentBackupAdmissionClaimShard = InferSelectModel<
  typeof agentBackupAdmissionClaimShards
>;
export type AgentBackupAdmissionWork = InferSelectModel<typeof agentBackupAdmissionWork>;
export type NewAgentBackupAdmissionWork = InferInsertModel<typeof agentBackupAdmissionWork>;
