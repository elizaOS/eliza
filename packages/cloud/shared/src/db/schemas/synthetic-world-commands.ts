/** Stores lease-generation-fenced synthetic command journal records. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const syntheticWorldCommands = pgTable(
  "synthetic_world_commands",
  {
    namespace: text("namespace").notNull(),
    command_id: text("command_id").notNull(),
    generation: integer("generation").notNull(),
    command_type: text("command_type").notNull(),
    payload_hash: text("payload_hash").notNull(),
    payload_json: text("payload_json").notNull(),
    phase: text("phase").notNull(),
    outcome: text("outcome").notNull(),
    result_json: text("result_json"),
    error_code: text("error_code"),
    error_message: text("error_message"),
    execution_token: text("execution_token"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull(),
    heartbeat_at: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => ({
    primary_key: primaryKey({ columns: [table.namespace, table.command_id] }),
    recovery_idx: index("synthetic_world_commands_recovery_idx").on(
      table.namespace,
      table.generation,
      table.phase,
    ),
    generation_revision_check: check(
      "synthetic_world_commands_generation_revision_check",
      sql`${table.generation} > 0 AND ${table.revision} > 0`,
    ),
    phase_check: check(
      "synthetic_world_commands_phase_check",
      sql`${table.phase} IN ('OWNED', 'EXECUTING', 'COMMITTED', 'SUCCEEDED', 'FAILED', 'DIRTY')`,
    ),
    outcome_check: check(
      "synthetic_world_commands_outcome_check",
      sql`${table.outcome} IN ('PENDING', 'KNOWN_SUCCESS', 'KNOWN_FAILURE', 'UNKNOWN')`,
    ),
  }),
);

export type SyntheticWorldCommandRow = InferSelectModel<typeof syntheticWorldCommands>;
export type NewSyntheticWorldCommandRow = InferInsertModel<typeof syntheticWorldCommands>;
