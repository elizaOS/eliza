/** Global provider-execution lane and explicit tenant/node fairness watermarks. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentNodeIncarnationHistories } from "./agent-node-incarnation-histories";
import { organizations } from "./organizations";

export type AgentBackupOperationLanePhase = "capture" | "publication";

/**
 * The one database-serialized authority for backup provider mutations.
 *
 * Scheduler admission can remain concurrent, but a provider call must own this
 * row under `SELECT ... FOR UPDATE` and the exact generation stored here. The
 * row is seeded by the migration and is never deleted.
 */
export const agentBackupOperationLane = pgTable(
  "agent_backup_operation_lane",
  {
    singleton: boolean("singleton").primaryKey().notNull().default(true),
    owner_id: text("owner_id"),
    generation: uuid("generation"),
    organization_id: uuid("organization_id"),
    backup_id: uuid("backup_id"),
    operation_id: uuid("operation_id"),
    operation_phase: text("operation_phase").$type<AgentBackupOperationLanePhase>(),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    released_at: timestamp("released_at", { withTimezone: true }),
    claim_sequence: bigint("claim_sequence", { mode: "bigint" }).notNull().default(sql`0`),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singleton_check: check("agent_backup_operation_lane_singleton_check", sql`${table.singleton}`),
    shape_check: check(
      "agent_backup_operation_lane_shape_check",
      sql`(${table.claim_sequence} >= 0 AND ((
        ${table.owner_id} IS NULL
        AND ${table.generation} IS NULL
        AND ${table.organization_id} IS NULL
        AND ${table.backup_id} IS NULL
        AND ${table.operation_id} IS NULL
        AND ${table.operation_phase} IS NULL
        AND ${table.claimed_at} IS NULL
        AND ${table.lease_expires_at} IS NULL
        AND ${table.released_at} IS NULL
      ) OR (
        ${table.owner_id} IS NOT NULL
        AND btrim(${table.owner_id}) = ${table.owner_id}
        AND octet_length(${table.owner_id}) BETWEEN 1 AND 255
        AND ${table.owner_id} !~ '[[:cntrl:]]'
        AND ${table.generation} IS NOT NULL
        AND ${table.organization_id} IS NOT NULL
        AND ${table.backup_id} IS NOT NULL
        AND ${table.operation_id} IS NOT NULL
        AND ${table.operation_phase} IN ('capture', 'publication')
        AND ${table.claimed_at} IS NOT NULL
        AND ${table.lease_expires_at} > ${table.claimed_at}
        AND (${table.released_at} IS NULL OR ${table.released_at} >= ${table.claimed_at})
        AND ${table.claim_sequence} >= 1
      ))) IS TRUE`,
    ),
  }),
);

/** Last globally serialized service received by an organization. */
export const agentBackupOperationTenantWatermarks = pgTable(
  "agent_backup_operation_tenant_watermarks",
  {
    organization_id: uuid("organization_id").primaryKey(),
    last_backup_id: uuid("last_backup_id").notNull(),
    last_operation_id: uuid("last_operation_id").notNull(),
    last_service_sequence: bigint("last_service_sequence", { mode: "bigint" }).notNull(),
    service_count: bigint("service_count", { mode: "bigint" }).notNull().default(sql`1`),
    last_served_at: timestamp("last_served_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    organization_fk: foreignKey({
      name: "agent_backup_op_tenant_watermarks_org_fkey",
      columns: [table.organization_id],
      foreignColumns: [organizations.id],
    }).onDelete("cascade"),
    sequence_uidx: uniqueIndex("agent_backup_operation_tenant_watermarks_sequence_uidx").on(
      table.last_service_sequence,
    ),
    counters_check: check(
      "agent_backup_operation_tenant_watermarks_counters_check",
      sql`${table.last_service_sequence} >= 1 AND ${table.service_count} >= 1`,
    ),
  }),
);

/** Last globally serialized service received by one exact source-node occurrence. */
export const agentBackupOperationNodeWatermarks = pgTable(
  "agent_backup_operation_node_watermarks",
  {
    source_node_history_id: uuid("source_node_history_id").primaryKey(),
    source_node_record_id: uuid("source_node_record_id").notNull(),
    source_node_incarnation: uuid("source_node_incarnation").notNull(),
    last_backup_id: uuid("last_backup_id").notNull(),
    last_operation_id: uuid("last_operation_id").notNull(),
    last_service_sequence: bigint("last_service_sequence", { mode: "bigint" }).notNull(),
    service_count: bigint("service_count", { mode: "bigint" }).notNull().default(sql`1`),
    last_served_at: timestamp("last_served_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    node_occurrence_fk: foreignKey({
      name: "agent_backup_op_node_watermarks_occurrence_fkey",
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
    sequence_uidx: uniqueIndex("agent_backup_operation_node_watermarks_sequence_uidx").on(
      table.last_service_sequence,
    ),
    counters_check: check(
      "agent_backup_operation_node_watermarks_counters_check",
      sql`${table.last_service_sequence} >= 1 AND ${table.service_count} >= 1`,
    ),
  }),
);

export type AgentBackupOperationLane = InferSelectModel<typeof agentBackupOperationLane>;
export type NewAgentBackupOperationLane = InferInsertModel<typeof agentBackupOperationLane>;
export type AgentBackupOperationTenantWatermark = InferSelectModel<
  typeof agentBackupOperationTenantWatermarks
>;
export type AgentBackupOperationNodeWatermark = InferSelectModel<
  typeof agentBackupOperationNodeWatermarks
>;
