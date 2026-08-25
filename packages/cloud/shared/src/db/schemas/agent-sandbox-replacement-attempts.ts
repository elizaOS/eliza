/**
 * Durable one-shot authority for agent sandbox replacement provider calls.
 * Rows retain their lifecycle, restore-lease, exact Docker placement, and
 * settlement evidence for the life of its owner so ambiguous remote creates
 * never expire into permission for another create. At this table boundary,
 * only terminal history may cascade with atomic organization erasure; other
 * retention authorities can still reject that erasure.
 */

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  type AgentBackupCopyRole,
  type AgentCapacityOwnershipState,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "./agent-backup-catalog";
import { agentNodeIncarnationHistories } from "./agent-node-incarnation-histories";
import { organizations } from "./organizations";

export const AGENT_SANDBOX_REPLACEMENT_OPERATION_KINDS = [
  "provision",
  "upgrade",
  "downgrade",
] as const;
export type AgentSandboxReplacementOperationKind =
  (typeof AGENT_SANDBOX_REPLACEMENT_OPERATION_KINDS)[number];

export const AGENT_SANDBOX_REPLACEMENT_ATTEMPT_STATES = [
  "in_flight_unresolved",
  "provider_succeeded",
  "lifecycle_committed",
  "cleanup_proven",
] as const;
export type AgentSandboxReplacementAttemptState =
  (typeof AGENT_SANDBOX_REPLACEMENT_ATTEMPT_STATES)[number];

export const AGENT_SANDBOX_REPLACEMENT_PREVIOUS_CLEANUP_STATES = ["pending", "released"] as const;
export type AgentSandboxReplacementPreviousCleanupState =
  (typeof AGENT_SANDBOX_REPLACEMENT_PREVIOUS_CLEANUP_STATES)[number];

/** Ambiguous or adoptable provider effects block every generation for an agent. */
export const AGENT_SANDBOX_REPLACEMENT_GLOBAL_FENCE_STATES = [
  "in_flight_unresolved",
  "provider_succeeded",
] as const satisfies readonly AgentSandboxReplacementAttemptState[];

/** States that fence one generation; lifecycle commitment retains that fence permanently. */
export const AGENT_SANDBOX_REPLACEMENT_GENERATION_FENCE_STATES = [
  ...AGENT_SANDBOX_REPLACEMENT_GLOBAL_FENCE_STATES,
  "lifecycle_committed",
] as const satisfies readonly AgentSandboxReplacementAttemptState[];

export const agentSandboxReplacementAttempts = pgTable(
  "agent_sandbox_replacement_attempts",
  {
    /** Caller-owned exact provider invocation identity; never generated here. */
    id: uuid("id").primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agent_id: uuid("agent_id").notNull(),
    operation_kind: text("operation_kind").$type<AgentSandboxReplacementOperationKind>().notNull(),
    lifecycle_revision: numeric("lifecycle_revision", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    activation_generation: uuid("activation_generation").notNull(),
    lifecycle_job_id: uuid("lifecycle_job_id"),
    lifecycle_execution_generation: uuid("lifecycle_execution_generation"),
    /**
     * Durable classification of the canonical row at start admission.
     *
     * `true` is reserved for a first provision admitted while all three
     * canonical placement columns were NULL. `false` means an exact previous
     * placement existed and must be retained during adoption. NULL is only an
     * expand-deploy compatibility value for attempts created by an older
     * binary; the repository never adopts such an unclassified attempt.
     */
    previous_placement_absent: boolean("previous_placement_absent"),
    previous_sandbox_id: text("previous_sandbox_id"),
    previous_node_id: text("previous_node_id"),
    previous_container_name: text("previous_container_name"),
    previous_container_id: text("previous_container_id"),
    previous_allocation_counted: boolean("previous_allocation_counted"),
    previous_node_record_id: uuid("previous_node_record_id"),
    previous_node_incarnation: uuid("previous_node_incarnation"),
    previous_node_history_id: uuid("previous_node_history_id"),
    previous_node_hostname: text("previous_node_hostname"),
    previous_node_ssh_port: integer("previous_node_ssh_port"),
    previous_node_ssh_user: text("previous_node_ssh_user"),
    previous_node_host_key_fingerprint: text("previous_node_host_key_fingerprint"),
    /**
     * Exact-once settlement for the old primary retained after lifecycle
     * adoption. This is deliberately separate from `cleanup_*`, which settles
     * an abandoned replacement candidate before adoption.
     */
    previous_cleanup_state:
      text("previous_cleanup_state").$type<AgentSandboxReplacementPreviousCleanupState>(),
    previous_cleanup_proven_at: timestamp("previous_cleanup_proven_at", { withTimezone: true }),
    previous_cleanup_receipt_digest: text("previous_cleanup_receipt_digest"),

    /** Optional immutable copy of the exact restore source and lease fence. */
    restore_lease_id: uuid("restore_lease_id"),
    restore_backup_id: uuid("restore_backup_id"),
    restore_attempt_id: uuid("restore_attempt_id"),
    restore_lease_owner_id: text("restore_lease_owner_id"),
    restore_lease_generation: uuid("restore_lease_generation"),
    restore_catalog_epoch: bigint("restore_catalog_epoch", { mode: "bigint" }),
    restore_copy_role: text("restore_copy_role").$type<AgentBackupCopyRole>(),
    restore_operation_id: uuid("restore_operation_id"),
    restore_source_activation_generation: uuid("restore_source_activation_generation"),
    restore_source_lifecycle_revision: numeric("restore_source_lifecycle_revision", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }),
    restore_manifest_sha256: text("restore_manifest_sha256"),
    restore_lease_expires_at: timestamp("restore_lease_expires_at", { withTimezone: true }),

    state: text("state")
      .$type<AgentSandboxReplacementAttemptState>()
      .notNull()
      .default("in_flight_unresolved"),

    /** Immutable core from S0's exact intent callback. */
    locator_sandbox_id: text("locator_sandbox_id"),
    locator_node_id: text("locator_node_id"),
    locator_container_name: text("locator_container_name"),
    // The FK targets immutable occurrence history rather than docker_nodes, so
    // retained attempts preserve exact placement without blocking node retirement.
    locator_node_record_id: uuid("locator_node_record_id"),
    locator_node_incarnation: uuid("locator_node_incarnation"),
    locator_node_history_id: uuid("locator_node_history_id"),
    locator_node_hostname: text("locator_node_hostname"),
    locator_node_ssh_port: integer("locator_node_ssh_port"),
    locator_node_ssh_user: text("locator_node_ssh_user"),
    locator_node_host_key_fingerprint: text("locator_node_host_key_fingerprint"),
    locator_secret_cleanup_version: integer("locator_secret_cleanup_version"),
    locator_allocation_counted: boolean("locator_allocation_counted"),
    locator_vpn_node_name: text("locator_vpn_node_name"),
    locator_vpn_registration_started_at: timestamp("locator_vpn_registration_started_at", {
      withTimezone: true,
    }),
    locator_previous_vpn_node_id: text("locator_previous_vpn_node_id"),
    locator_recorded_at: timestamp("locator_recorded_at", { withTimezone: true }),

    capacity_state: text("capacity_state").$type<AgentCapacityOwnershipState>(),
    capacity_reserved_at: timestamp("capacity_reserved_at", { withTimezone: true }),
    capacity_settled_at: timestamp("capacity_settled_at", { withTimezone: true }),
    capacity_settlement_receipt_digest: text("capacity_settlement_receipt_digest"),

    /** Write-once enrichments from the created and VPN callbacks. */
    locator_container_id: text("locator_container_id"),
    locator_container_recorded_at: timestamp("locator_container_recorded_at", {
      withTimezone: true,
    }),
    locator_vpn_node_id: text("locator_vpn_node_id"),
    locator_vpn_recorded_at: timestamp("locator_vpn_recorded_at", { withTimezone: true }),

    provider_succeeded_at: timestamp("provider_succeeded_at", { withTimezone: true }),
    provider_receipt_digest: text("provider_receipt_digest"),
    lifecycle_committed_at: timestamp("lifecycle_committed_at", { withTimezone: true }),
    lifecycle_receipt_digest: text("lifecycle_receipt_digest"),
    cleanup_proven_at: timestamp("cleanup_proven_at", { withTimezone: true }),
    cleanup_receipt_digest: text("cleanup_receipt_digest"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    restore_lease_authority_fk: foreignKey({
      name: "agent_sandbox_replacement_attempts_restore_lease_fkey",
      columns: [
        table.restore_lease_id,
        table.organization_id,
        table.agent_id,
        table.restore_backup_id,
        table.restore_attempt_id,
        table.restore_lease_owner_id,
        table.restore_lease_generation,
        table.restore_catalog_epoch,
        table.restore_copy_role,
        table.restore_operation_id,
        table.restore_source_activation_generation,
        table.restore_source_lifecycle_revision,
        table.restore_manifest_sha256,
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
    restore_operation_capacity_fk: foreignKey({
      name: "agent_sandbox_replacement_attempts_restore_operation_fkey",
      columns: [table.organization_id, table.restore_attempt_id],
      foreignColumns: [
        agentBackupRestoreOperations.organization_id,
        agentBackupRestoreOperations.restore_attempt_id,
      ],
    }).onDelete("restrict"),
    node_occurrence_authority_fk: foreignKey({
      name: "agent_sandbox_replacement_attempts_node_occurrence_fkey",
      columns: [
        table.locator_node_history_id,
        table.locator_node_record_id,
        table.locator_node_incarnation,
        table.locator_node_id,
      ],
      foreignColumns: [
        agentNodeIncarnationHistories.id,
        agentNodeIncarnationHistories.docker_node_record_id,
        agentNodeIncarnationHistories.node_incarnation,
        agentNodeIncarnationHistories.node_id,
      ],
    }).onDelete("restrict"),
    previous_node_occurrence_authority_fk: foreignKey({
      name: "agent_sandbox_replacement_attempts_previous_node_occurrence_fkey",
      columns: [
        table.previous_node_history_id,
        table.previous_node_record_id,
        table.previous_node_incarnation,
        table.previous_node_id,
      ],
      foreignColumns: [
        agentNodeIncarnationHistories.id,
        agentNodeIncarnationHistories.docker_node_record_id,
        agentNodeIncarnationHistories.node_incarnation,
        agentNodeIncarnationHistories.node_id,
      ],
    }).onDelete("restrict"),
    one_active_effect_per_agent_uidx: uniqueIndex(
      "agent_sandbox_replacement_attempts_active_agent_uidx",
    )
      .on(table.organization_id, table.agent_id)
      .where(sql`${table.state} IN ('in_flight_unresolved', 'provider_succeeded')`),
    one_attempt_per_generation_uidx: uniqueIndex(
      "agent_sandbox_replacement_attempts_active_generation_uidx",
    )
      .on(table.organization_id, table.agent_id, table.activation_generation)
      .where(
        sql`${table.state} IN ('in_flight_unresolved', 'provider_succeeded', 'lifecycle_committed')`,
      ),
    one_restore_capacity_receiver_uidx: uniqueIndex(
      "agent_sandbox_replacement_restore_capacity_receiver_uidx",
    )
      .on(table.organization_id, table.restore_attempt_id)
      .where(sql`${table.restore_attempt_id} IS NOT NULL AND ${table.capacity_state} IS NOT NULL`),
    capacity_reserved_occurrence_idx: index(
      "agent_sandbox_replacement_capacity_reserved_occurrence_idx",
    )
      .on(
        table.locator_node_record_id,
        table.locator_node_id,
        table.locator_node_incarnation,
        table.locator_node_history_id,
      )
      .where(sql`${table.capacity_state} = 'reserved'`),
    operation_kind_check: check(
      "agent_sandbox_replacement_attempts_operation_kind_check",
      sql`${table.operation_kind} IN ('provision', 'upgrade', 'downgrade')`,
    ),
    lifecycle_authority_check: check(
      "agent_sandbox_replacement_attempts_lifecycle_check",
      sql`(${table.lifecycle_revision} BETWEEN 0 AND 18446744073709551615
        AND ((${table.lifecycle_job_id} IS NULL
            AND ${table.lifecycle_execution_generation} IS NULL)
          OR (${table.lifecycle_job_id} IS NOT NULL
            AND ${table.lifecycle_execution_generation} IS NOT NULL))) IS TRUE`,
    ),
    previous_placement_mode_check: check(
      "agent_sandbox_replacement_attempts_previous_placement_mode_check",
      sql`(${table.previous_placement_absent} IS NULL
        OR ${table.previous_placement_absent} = FALSE
        OR (${table.previous_placement_absent} = TRUE
          AND ${table.operation_kind} = 'provision')) IS TRUE`,
    ),
    previous_placement_shape_check: check(
      "agent_sandbox_replacement_attempts_previous_placement_shape_check",
      sql`(CASE
        WHEN ${table.previous_placement_absent} IS NULL THEN
          num_nonnulls(
            ${table.previous_sandbox_id}, ${table.previous_node_id},
            ${table.previous_container_name}, ${table.previous_container_id},
            ${table.previous_allocation_counted},
            ${table.previous_node_record_id}, ${table.previous_node_incarnation},
            ${table.previous_node_history_id}, ${table.previous_node_hostname},
            ${table.previous_node_ssh_port}, ${table.previous_node_ssh_user},
            ${table.previous_node_host_key_fingerprint}) = 0
        WHEN ${table.previous_placement_absent} = TRUE THEN
          num_nonnulls(
            ${table.previous_sandbox_id}, ${table.previous_node_id},
            ${table.previous_container_name}, ${table.previous_container_id},
            ${table.previous_allocation_counted},
            ${table.previous_node_record_id}, ${table.previous_node_incarnation},
            ${table.previous_node_history_id}, ${table.previous_node_hostname},
            ${table.previous_node_ssh_port}, ${table.previous_node_ssh_user},
            ${table.previous_node_host_key_fingerprint}) = 0
        ELSE
          ${table.previous_sandbox_id} IS NOT NULL
          AND ${table.previous_node_id} IS NOT NULL
          AND ${table.previous_container_name} IS NOT NULL
          AND ${table.previous_container_id} ~ '^[0-9a-f]{64}$'
          AND ${table.previous_allocation_counted} = TRUE
          AND ${table.previous_node_record_id} IS NOT NULL
          AND ${table.previous_node_incarnation} IS NOT NULL
          AND ${table.previous_node_history_id} IS NOT NULL
          AND btrim(${table.previous_node_hostname}) <> ''
          AND octet_length(${table.previous_node_hostname}) <= 255
          AND ${table.previous_node_ssh_port} BETWEEN 1 AND 65535
          AND btrim(${table.previous_node_ssh_user}) <> ''
          AND octet_length(${table.previous_node_ssh_user}) <= 255
          AND btrim(${table.previous_node_host_key_fingerprint}) <> ''
          AND octet_length(${table.previous_node_host_key_fingerprint}) <= 1024
        END) IS TRUE`,
    ),
    previous_cleanup_shape_check: check(
      "agent_sandbox_replacement_attempts_previous_cleanup_shape_check",
      sql`(CASE
        WHEN ${table.previous_placement_absent} = FALSE
          AND ${table.state} = 'lifecycle_committed' THEN
          (${table.previous_cleanup_state} = 'pending'
            AND ${table.previous_cleanup_proven_at} IS NULL
            AND ${table.previous_cleanup_receipt_digest} IS NULL)
          OR (${table.previous_cleanup_state} = 'released'
            AND ${table.previous_cleanup_proven_at} IS NOT NULL
            AND ${table.previous_cleanup_proven_at} >= ${table.lifecycle_committed_at}
            AND ${table.previous_cleanup_receipt_digest} ~ '^[0-9a-f]{64}$')
        ELSE
          ${table.previous_cleanup_state} IS NULL
          AND ${table.previous_cleanup_proven_at} IS NULL
          AND ${table.previous_cleanup_receipt_digest} IS NULL
        END) IS TRUE`,
    ),
    restore_authority_check: check(
      "agent_sandbox_replacement_attempts_restore_shape_check",
      sql`(num_nonnulls(
          ${table.restore_lease_id}, ${table.restore_backup_id}, ${table.restore_attempt_id},
          ${table.restore_lease_owner_id}, ${table.restore_lease_generation},
          ${table.restore_catalog_epoch}, ${table.restore_copy_role},
          ${table.restore_operation_id}, ${table.restore_source_activation_generation},
          ${table.restore_source_lifecycle_revision}, ${table.restore_manifest_sha256},
          ${table.restore_lease_expires_at}) = 0
        OR (num_nonnulls(
          ${table.restore_lease_id}, ${table.restore_backup_id}, ${table.restore_attempt_id},
          ${table.restore_lease_owner_id}, ${table.restore_lease_generation},
          ${table.restore_catalog_epoch}, ${table.restore_copy_role},
          ${table.restore_operation_id}, ${table.restore_source_activation_generation},
          ${table.restore_source_lifecycle_revision}, ${table.restore_manifest_sha256},
          ${table.restore_lease_expires_at}) = 12
          AND btrim(${table.restore_lease_owner_id}) = ${table.restore_lease_owner_id}
          AND octet_length(${table.restore_lease_owner_id}) BETWEEN 1 AND 255
          AND ${table.restore_catalog_epoch} >= 0
          AND ${table.restore_copy_role} IN ('primary', 'secondary')
          AND ${table.restore_source_lifecycle_revision}
            BETWEEN 0 AND 18446744073709551615
          AND ${table.restore_manifest_sha256} ~ '^[0-9a-f]{64}$'
          AND ${table.restore_lease_expires_at} > ${table.created_at})) IS TRUE`,
    ),
    locator_shape_check: check(
      "agent_sandbox_replacement_attempts_locator_shape_check",
      sql`((
          num_nonnulls(
            ${table.locator_sandbox_id}, ${table.locator_node_id},
            ${table.locator_container_name}, ${table.locator_node_record_id},
            ${table.locator_node_incarnation}, ${table.locator_node_history_id},
            ${table.locator_node_hostname}, ${table.locator_node_ssh_port},
            ${table.locator_node_ssh_user}, ${table.locator_node_host_key_fingerprint},
            ${table.locator_secret_cleanup_version}, ${table.locator_allocation_counted},
            ${table.locator_vpn_node_name}, ${table.locator_vpn_registration_started_at},
            ${table.locator_previous_vpn_node_id}, ${table.locator_recorded_at},
            ${table.locator_container_id}, ${table.locator_container_recorded_at},
            ${table.locator_vpn_node_id}, ${table.locator_vpn_recorded_at}) = 0
        ) OR (
          ${table.locator_sandbox_id} IS NOT NULL
          AND ${table.locator_node_id} IS NOT NULL
          AND ${table.locator_container_name} IS NOT NULL
          AND ${table.locator_node_record_id} IS NOT NULL
          AND ${table.locator_node_incarnation} IS NOT NULL
          AND ${table.locator_node_history_id} IS NOT NULL
          AND ${table.locator_node_hostname} IS NOT NULL
          AND ${table.locator_node_ssh_port} IS NOT NULL
          AND ${table.locator_node_ssh_user} IS NOT NULL
          AND ${table.locator_node_host_key_fingerprint} IS NOT NULL
          AND ${table.locator_secret_cleanup_version} = 1
          AND ${table.locator_allocation_counted} = TRUE
          AND ${table.locator_recorded_at} IS NOT NULL
          AND ${table.locator_sandbox_id} = ${table.locator_container_name}
          AND ${table.locator_container_name} = 'agent-' || ${table.agent_id}::text
          AND btrim(${table.locator_node_id}) <> ''
          AND octet_length(${table.locator_node_id}) <= 255
          AND btrim(${table.locator_node_hostname}) <> ''
          AND octet_length(${table.locator_node_hostname}) <= 255
          AND ${table.locator_node_ssh_port} BETWEEN 1 AND 65535
          AND btrim(${table.locator_node_ssh_user}) <> ''
          AND octet_length(${table.locator_node_ssh_user}) <= 255
          AND btrim(${table.locator_node_host_key_fingerprint}) <> ''
          AND octet_length(${table.locator_node_host_key_fingerprint}) <= 1024
          AND ${table.locator_recorded_at} >= ${table.created_at}
          AND (${table.locator_container_id} IS NULL)
            = (${table.locator_container_recorded_at} IS NULL)
          AND (${table.locator_container_id} IS NULL
            OR (${table.locator_container_id} ~ '^[0-9a-f]{12,64}$'
              AND ${table.locator_container_recorded_at} >= ${table.locator_recorded_at}))
          AND (${table.locator_vpn_node_name} IS NULL)
            = (${table.locator_vpn_registration_started_at} IS NULL)
          AND (${table.locator_vpn_node_name} IS NULL
            OR (btrim(${table.locator_vpn_node_name}) <> ''
              AND octet_length(${table.locator_vpn_node_name}) <= 255))
          AND (${table.locator_previous_vpn_node_id} IS NULL
            OR (${table.locator_vpn_node_name} IS NOT NULL
              AND CASE
                WHEN ${table.locator_previous_vpn_node_id} ~ '^[1-9][0-9]{0,19}$'
                  THEN ${table.locator_previous_vpn_node_id}::numeric
                    <= 18446744073709551615
                ELSE FALSE
              END))
          AND (${table.locator_vpn_node_id} IS NULL)
            = (${table.locator_vpn_recorded_at} IS NULL)
          AND (${table.locator_vpn_node_id} IS NULL
            OR (${table.locator_container_id} IS NOT NULL
              AND ${table.locator_vpn_node_name} IS NOT NULL
              AND ${table.locator_vpn_node_id}
                IS DISTINCT FROM ${table.locator_previous_vpn_node_id}
              AND ${table.locator_vpn_recorded_at}
                >= ${table.locator_container_recorded_at}
              AND CASE
                WHEN ${table.locator_vpn_node_id} ~ '^[1-9][0-9]{0,19}$'
                  THEN ${table.locator_vpn_node_id}::numeric <= 18446744073709551615
                ELSE FALSE
              END))
        )) IS TRUE`,
    ),
    settlement_shape_check: check(
      "agent_sandbox_replacement_attempts_settlement_shape_check",
      sql`((${table.state} = 'in_flight_unresolved'
          AND num_nonnulls(${table.provider_succeeded_at}, ${table.provider_receipt_digest},
            ${table.lifecycle_committed_at}, ${table.lifecycle_receipt_digest},
            ${table.cleanup_proven_at}, ${table.cleanup_receipt_digest}) = 0)
        OR (${table.state} = 'provider_succeeded'
          AND ${table.locator_recorded_at} IS NOT NULL
          AND ${table.locator_container_id} IS NOT NULL
          AND ${table.provider_succeeded_at} IS NOT NULL
          AND ${table.provider_succeeded_at} >= ${table.locator_container_recorded_at}
          AND (${table.locator_vpn_node_name} IS NULL
            OR ${table.locator_vpn_node_id} IS NOT NULL)
          AND (${table.locator_vpn_recorded_at} IS NULL
            OR ${table.provider_succeeded_at} >= ${table.locator_vpn_recorded_at})
          AND ${table.provider_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND num_nonnulls(${table.lifecycle_committed_at}, ${table.lifecycle_receipt_digest},
            ${table.cleanup_proven_at}, ${table.cleanup_receipt_digest}) = 0)
        OR (${table.state} = 'lifecycle_committed'
          AND ${table.provider_succeeded_at} IS NOT NULL
          AND ${table.provider_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND ${table.lifecycle_committed_at} IS NOT NULL
          AND ${table.lifecycle_committed_at} >= ${table.provider_succeeded_at}
          AND ${table.lifecycle_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND ${table.cleanup_proven_at} IS NULL
          AND ${table.cleanup_receipt_digest} IS NULL)
        OR (${table.state} = 'cleanup_proven'
          AND (${table.provider_succeeded_at} IS NULL)
            = (${table.provider_receipt_digest} IS NULL)
          AND (${table.provider_receipt_digest} IS NULL
            OR ${table.provider_receipt_digest} ~ '^[0-9a-f]{64}$')
          AND ${table.cleanup_proven_at} IS NOT NULL
          AND ${table.cleanup_proven_at} >= COALESCE(
            ${table.locator_vpn_recorded_at}, ${table.locator_container_recorded_at},
            ${table.locator_recorded_at}, ${table.created_at})
          AND (${table.provider_succeeded_at} IS NULL
            OR ${table.cleanup_proven_at} >= ${table.provider_succeeded_at})
          AND ${table.cleanup_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND ${table.lifecycle_committed_at} IS NULL
          AND ${table.lifecycle_receipt_digest} IS NULL)) IS TRUE`,
    ),
    capacity_shape_check: check(
      "agent_sandbox_replacement_attempts_capacity_shape_check",
      sql`(CASE
        WHEN ${table.locator_recorded_at} IS NULL THEN
          ${table.capacity_state} IS NULL
          AND ${table.capacity_reserved_at} IS NULL
          AND ${table.capacity_settled_at} IS NULL
          AND ${table.capacity_settlement_receipt_digest} IS NULL
        ELSE
          ${table.capacity_reserved_at} = ${table.locator_recorded_at}
          AND ((${table.state} IN ('in_flight_unresolved', 'provider_succeeded')
              AND ${table.capacity_state} = 'reserved'
              AND ${table.capacity_reserved_at} IS NOT NULL
              AND ${table.capacity_settled_at} IS NULL
              AND ${table.capacity_settlement_receipt_digest} IS NULL)
            OR (${table.state} = 'lifecycle_committed'
              AND ${table.capacity_state} = 'handed_off'
              AND ${table.capacity_reserved_at} IS NOT NULL
              AND ${table.capacity_settled_at} >= ${table.capacity_reserved_at}
              AND ${table.capacity_settled_at} = ${table.lifecycle_committed_at}
              AND ${table.capacity_settlement_receipt_digest}
                = ${table.lifecycle_receipt_digest}
              AND ${table.capacity_settlement_receipt_digest} ~ '^[0-9a-f]{64}$')
            OR (${table.state} = 'cleanup_proven'
              AND ${table.capacity_state} = 'released'
              AND ${table.capacity_reserved_at} IS NOT NULL
              AND ${table.capacity_settled_at} >= ${table.capacity_reserved_at}
              AND ${table.capacity_settled_at} = ${table.cleanup_proven_at}
              AND ${table.capacity_settlement_receipt_digest} = ${table.cleanup_receipt_digest}
              AND ${table.capacity_settlement_receipt_digest} ~ '^[0-9a-f]{64}$'))
        END) IS TRUE`,
    ),
  }),
);

export type AgentSandboxReplacementAttempt = InferSelectModel<
  typeof agentSandboxReplacementAttempts
>;
export type NewAgentSandboxReplacementAttempt = InferInsertModel<
  typeof agentSandboxReplacementAttempts
>;
