import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { entityTable } from "./entity";

/**
 * Strengthened (platform, handle) claim attached to an entity. Re-observations
 * of the same pair bump confidence and append to evidence_message_ids rather
 * than producing duplicate rows.
 */
export const entityIdentityTable = pgTable(
  "entity_identities",
  {
    id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entityTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    verified: boolean("verified").notNull().default(false),
    confidence: real("confidence").notNull().default(0),
    source: text("source"),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().default(sql`now()`),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().default(sql`now()`),
    evidenceMessageIds: jsonb("evidence_message_ids").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    index("idx_entity_identities_entity").on(table.entityId),
    index("idx_entity_identities_platform_handle").on(table.platform, table.handle),
    unique("unique_entity_identity").on(
      table.entityId,
      table.platform,
      table.handle,
      table.agentId
    ),
    foreignKey({
      name: "fk_entity_identities_entity",
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_entity_identities_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
  ]
);

export const entityMergeCandidateTable = pgTable(
  "entity_merge_candidates",
  {
    id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    entityA: uuid("entity_a")
      .notNull()
      .references(() => entityTable.id, { onDelete: "cascade" }),
    entityB: uuid("entity_b")
      .notNull()
      .references(() => entityTable.id, { onDelete: "cascade" }),
    confidence: real("confidence").notNull().default(0),
    evidence: jsonb("evidence"),
    status: text("status").notNull().default("pending"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().default(sql`now()`),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_entity_merge_candidates_status").on(table.status),
    index("idx_entity_merge_candidates_pair").on(table.entityA, table.entityB),
    foreignKey({
      name: "fk_entity_merge_candidates_a",
      columns: [table.entityA],
      foreignColumns: [entityTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_entity_merge_candidates_b",
      columns: [table.entityB],
      foreignColumns: [entityTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_entity_merge_candidates_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
  ]
);

/**
 * Pending fact refinement proposals (contradictions / merges) surfaced from
 * the FactRefinementEvaluator. The Facts tab in the UI lets users accept
 * or reject these.
 */
export const factCandidateTable = pgTable(
  "fact_candidates",
  {
    id: uuid("id").notNull().primaryKey().default(sql`gen_random_uuid()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entityTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    existingFactId: uuid("existing_fact_id"),
    proposedText: text("proposed_text").notNull(),
    confidence: real("confidence").notNull().default(0),
    evidence: jsonb("evidence"),
    status: text("status").notNull().default("pending"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().default(sql`now()`),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_fact_candidates_status").on(table.status),
    index("idx_fact_candidates_entity").on(table.entityId),
    foreignKey({
      name: "fk_fact_candidates_entity",
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_fact_candidates_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
  ]
);
