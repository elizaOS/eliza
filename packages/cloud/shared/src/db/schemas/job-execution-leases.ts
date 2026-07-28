/**
 * Renewable process ownership for detached job executions.
 *
 * Lease heartbeats are isolated from the jobs row so they do not perturb the
 * payload snapshot used by retry and settlement compare-and-swap operations.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";

export const jobExecutionLeases = pgTable(
  "job_execution_leases",
  {
    job_id: uuid("job_id")
      .primaryKey()
      .references(() => jobs.id, { onDelete: "cascade" }),
    execution_generation: uuid("execution_generation").notNull(),
    owner_id: uuid("owner_id").notNull(),
    expires_at: timestamp("expires_at").notNull(),
    heartbeat_at: timestamp("heartbeat_at").notNull().defaultNow(),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    expires_idx: index("job_execution_leases_expires_idx").on(table.expires_at),
  }),
);

export type JobExecutionLease = InferSelectModel<typeof jobExecutionLeases>;
export type NewJobExecutionLease = InferInsertModel<typeof jobExecutionLeases>;
