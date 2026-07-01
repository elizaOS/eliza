import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { MetricsPlatform } from "./daily-metrics";

/**
 * Cohort-based retention metrics.
 * For each signup date (cohort_date), tracks how many users returned
 * on D1, D7, and D30.
 *
 * A null platform means the aggregated total across all platforms.
 */
export const retentionCohorts = pgTable(
  "retention_cohorts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cohort_date: timestamp("cohort_date").notNull(),
    platform: text("platform").$type<MetricsPlatform | null>(),
    cohort_size: integer("cohort_size").notNull(),
    d1_retained: integer("d1_retained"),
    d7_retained: integer("d7_retained"),
    d30_retained: integer("d30_retained"),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    cohort_platform_idx: uniqueIndex("retention_cohorts_cohort_platform_idx").on(
      table.cohort_date,
      table.platform,
    ),
  }),
);

export type RetentionCohort = InferSelectModel<typeof retentionCohorts>;
export type NewRetentionCohort = InferInsertModel<typeof retentionCohorts>;
