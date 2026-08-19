/** Durable provider-stop recovery state for tenant containers suspended by compute billing. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { organizations } from "./organizations";

export type ComputeStopIntentStatus =
  | "pending"
  | "dispatching"
  | "retry"
  | "terminal_attention"
  | "provider_confirmed"
  | "superseded";

export const containerComputeStopIntents = pgTable(
  "container_compute_stop_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    container_id: uuid("container_id").notNull(),
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" }).notNull(),
    status: text("status").$type<ComputeStopIntentStatus>().notNull().default("pending"),
    job_id: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    last_error: text("last_error"),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    provider_started_at: timestamp("provider_started_at", { withTimezone: true }),
    provider_confirmed_at: timestamp("provider_confirmed_at", { withTimezone: true }),
    provider_node_id: text("provider_node_id"),
    slot_released_at: timestamp("slot_released_at", { withTimezone: true }),
    superseded_at: timestamp("superseded_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    active_unique: uniqueIndex("container_compute_stop_intents_active_unique")
      .on(table.organization_id, table.container_id)
      .where(sql`${table.status} IN ('pending', 'dispatching', 'retry', 'terminal_attention')`),
    recovery_idx: index("container_compute_stop_intents_recovery_idx")
      .on(table.status, table.next_attempt_at)
      .where(sql`${table.status} IN ('pending', 'retry', 'terminal_attention')`),
    status_check: check(
      "container_compute_stop_intents_status_check",
      sql`${table.status} IN ('pending', 'dispatching', 'retry', 'terminal_attention', 'provider_confirmed', 'superseded')`,
    ),
    attempts_check: check(
      "container_compute_stop_intents_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
  }),
);

export type ContainerComputeStopIntent = InferSelectModel<typeof containerComputeStopIntents>;
export type NewContainerComputeStopIntent = InferInsertModel<typeof containerComputeStopIntents>;
