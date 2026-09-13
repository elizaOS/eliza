/**
 * Durable node-failure evidence and the per-agent failover work that consumes it.
 *
 * A hosted Agent runs on one Docker node occurrence. When that occurrence stops
 * answering, the platform must decide whether to move the affected Agents, and
 * then move each of them exactly once, resuming rather than restarting after any
 * process death.
 *
 * The four tables split that responsibility:
 *
 * - `agent_node_failure_events` is the fault record, keyed to one immutable node
 *   occurrence (`agent_node_incarnation_histories`) so evidence about a rebooted
 *   host can never be charged to its replacement.
 * - `agent_node_failure_signals` is the append-only evidence log, one row per
 *   `(kind, source)` pair. Independence is the declared `source_class`, not the
 *   free-form source label, so two probes down one network path cannot agree
 *   their way past the corroboration floor.
 * - `agent_failover_operations` is the per-agent processing state machine: the
 *   lease that bounds executors, the frozen source authority, the referenced
 *   restore work, and the target authority that replaces it.
 * - `agent_failover_step_attempts` is the append-only progress journal. Resume
 *   reads it instead of in-process state, and every row records the lease that
 *   wrote it.
 *
 * Two invariants are structural rather than policy:
 *
 * 1. **A trigger is not proof of death.** Reachability cannot separate a dead
 *    node from a partitioned one, so safety cannot rest on the fault record. It
 *    rests on the authority chain: the source instance's real
 *    `agent_activation_publications` row is frozen when the operation opens, and
 *    `cutover` cannot be settled until a *restore* publication exists that
 *    directly succeeds it — same agent, greater `lifecycle_revision`, and
 *    `previous_activation_generation` equal to the frozen source generation. A
 *    node that comes back holds a superseded authority. Recording that chain does
 *    not isolate the old instance; only refusing it at the boundaries that write,
 *    route, and send does, and those checks are deliberately not part of this
 *    module.
 * 2. **A restore is never silently lossy and never silently empty.**
 *    `source_data_watermark_at` is the newest data instant contained in the
 *    chosen recovery source; the `restore` step cannot be settled without it, and
 *    it may only move forward, so a retry can shrink the acknowledged gap but
 *    never quietly widen it. Writes produced during the gap are reported, not
 *    merged.
 *
 * Target capacity is *not* counted here. The restore operation reserves the slot
 * on `docker_nodes.allocated_count` under its own exact-occurrence constraint; a
 * failover operation only references the result, so one recovery is never counted
 * twice.
 *
 * Publication references are single-column foreign keys for existence, with the
 * authority *chain* verified by the guard under the operation row lock. The
 * publication table's unique constraints cover different column sets than the
 * chain needs, and a partial foreign key would silently weaken to no check at
 * all. Guards live in `0388_agent_failover_guards.sql`.
 */

import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
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
import { agentBackupRestoreLeases, agentBackupRestoreOperations } from "./agent-backup-catalog";
import { agentActivationPublications } from "./agent-backup-restore-history";
import { agentNodeIncarnationHistories } from "./agent-node-incarnation-histories";
import { agentSandboxReplacementAttempts } from "./agent-sandbox-replacement-attempts";
import { agentSandboxes } from "./agent-sandboxes";
import { dockerNodes } from "./docker-nodes";

/** What was observed. Enumeration keeps an unknown kind out of the quorum. */
export type AgentNodeFailureSignalKind =
  | "node_heartbeat_expired"
  | "node_probe_unreachable"
  | "node_control_plane_unreachable"
  | "container_runtime_absent"
  | "provider_reported_failure"
  | "placement_attestation_missing";

/** The controlled observer identity. Free-form channels cannot be trusted. */
export type AgentNodeFailureSignalSource =
  | "platform_heartbeat_monitor"
  | "platform_placement_probe"
  | "platform_control_plane_probe"
  | "platform_runtime_inventory"
  | "infrastructure_provider_api";

/**
 * The declared independence class of an observer.
 *
 * Two observers in the same class share a failure domain — several platform
 * probes all fail together when one network path is cut, and their agreement says
 * nothing about the node. Only cross-class agreement corroborates.
 */
export type AgentNodeFailureSignalClass =
  | "platform_reachability"
  | "platform_runtime_state"
  | "infrastructure_provider";

/**
 * Fault-record lifecycle. `collecting` and `triggered` are open (at most one of
 * either per node occurrence). The trigger is deliberately not called
 * "confirmed": corroborated evidence starts recovery work, it does not establish
 * that the node is dead.
 */
export type AgentNodeFailureStatus = "collecting" | "triggered" | "cleared" | "inconclusive";

/** Operations a failover walks, in order. Only adjacent forward moves are legal. */
export const AGENT_FAILOVER_STEPS = [
  "isolate_source",
  "check_preconditions",
  "restore",
  "verify",
  "cutover",
  "fence_source",
] as const;

export type AgentFailoverStep = (typeof AGENT_FAILOVER_STEPS)[number];

/**
 * Operation lifecycle.
 *
 * `pending`, `running`, `awaiting_capacity`, `awaiting_reconcile`,
 * `restore_release_required` and `intervention_required` are non-terminal. Once
 * cutover is committed the terminal failure states are unreachable: the move has
 * already happened, so the only ways out are finishing the source fencing or
 * parking for an operator.
 *
 * `restore_release_required` is where a pre-cutover operation waits after its
 * capacity wait expires while it still references a restore lease. It may not go
 * terminal until that lease is released, because a terminal failover that still
 * holds restore capacity would strand the slot with no owner.
 */
export type AgentFailoverOperationStatus =
  | "pending"
  | "running"
  | "awaiting_capacity"
  | "awaiting_reconcile"
  | "restore_release_required"
  | "intervention_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked_no_backup";

/** Step-level position. `awaiting_reconcile` means an attempt was left unresolved. */
export type AgentFailoverStepState =
  | "not_started"
  | "in_progress"
  | "awaiting_reconcile"
  | "succeeded"
  | "failed";

/** Journal states. `reconciled` records the resume decision for an unresolved attempt. */
export type AgentFailoverAttemptState =
  | "started"
  | "succeeded"
  | "failed"
  | "awaiting_reconcile"
  | "reconciled"
  | "abandoned";

/** Resume decision taken after inspecting the world for an unresolved attempt. */
export type AgentFailoverReconcileAction = "continued" | "retried" | "abandoned";

/** Why an operation is waiting rather than running. */
export type AgentFailoverWaitReason =
  | "no_target_capacity"
  | "source_contended"
  | "restore_target_unavailable";

const SIGNAL_KIND_LIST = sql.raw(
  `('node_heartbeat_expired', 'node_probe_unreachable', 'node_control_plane_unreachable',
    'container_runtime_absent', 'provider_reported_failure', 'placement_attestation_missing')`,
);

const SIGNAL_SOURCE_LIST = sql.raw(
  `('platform_heartbeat_monitor', 'platform_placement_probe', 'platform_control_plane_probe',
    'platform_runtime_inventory', 'infrastructure_provider_api')`,
);

const SIGNAL_CLASS_LIST = sql.raw(
  `('platform_reachability', 'platform_runtime_state', 'infrastructure_provider')`,
);

const STEP_LIST = sql.raw(
  `('isolate_source', 'check_preconditions', 'restore', 'verify', 'cutover', 'fence_source')`,
);

const NON_TERMINAL_STATUS_LIST = sql.raw(`('pending', 'running', 'awaiting_capacity',
  'awaiting_reconcile', 'restore_release_required', 'intervention_required')`);

const TERMINAL_FAILURE_STATUS_LIST = sql.raw(
  `('failed', 'cancelled', 'blocked_no_backup', 'intervention_required')`,
);

const WAIT_REASON_LIST = sql.raw(
  `('no_target_capacity', 'source_contended', 'restore_target_unavailable')`,
);

const OPEN_FAILURE_STATUS_LIST = sql.raw(`('collecting', 'triggered')`);

const UINT64_MAX = sql.raw("18446744073709551615");

/**
 * One fault record per node occurrence.
 *
 * `last_observed_at` advances with every recorded signal so an operator can tell
 * a stale record from a live one. `corroboration_required` is the minimum number
 * of observations; the guard additionally demands two distinct independence
 * classes, so lowering the count can never make one failure domain sufficient.
 *
 * `cordoned_at` and `enumerated_at` are written together by the freeze: the node
 * is cordoned and the affected-Agent set is captured in one transaction, so
 * enumeration cannot race a concurrent placement.
 */
export const agentNodeFailureEvents = pgTable(
  "agent_node_failure_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    node_record_id: uuid("node_record_id").notNull(),
    node_id: text("node_id").notNull(),
    node_incarnation: uuid("node_incarnation").notNull(),
    node_history_id: uuid("node_history_id").notNull(),
    status: text("status").$type<AgentNodeFailureStatus>().notNull().default("collecting"),
    corroboration_required: integer("corroboration_required").notNull().default(2),
    first_observed_at: timestamp("first_observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    last_observed_at: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
    triggered_at: timestamp("triggered_at", { withTimezone: true }),
    cordoned_at: timestamp("cordoned_at", { withTimezone: true }),
    enumerated_at: timestamp("enumerated_at", { withTimezone: true }),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    closure_reason: text("closure_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    node_record_fk: foreignKey({
      name: "agent_node_failure_events_node_record_fkey",
      columns: [table.node_record_id],
      foreignColumns: [dockerNodes.id],
    }).onDelete("restrict"),
    occurrence_fk: foreignKey({
      name: "agent_node_failure_events_occurrence_fkey",
      columns: [table.node_history_id, table.node_record_id, table.node_incarnation],
      foreignColumns: [
        agentNodeIncarnationHistories.id,
        agentNodeIncarnationHistories.docker_node_record_id,
        agentNodeIncarnationHistories.node_incarnation,
      ],
    }).onDelete("restrict"),
    open_occurrence_uidx: uniqueIndex("agent_node_failure_events_open_occurrence_uidx")
      .on(table.node_record_id, table.node_incarnation, table.node_history_id)
      .where(sql`${table.status} IN ${OPEN_FAILURE_STATUS_LIST}`),
    occurrence_authority_unique: unique("agent_node_failure_events_occurrence_authority_unique").on(
      table.id,
      table.node_record_id,
      table.node_incarnation,
      table.node_history_id,
    ),
    open_status_idx: index("agent_node_failure_events_open_status_idx").on(
      table.status,
      table.last_observed_at,
    ),
    corroboration_floor_check: check(
      "agent_node_failure_events_corroboration_floor_check",
      sql`${table.corroboration_required} BETWEEN 2 AND 16`,
    ),
    lifecycle_shape_check: check(
      "agent_node_failure_events_lifecycle_shape_check",
      sql`(${table.node_id} = btrim(${table.node_id})
        AND octet_length(${table.node_id}) BETWEEN 1 AND 255
        AND ${table.last_observed_at} >= ${table.first_observed_at}
        AND (${table.status} <> 'triggered' OR ${table.triggered_at} IS NOT NULL)
        AND (${table.status} <> 'collecting' OR ${table.triggered_at} IS NULL)
        AND (${table.status} <> 'inconclusive' OR ${table.triggered_at} IS NULL)
        AND ((${table.status} IN ('cleared', 'inconclusive')) = (${table.closed_at} IS NOT NULL))
        AND ((${table.closure_reason} IS NULL) = (${table.closed_at} IS NULL))
        AND ((${table.cordoned_at} IS NULL) = (${table.enumerated_at} IS NULL))
        AND (${table.cordoned_at} IS NULL
          OR (${table.cordoned_at} >= ${table.created_at}
            AND ${table.enumerated_at} >= ${table.cordoned_at}))) IS TRUE`,
    ),
  }),
);

/**
 * Append-only failure evidence, one row per `(kind, source)` pair.
 *
 * `source_class` and `policy_version` are recorded with the observation so a
 * later policy change can neither re-classify old evidence nor let a newly added
 * probe inherit another probe's independence.
 */
export const agentNodeFailureSignals = pgTable(
  "agent_node_failure_signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    failure_event_id: uuid("failure_event_id").notNull(),
    kind: text("kind").$type<AgentNodeFailureSignalKind>().notNull(),
    source: text("source").$type<AgentNodeFailureSignalSource>().notNull(),
    source_class: text("source_class").$type<AgentNodeFailureSignalClass>().notNull(),
    policy_version: integer("policy_version").notNull(),
    observation_count: integer("observation_count").notNull().default(1),
    first_observed_at: timestamp("first_observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    last_observed_at: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    event_fk: foreignKey({
      name: "agent_node_failure_signals_event_fkey",
      columns: [table.failure_event_id],
      foreignColumns: [agentNodeFailureEvents.id],
    }).onDelete("cascade"),
    evidence_uidx: uniqueIndex("agent_node_failure_signals_evidence_uidx").on(
      table.failure_event_id,
      table.kind,
      table.source,
    ),
    event_class_idx: index("agent_node_failure_signals_event_class_idx").on(
      table.failure_event_id,
      table.source_class,
    ),
    shape_check: check(
      "agent_node_failure_signals_shape_check",
      sql`(${table.kind} IN ${SIGNAL_KIND_LIST}
        AND ${table.source} IN ${SIGNAL_SOURCE_LIST}
        AND ${table.source_class} IN ${SIGNAL_CLASS_LIST}
        AND ((${table.source} = 'infrastructure_provider_api'
            AND ${table.source_class} = 'infrastructure_provider')
          OR (${table.source} = 'platform_runtime_inventory'
            AND ${table.source_class} = 'platform_runtime_state')
          OR (${table.source} IN ('platform_heartbeat_monitor', 'platform_placement_probe',
              'platform_control_plane_probe')
            AND ${table.source_class} = 'platform_reachability'))
        AND ${table.policy_version} >= 1
        AND ${table.observation_count} >= 1
        AND ${table.last_observed_at} >= ${table.first_observed_at}
        AND jsonb_typeof(${table.detail}) = 'object') IS TRUE`,
    ),
  }),
);

/**
 * The frozen affected-Agent set for one triggered fault record.
 *
 * Written once, inside the transaction that cordons the node, from the
 * activation publications that actually authorize each Agent on that occurrence.
 * An operation may only be opened for a row in this set, and its source authority
 * is copied from here rather than read live — so an Agent placed after the freeze
 * is never swept in, and an Agent whose placement moved is not recovered from an
 * occurrence it no longer runs on.
 */
export const agentNodeFailureCandidates = pgTable(
  "agent_node_failure_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    failure_event_id: uuid("failure_event_id").notNull(),
    organization_id: uuid("organization_id").notNull(),
    agent_id: uuid("agent_id").notNull(),
    source_publication_id: uuid("source_publication_id").notNull(),
    source_activation_generation: uuid("source_activation_generation").notNull(),
    source_lifecycle_revision: bigint("source_lifecycle_revision", { mode: "bigint" }).notNull(),
    source_container_id: text("source_container_id").notNull(),
    source_container_name: text("source_container_name"),
    frozen_at: timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    event_fk: foreignKey({
      name: "agent_node_failure_candidates_event_fkey",
      columns: [table.failure_event_id],
      foreignColumns: [agentNodeFailureEvents.id],
    }).onDelete("cascade"),
    agent_tenant_fk: foreignKey({
      name: "agent_node_failure_candidates_agent_tenant_fkey",
      columns: [table.agent_id, table.organization_id],
      foreignColumns: [agentSandboxes.id, agentSandboxes.organization_id],
    }).onDelete("restrict"),
    // One occurrence row per Agent per fault record: the same publication may be
    // frozen again by a later, independent trigger on the same occurrence.
    publication_uidx: uniqueIndex("agent_node_failure_candidates_publication_uidx").on(
      table.failure_event_id,
      table.source_publication_id,
    ),
    candidate_uidx: unique("agent_node_failure_candidates_candidate_uidx").on(
      table.failure_event_id,
      table.agent_id,
    ),
    event_idx: index("agent_node_failure_candidates_event_idx").on(
      table.failure_event_id,
      table.frozen_at,
    ),
    shape_check: check(
      "agent_node_failure_candidates_shape_check",
      sql`(${table.source_container_id} ~ '^[0-9a-f]{64}$'
        AND ${table.source_lifecycle_revision} BETWEEN 0 AND ${UINT64_MAX}
        AND (${table.source_container_name} IS NULL
          OR (${table.source_container_name} = btrim(${table.source_container_name})
            AND octet_length(${table.source_container_name}) BETWEEN 1 AND 255))) IS TRUE`,
    ),
  }),
);

/**
 * One recovery operation for one Agent against one triggered fault record.
 *
 * The source columns name the exact instance being replaced and are immutable.
 * `source_publication_id` is bound to the real activation publication that
 * authorizes it, so the authority being superseded is a recorded fact rather
 * than a value this module invented.
 *
 * Restore references are nullable: they are written by the restore runtime that
 * owns the lease, the operation, and the target slot. This table never counts
 * capacity itself.
 *
 * `target_*` columns are the cutover identity bundle. They are written once,
 * before the first publish attempt, and never regenerated, so an unknown cutover
 * outcome can be resolved by replaying the publication with the same identities
 * instead of guessing whether it happened.
 */
export const agentFailoverOperations = pgTable(
  "agent_failover_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    failure_event_id: uuid("failure_event_id").notNull(),
    organization_id: uuid("organization_id").notNull(),
    agent_id: uuid("agent_id").notNull(),

    source_node_record_id: uuid("source_node_record_id").notNull(),
    source_node_id: text("source_node_id").notNull(),
    source_node_incarnation: uuid("source_node_incarnation").notNull(),
    source_node_history_id: uuid("source_node_history_id").notNull(),
    source_container_name: text("source_container_name"),
    source_publication_id: uuid("source_publication_id").notNull(),
    source_activation_generation: uuid("source_activation_generation").notNull(),
    source_lifecycle_revision: bigint("source_lifecycle_revision", { mode: "bigint" }).notNull(),
    source_container_id: text("source_container_id").notNull(),

    source_data_watermark_at: timestamp("source_data_watermark_at", { withTimezone: true }),

    restore_operation_id: uuid("restore_operation_id"),
    restore_lease_id: uuid("restore_lease_id"),
    restore_lease_owner: text("restore_lease_owner"),
    restore_lease_generation: uuid("restore_lease_generation"),
    replacement_attempt_id: uuid("replacement_attempt_id"),
    restore_backup_id: uuid("restore_backup_id"),
    restore_manifest_sha256: text("restore_manifest_sha256"),

    target_node_record_id: uuid("target_node_record_id"),
    target_node_incarnation: uuid("target_node_incarnation"),
    target_node_history_id: uuid("target_node_history_id"),
    target_publication_id: uuid("target_publication_id"),
    target_activation_generation: uuid("target_activation_generation"),
    target_lifecycle_revision: bigint("target_lifecycle_revision", { mode: "bigint" }),
    target_container_id: text("target_container_id"),
    target_receipt_sha256: text("target_receipt_sha256"),

    status: text("status").$type<AgentFailoverOperationStatus>().notNull().default("pending"),
    step: text("step").$type<AgentFailoverStep>().notNull().default("isolate_source"),
    step_state: text("step_state").$type<AgentFailoverStepState>().notNull().default("not_started"),

    lease_owner: text("lease_owner"),
    lease_generation: uuid("lease_generation"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    lease_heartbeat_at: timestamp("lease_heartbeat_at", { withTimezone: true }),
    claim_count: integer("claim_count").notNull().default(0),

    wait_reason: text("wait_reason").$type<AgentFailoverWaitReason>(),
    wait_deadline_at: timestamp("wait_deadline_at", { withTimezone: true }),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    post_cutover_attempts: integer("post_cutover_attempts").notNull().default(0),
    last_error_code: text("last_error_code"),
    last_error_message: text("last_error_message"),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    failure_occurrence_fk: foreignKey({
      name: "agent_failover_operations_failure_occurrence_fkey",
      columns: [
        table.failure_event_id,
        table.source_node_record_id,
        table.source_node_incarnation,
        table.source_node_history_id,
      ],
      foreignColumns: [
        agentNodeFailureEvents.id,
        agentNodeFailureEvents.node_record_id,
        agentNodeFailureEvents.node_incarnation,
        agentNodeFailureEvents.node_history_id,
      ],
    }).onDelete("restrict"),
    source_occurrence_fk: foreignKey({
      name: "agent_failover_operations_source_occurrence_fkey",
      columns: [
        table.source_node_history_id,
        table.source_node_record_id,
        table.source_node_incarnation,
      ],
      foreignColumns: [
        agentNodeIncarnationHistories.id,
        agentNodeIncarnationHistories.docker_node_record_id,
        agentNodeIncarnationHistories.node_incarnation,
      ],
    }).onDelete("restrict"),
    restore_operation_fk: foreignKey({
      name: "agent_failover_operations_restore_operation_fkey",
      columns: [table.restore_operation_id],
      foreignColumns: [agentBackupRestoreOperations.id],
    }).onDelete("restrict"),
    restore_lease_fk: foreignKey({
      name: "agent_failover_operations_restore_lease_fkey",
      columns: [table.restore_lease_id],
      foreignColumns: [agentBackupRestoreLeases.id],
    }).onDelete("restrict"),
    replacement_attempt_fk: foreignKey({
      name: "agent_failover_operations_replacement_attempt_fkey",
      columns: [table.replacement_attempt_id],
      foreignColumns: [agentSandboxReplacementAttempts.id],
    }).onDelete("restrict"),
    source_publication_fk: foreignKey({
      name: "agent_failover_operations_source_publication_fkey",
      columns: [table.source_publication_id],
      foreignColumns: [agentActivationPublications.id],
    }).onDelete("restrict"),
    target_node_fk: foreignKey({
      name: "agent_failover_operations_target_node_fkey",
      columns: [table.target_node_record_id],
      foreignColumns: [dockerNodes.id],
    }).onDelete("restrict"),
    agent_tenant_fk: foreignKey({
      name: "agent_failover_operations_agent_tenant_fkey",
      columns: [table.agent_id, table.organization_id],
      foreignColumns: [agentSandboxes.id, agentSandboxes.organization_id],
    }).onDelete("restrict"),
    active_agent_uidx: uniqueIndex("agent_failover_operations_active_agent_uidx")
      .on(table.agent_id)
      .where(sql`${table.status} IN ${NON_TERMINAL_STATUS_LIST}`),
    failure_agent_uidx: unique("agent_failover_operations_failure_agent_uidx").on(
      table.failure_event_id,
      table.agent_id,
    ),
    claim_due_idx: index("agent_failover_operations_claim_due_idx")
      .on(table.status, table.next_attempt_at)
      .where(sql`${table.status} IN ${NON_TERMINAL_STATUS_LIST}`),
    lease_horizon_idx: index("agent_failover_operations_lease_horizon_idx")
      .on(table.lease_expires_at)
      .where(sql`${table.lease_generation} IS NOT NULL`),
    target_node_idx: index("agent_failover_operations_target_node_idx")
      .on(table.target_node_record_id)
      .where(sql`${table.target_node_record_id} IS NOT NULL`),
    agent_idx: index("agent_failover_operations_agent_idx").on(table.agent_id, table.created_at),
    organization_idx: index("agent_failover_operations_organization_idx").on(
      table.organization_id,
      table.created_at,
    ),
    lease_shape_check: check(
      "agent_failover_operations_lease_shape_check",
      sql`(((${table.lease_owner} IS NULL AND ${table.lease_generation} IS NULL
          AND ${table.lease_expires_at} IS NULL AND ${table.lease_heartbeat_at} IS NULL)
        OR (${table.lease_owner} IS NOT NULL AND ${table.lease_generation} IS NOT NULL
          AND ${table.lease_expires_at} IS NOT NULL AND ${table.lease_heartbeat_at} IS NOT NULL
          AND ${table.lease_owner} = btrim(${table.lease_owner})
          AND octet_length(${table.lease_owner}) BETWEEN 1 AND 255))
      AND (${table.claim_count} >= 0)
      AND (${table.post_cutover_attempts} >= 0)
      AND (${table.step} IN ${STEP_LIST})
      AND (${table.step_state} IN ('not_started', 'in_progress', 'awaiting_reconcile',
        'succeeded', 'failed'))
      AND ((${table.status} IN ${NON_TERMINAL_STATUS_LIST}) = (${table.completed_at} IS NULL))
      AND (${table.status} IN ('pending', 'running', 'awaiting_capacity', 'awaiting_reconcile',
          'completed')
        OR (${table.lease_owner} IS NULL AND ${table.lease_generation} IS NULL
          AND ${table.lease_expires_at} IS NULL AND ${table.lease_heartbeat_at} IS NULL))
      AND (${table.status} <> 'restore_release_required' OR ${table.restore_lease_id} IS NOT NULL)
      AND (${table.status} <> 'awaiting_capacity'
        OR (${table.wait_reason} IS NOT NULL AND ${table.wait_deadline_at} IS NOT NULL
          AND ${table.target_publication_id} IS NULL))
      AND (${table.status} = 'awaiting_capacity'
        OR (${table.wait_reason} IS NULL AND ${table.wait_deadline_at} IS NULL))
      AND (${table.wait_reason} IS NULL OR ${table.wait_reason} IN ${WAIT_REASON_LIST})
      AND ((${table.status} IN ('pending', 'completed') AND ${table.last_error_code} IS NULL)
        OR (${table.status} IN ${TERMINAL_FAILURE_STATUS_LIST} AND ${table.last_error_code} IS NOT NULL)
        OR ${table.status} IN ('running', 'awaiting_capacity', 'awaiting_reconcile',
          'restore_release_required'))
      AND (${table.source_node_id} = btrim(${table.source_node_id})
        AND octet_length(${table.source_node_id}) BETWEEN 1 AND 255)
      AND (${table.source_container_name} IS NULL
        OR (${table.source_container_name} = btrim(${table.source_container_name})
          AND octet_length(${table.source_container_name}) BETWEEN 1 AND 255))
      AND (${table.source_container_id} ~ '^[0-9a-f]{64}$')
      AND (${table.last_error_code} IS NULL
        OR (${table.last_error_code} = btrim(${table.last_error_code})
          AND octet_length(${table.last_error_code}) BETWEEN 1 AND 128))
      AND (${table.started_at} IS NULL OR ${table.started_at} >= ${table.created_at})
      AND (${table.completed_at} IS NULL OR ${table.completed_at} >= ${table.created_at})
      AND ((${table.target_node_record_id} IS NULL) = (${table.target_node_incarnation} IS NULL))
      AND ((${table.target_node_record_id} IS NULL) = (${table.target_node_history_id} IS NULL))
      AND ((${table.restore_operation_id} IS NULL) = (${table.restore_lease_id} IS NULL))
      AND ((${table.restore_lease_id} IS NULL) = (${table.restore_lease_generation} IS NULL))
      AND ((${table.restore_backup_id} IS NULL) = (${table.restore_manifest_sha256} IS NULL))
      AND (${table.target_publication_id} IS NULL
        OR (${table.restore_backup_id} IS NOT NULL
          AND ${table.target_container_id} IS NOT NULL
          AND ${table.target_activation_generation} IS NOT NULL
          AND ${table.target_lifecycle_revision} IS NOT NULL
          AND ${table.target_receipt_sha256} IS NOT NULL))) IS TRUE`,
    ),
    source_shape_check: check(
      "agent_failover_operations_source_shape_check",
      sql`(${table.source_lifecycle_revision} BETWEEN 0 AND ${UINT64_MAX}
        AND (${table.source_activation_generation} <> ${table.target_activation_generation}
          OR ${table.target_activation_generation} IS NULL)
        AND (${table.target_lifecycle_revision} IS NULL
          OR ${table.target_lifecycle_revision} > ${table.source_lifecycle_revision})) IS TRUE`,
    ),
  }),
);

/**
 * Append-only progress journal: one row per attempt of one step.
 *
 * `(operation_id, step, attempt)` is unique, so an attempt can neither be
 * duplicated nor replayed, and the highest attempt per step is the resume point.
 * `lease_owner`/`lease_generation` are the receipt of the executor that opened
 * the attempt and are immutable; the guard fills
 * `settled_by_lease_owner`/`settled_by_lease_generation` from the operation's
 * live lease on every settlement, so a reconcile decision names its decider
 * without the writer being able to forge it.
 */
export const agentFailoverStepAttempts = pgTable(
  "agent_failover_step_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operation_id: uuid("operation_id").notNull(),
    step: text("step").$type<AgentFailoverStep>().notNull(),
    attempt: integer("attempt").notNull(),
    state: text("state").$type<AgentFailoverAttemptState>().notNull(),
    lease_owner: text("lease_owner").notNull(),
    lease_generation: uuid("lease_generation").notNull(),
    settled_by_lease_owner: text("settled_by_lease_owner"),
    settled_by_lease_generation: uuid("settled_by_lease_generation"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    reconcile_action: text("reconcile_action").$type<AgentFailoverReconcileAction>(),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation_fk: foreignKey({
      name: "agent_failover_step_attempts_operation_fkey",
      columns: [table.operation_id],
      foreignColumns: [agentFailoverOperations.id],
    }).onDelete("cascade"),
    attempt_uidx: uniqueIndex("agent_failover_step_attempts_attempt_uidx").on(
      table.operation_id,
      table.step,
      table.attempt,
    ),
    operation_started_idx: index("agent_failover_step_attempts_operation_started_idx").on(
      table.operation_id,
      table.started_at,
    ),
    shape_check: check(
      "agent_failover_step_attempts_shape_check",
      sql`(${table.step} IN ${STEP_LIST}
        AND ${table.attempt} >= 1
        AND ${table.state} IN ('started', 'succeeded', 'failed', 'awaiting_reconcile',
          'reconciled', 'abandoned')
        AND ${table.lease_owner} = btrim(${table.lease_owner})
        AND octet_length(${table.lease_owner}) BETWEEN 1 AND 255
        AND jsonb_typeof(${table.detail}) = 'object'
        AND ((${table.state} = 'started') = (${table.finished_at} IS NULL))
        AND ((${table.state} = 'started') = (${table.settled_by_lease_owner} IS NULL))
        AND ((${table.settled_by_lease_owner} IS NULL)
          = (${table.settled_by_lease_generation} IS NULL))
        AND (${table.finished_at} IS NULL OR ${table.finished_at} >= ${table.started_at})
        AND ((${table.state} = 'reconciled') = (${table.reconcile_action} IS NOT NULL))
        AND (${table.state} <> 'reconciled' OR ${table.detail} <> '{}'::jsonb)
        AND (${table.reconcile_action} IS NULL
          OR ${table.reconcile_action} IN ('continued', 'retried', 'abandoned'))) IS TRUE`,
    ),
  }),
);

/** One recorded operator action on a parked failover, append-only. */
export const agentFailoverOperatorActions = pgTable(
  "agent_failover_operator_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operation_id: uuid("operation_id").notNull(),
    action: text("action").$type<AgentFailoverOperatorAction>().notNull(),
    operator: text("operator").notNull(),
    reason: text("reason").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation_fk: foreignKey({
      name: "agent_failover_operator_actions_operation_fkey",
      columns: [table.operation_id],
      foreignColumns: [agentFailoverOperations.id],
    }).onDelete("cascade"),
    operation_idx: index("agent_failover_operator_actions_operation_idx").on(
      table.operation_id,
      table.recorded_at,
    ),
    shape_check: check(
      "agent_failover_operator_actions_shape_check",
      sql`(${table.action} IN ('resume')
        AND ${table.operator} = btrim(${table.operator})
        AND octet_length(${table.operator}) BETWEEN 1 AND 255
        AND ${table.reason} = btrim(${table.reason})
        AND octet_length(${table.reason}) BETWEEN 1 AND 1024) IS TRUE`,
    ),
  }),
);

export type AgentFailoverOperatorAction = "resume";

export type AgentNodeFailureEvent = InferSelectModel<typeof agentNodeFailureEvents>;
export type AgentNodeFailureCandidate = InferSelectModel<typeof agentNodeFailureCandidates>;
export type AgentFailoverOperatorActionRecord = InferSelectModel<
  typeof agentFailoverOperatorActions
>;
export type AgentNodeFailureSignal = InferSelectModel<typeof agentNodeFailureSignals>;
export type AgentFailoverOperation = InferSelectModel<typeof agentFailoverOperations>;
export type AgentFailoverStepAttempt = InferSelectModel<typeof agentFailoverStepAttempts>;
