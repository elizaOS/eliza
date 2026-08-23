/** Durable publisher-fenced membership scopes, retained facts, and exact command receipts. */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { connectorAccountsTable } from "./connectorAccounts";
import { entityTable } from "./entity";

function scopeColumns() {
  return {
    agentId: uuid("agent_id").notNull(),
    connectorId: text("connector_id").notNull(),
    connectorAccountId: uuid("connector_account_id").notNull(),
    externalWorldId: text("external_world_id").notNull(),
    externalRoomId: text("external_room_id").notNull(),
  };
}
export const membershipAuthorityScopeTable = pgTable(
  "membership_authority_scopes",
  {
    ...scopeColumns(),
    health: text("health").notNull().default("stale"),
    reason: text("reason").notNull().default("publisher_not_registered"),
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    sourceVersion: bigint("source_version", { mode: "number" }).notNull().default(-1),
    sourceCursor: text("source_cursor"),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    publisherInstanceId: text("publisher_instance_id"),
    publisherGeneration: bigint("publisher_generation", { mode: "number" }),
    evidenceMode: text("evidence_mode"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    primaryKey({
      name: "membership_authority_scope_pk",
      columns: [
        table.agentId,
        table.connectorId,
        table.connectorAccountId,
        table.externalWorldId,
        table.externalRoomId,
      ],
    }),
    index("membership_authority_scope_health_idx").on(table.agentId, table.health),
    foreignKey({
      name: "fk_membership_authority_scope_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_membership_authority_scope_account",
      columns: [table.connectorAccountId, table.agentId],
      foreignColumns: [connectorAccountsTable.id, connectorAccountsTable.agentId],
    }).onDelete("cascade"),
    check(
      "membership_authority_scope_health_check",
      sql`${table.health} IN ('current','stale','unavailable','unsupported')`
    ),
    check(
      "membership_authority_scope_generation_check",
      sql`${table.generation} >= 0 AND ${table.sourceVersion} >= -1`
    ),
    check(
      "membership_authority_scope_publisher_check",
      sql`(${table.publisherInstanceId} IS NULL AND ${table.publisherGeneration} IS NULL AND ${table.evidenceMode} IS NULL) OR (${table.publisherInstanceId} IS NOT NULL AND ${table.publisherGeneration} >= 0 AND ${table.evidenceMode} IN ('complete_snapshot','ordered_delta','point_query'))`
    ),
    check(
      "membership_authority_scope_current_check",
      sql`${table.health} <> 'current' OR (${table.validUntil} IS NOT NULL AND ${table.validUntil} > ${table.observedAt} AND ${table.validUntil} <= ${table.observedAt} + INTERVAL '24 hours' AND ${table.publisherInstanceId} IS NOT NULL AND ${table.sourceVersion} >= 0 AND ${table.sourceCursor} IS NOT NULL)`
    ),
  ]
);

export const membershipAuthorityTable = pgTable(
  "membership_authority",
  {
    ...scopeColumns(),
    canonicalPrincipalId: uuid("canonical_principal_id").notNull(),
    state: text("state").notNull(),
    reason: text("reason").notNull(),
    roles: jsonb("roles").$type<string[]>().notNull(),
    permissionSnapshot: jsonb("permission_snapshot").$type<Record<string, unknown>>().notNull(),
    runtimeWorldId: uuid("runtime_world_id"),
    runtimeRoomId: uuid("runtime_room_id"),
    runtimeEntityId: uuid("runtime_entity_id"),
    publisherInstanceId: text("publisher_instance_id").notNull(),
    publisherGeneration: bigint("publisher_generation", { mode: "number" }).notNull(),
    evidenceMode: text("evidence_mode").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    sourceVersion: bigint("source_version", { mode: "number" }).notNull(),
    sourceCursor: text("source_cursor").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    primaryKey({
      name: "membership_authority_pk",
      columns: [
        table.agentId,
        table.connectorId,
        table.connectorAccountId,
        table.externalWorldId,
        table.externalRoomId,
        table.canonicalPrincipalId,
      ],
    }),
    index("membership_authority_principal_idx").on(table.agentId, table.canonicalPrincipalId),
    foreignKey({
      name: "fk_membership_authority_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_membership_authority_account",
      columns: [table.connectorAccountId, table.agentId],
      foreignColumns: [connectorAccountsTable.id, connectorAccountsTable.agentId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_membership_authority_principal",
      columns: [table.canonicalPrincipalId, table.agentId],
      foreignColumns: [entityTable.id, entityTable.agentId],
    }).onDelete("restrict"),
    check("membership_authority_state_check", sql`${table.state} IN ('active','revoked')`),
    check(
      "membership_authority_reason_check",
      sql`${table.reason} IN ('joined','reconciled_present','permission_restored','left','kicked','banned','permission_lost','account_removed','reconciled_absent')`
    ),
    check(
      "membership_authority_state_reason_check",
      sql`(${table.state} = 'active' AND ${table.reason} IN ('joined','reconciled_present','permission_restored')) OR (${table.state} = 'revoked' AND ${table.reason} IN ('left','kicked','banned','permission_lost','account_removed','reconciled_absent'))`
    ),
    check(
      "membership_authority_evidence_check",
      sql`${table.evidenceMode} IN ('complete_snapshot','ordered_delta','point_query') AND ${table.publisherGeneration} >= 0`
    ),
    check(
      "membership_authority_version_check",
      sql`${table.generation} > 0 AND ${table.sourceVersion} >= 0 AND ${table.validUntil} > ${table.observedAt} AND ${table.validUntil} <= ${table.observedAt} + INTERVAL '24 hours'`
    ),
  ]
);

export const membershipAuthorityJournalTable = pgTable(
  "membership_authority_journal",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).notNull(),
    ...scopeColumns(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    expectedGeneration: bigint("expected_generation", { mode: "number" }).notNull(),
    committedGeneration: bigint("committed_generation", { mode: "number" }).notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    unique("membership_authority_journal_idempotency_unique").on(
      table.agentId,
      table.connectorAccountId,
      table.idempotencyKey
    ),
    index("membership_authority_journal_scope_idx").on(
      table.agentId,
      table.connectorId,
      table.connectorAccountId,
      table.externalWorldId,
      table.externalRoomId,
      table.createdAt
    ),
    foreignKey({
      name: "fk_membership_authority_journal_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_membership_authority_journal_account",
      columns: [table.connectorAccountId, table.agentId],
      foreignColumns: [connectorAccountsTable.id, connectorAccountsTable.agentId],
    }).onDelete("cascade"),
    check(
      "membership_authority_journal_operation_check",
      sql`${table.operation} IN ('publisher','snapshot','membership','health')`
    ),
    check(
      "membership_authority_journal_generation_check",
      sql`${table.expectedGeneration} >= 0 AND ${table.committedGeneration} = ${table.expectedGeneration} + 1`
    ),
  ]
);
