/** Stores generation-fenced ownership of synthetic test namespaces. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const syntheticEnvironmentLeases = pgTable(
  "synthetic_environment_leases",
  {
    namespace: text("namespace").primaryKey(),
    generation: integer("generation").notNull(),
    lease_id: uuid("lease_id"),
    owner_id: text("owner_id"),
    owner_process_id: integer("owner_process_id"),
    owner_host: text("owner_host"),
    acquired_at: timestamp("acquired_at", { withTimezone: true }),
    heartbeat_at: timestamp("heartbeat_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    released_at: timestamp("released_at", { withTimezone: true }),
    revision: integer("revision").notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expires_idx: index("synthetic_environment_leases_expires_idx").on(table.expires_at),
    generation_check: check(
      "synthetic_environment_leases_generation_check",
      sql`${table.generation} >= 0 AND ${table.revision} >= 0`,
    ),
    authority_shape_check: check(
      "synthetic_environment_leases_authority_shape_check",
      sql`(
        ${table.lease_id} IS NULL
        AND ${table.owner_id} IS NULL
        AND ${table.owner_process_id} IS NULL
        AND ${table.owner_host} IS NULL
        AND ${table.expires_at} IS NULL
      ) OR (
        ${table.lease_id} IS NOT NULL
        AND ${table.owner_id} IS NOT NULL
        AND ${table.owner_host} IS NOT NULL
        AND ${table.acquired_at} IS NOT NULL
        AND ${table.heartbeat_at} IS NOT NULL
        AND ${table.expires_at} IS NOT NULL
      )`,
    ),
  }),
);

export type SyntheticEnvironmentLease = InferSelectModel<typeof syntheticEnvironmentLeases>;
export type NewSyntheticEnvironmentLease = InferInsertModel<typeof syntheticEnvironmentLeases>;
