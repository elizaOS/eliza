/**
 * Drizzle schema for @elizaos/plugin-finances.
 *
 * Tables live in their own pgSchema("app_finances") namespace so they do not
 * collide with other plugins. Schema is intentionally minimal for the scaffold:
 * the real columns will be filled in when the OWNER_FINANCES action and its
 * payments / recurring-charge helpers are migrated from
 * plugins/plugin-lifeops/src/actions/owner-surfaces.ts and
 * plugins/plugin-lifeops/src/actions/payments.ts.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const financesSchema = pgSchema("app_finances");

export const transactionsTable = financesSchema.table(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    description: text("description").notNull(),
    category: text("category"),
    merchant: text("merchant"),
    status: text("status").notNull(),
    source: text("source"),
    metadata: jsonb("metadata").default("{}").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    entityOccurredIdx: index("idx_finances_tx_entity_occurred").on(
      table.entityId,
      table.occurredAt,
    ),
    agentEntityIdx: index("idx_finances_tx_agent_entity").on(
      table.agentId,
      table.entityId,
    ),
  }),
);

export const recurringChargesTable = financesSchema.table(
  "recurring_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    label: text("label").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    cadence: text("cadence").notNull(),
    nextChargeAt: timestamp("next_charge_at"),
    merchant: text("merchant"),
    active: boolean("active").default(true).notNull(),
    metadata: jsonb("metadata").default("{}").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    entityActiveIdx: index("idx_finances_recurring_entity_active").on(
      table.entityId,
      table.active,
    ),
    agentEntityIdx: index("idx_finances_recurring_agent_entity").on(
      table.agentId,
      table.entityId,
    ),
  }),
);

export type TransactionRow = typeof transactionsTable.$inferSelect;
export type TransactionInsert = typeof transactionsTable.$inferInsert;
export type RecurringChargeRow = typeof recurringChargesTable.$inferSelect;
export type RecurringChargeInsert = typeof recurringChargesTable.$inferInsert;
