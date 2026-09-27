/** Durable, generation-fenced Dedicated-to-Shared fallback transitions for personal agents (#25146). */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export type PersonalDedicatedFallbackState = "shared_active" | "recovered";
export type PersonalDedicatedFallbackReason = "billing_suspended";

export const personalDedicatedFallbacks = pgTable(
  "personal_dedicated_fallbacks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").notNull(),
    /** Canonical `personal:` Shared identity. Account authority stays stable. */
    source_agent_id: text("source_agent_id").notNull(),
    dedicated_agent_id: uuid("dedicated_agent_id").notNull(),
    /** Monotonic per account; a new withdrawal never reopens an older interval. */
    generation: integer("generation").notNull(),
    state: text("state").$type<PersonalDedicatedFallbackState>().notNull(),
    reason: text("reason").$type<PersonalDedicatedFallbackReason>().notNull(),
    /** The provider-confirmed billing stop that withdrew Dedicated access. */
    stop_intent_id: uuid("stop_intent_id").notNull(),
    /**
     * Separately scoped Shared journal for this interval only. It is never the
     * canonical room, so Shared cannot read Dedicated or pre-upgrade history.
     */
    journal_room_id: text("journal_room_id").notNull(),
    activated_at: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    recovered_at: timestamp("recovered_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    generation_unique: uniqueIndex("personal_dedicated_fallbacks_generation_unique").on(
      table.organization_id,
      table.user_id,
      table.source_agent_id,
      table.generation,
    ),
    active_unique: uniqueIndex("personal_dedicated_fallbacks_active_unique")
      .on(table.organization_id, table.user_id, table.source_agent_id)
      .where(sql`${table.state} = 'shared_active'`),
    journal_unique: uniqueIndex("personal_dedicated_fallbacks_journal_unique").on(
      table.journal_room_id,
    ),
    dedicated_idx: index("personal_dedicated_fallbacks_dedicated_idx").on(table.dedicated_agent_id),
    state_check: check(
      "personal_dedicated_fallbacks_state_check",
      sql`(${table.state} = 'shared_active' AND ${table.recovered_at} IS NULL)
        OR (${table.state} = 'recovered' AND ${table.recovered_at} IS NOT NULL)`,
    ),
    reason_check: check(
      "personal_dedicated_fallbacks_reason_check",
      sql`${table.reason} IN ('billing_suspended')`,
    ),
    generation_check: check(
      "personal_dedicated_fallbacks_generation_check",
      sql`${table.generation} >= 1`,
    ),
  }),
);

export type PersonalDedicatedFallback = InferSelectModel<typeof personalDedicatedFallbacks>;
export type NewPersonalDedicatedFallback = InferInsertModel<typeof personalDedicatedFallbacks>;
