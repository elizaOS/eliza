import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Inbox plugin schema.
 *
 * MIGRATION: Replaces ad-hoc tables under plugin-lifeops/src/inbox/repository.ts.
 * The repository there will be re-pointed at these tables in a follow-up pass.
 */
export const inboxSchema = pgSchema("app_inbox");

/**
 * Triage decisions: one row per (thread, decision-event).
 * History-style; the most-recent row by `decidedAt` is the effective decision.
 */
export const triageDecisionsTable = inboxSchema.table(
  "triage_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    channel: text("channel").notNull(),
    threadId: text("thread_id").notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale"),
    decidedAt: timestamp("decided_at").default(sql`now()`).notNull(),
    expiresAt: timestamp("expires_at"),
    metadata: jsonb("metadata").default("{}").notNull(),
  },
  (table) => ({
    entityChannelIdx: index("idx_inbox_triage_entity_channel").on(
      table.entityId,
      table.channel,
    ),
    threadIdx: index("idx_inbox_triage_thread").on(table.threadId),
    decidedAtIdx: index("idx_inbox_triage_decided_at").on(table.decidedAt),
  }),
);

/**
 * Snoozed threads — surface again when `wakeAt` passes.
 */
export const snoozedTable = inboxSchema.table(
  "snoozed",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    channel: text("channel").notNull(),
    threadId: text("thread_id").notNull(),
    snoozedAt: timestamp("snoozed_at").default(sql`now()`).notNull(),
    wakeAt: timestamp("wake_at").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").default("{}").notNull(),
  },
  (table) => ({
    entityWakeIdx: index("idx_inbox_snoozed_entity_wake").on(
      table.entityId,
      table.wakeAt,
    ),
    threadIdx: index("idx_inbox_snoozed_thread").on(table.threadId),
  }),
);

/**
 * Archived threads — explicitly removed from active inbox.
 */
export const archivedTable = inboxSchema.table(
  "archived",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    channel: text("channel").notNull(),
    threadId: text("thread_id").notNull(),
    archivedAt: timestamp("archived_at").default(sql`now()`).notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").default("{}").notNull(),
  },
  (table) => ({
    entityArchivedIdx: index("idx_inbox_archived_entity").on(
      table.entityId,
      table.archivedAt,
    ),
    threadIdx: index("idx_inbox_archived_thread").on(table.threadId),
  }),
);

export type TriageDecisionRow = typeof triageDecisionsTable.$inferSelect;
export type TriageDecisionInsert = typeof triageDecisionsTable.$inferInsert;
export type SnoozedRow = typeof snoozedTable.$inferSelect;
export type SnoozedInsert = typeof snoozedTable.$inferInsert;
export type ArchivedRow = typeof archivedTable.$inferSelect;
export type ArchivedInsert = typeof archivedTable.$inferInsert;
