import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type MetricsPlatform = "web" | "telegram" | "discord" | "imessage" | "sms";

/**
 * Pre-computed daily engagement metrics.
 * Aggregated by a nightly cron job from conversation_messages,
 * phone_message_log, and Eliza room/memory tables.
 *
 * Each row is one (date, platform) pair. A null platform means the
 * aggregated total across all platforms for that date.
 */
export const dailyMetrics = pgTable(
  "daily_metrics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    date: timestamp("date").notNull(),
    platform: text("platform").$type<MetricsPlatform | null>(),
    dau: integer("dau").notNull().default(0),
    new_signups: integer("new_signups").notNull().default(0),
    total_messages: integer("total_messages").notNull().default(0),
    messages_per_user: numeric("messages_per_user", {
      precision: 10,
      scale: 2,
    }).default("0"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    date_platform_idx: uniqueIndex("daily_metrics_date_platform_idx").on(
      table.date,
      table.platform,
    ),
    date_idx: index("daily_metrics_date_idx").on(table.date),
  }),
);

export type DailyMetric = InferSelectModel<typeof dailyMetrics>;
export type NewDailyMetric = InferInsertModel<typeof dailyMetrics>;
