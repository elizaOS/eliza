import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const analyticsAlertEvents = pgTable(
  "analytics_alert_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policy_id: text("policy_id").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    source: text("source").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    dedupe_key: text("dedupe_key").notNull(),
    evaluated_at: timestamp("evaluated_at").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    org_created_idx: index("analytics_alert_events_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    org_status_idx: index("analytics_alert_events_org_status_idx").on(
      table.organization_id,
      table.status,
    ),
    severity_idx: index("analytics_alert_events_severity_idx").on(table.severity),
    org_dedupe_unique: uniqueIndex("analytics_alert_events_org_dedupe_unique").on(
      table.organization_id,
      table.dedupe_key,
    ),
  }),
);

export type AnalyticsAlertEvent = InferSelectModel<typeof analyticsAlertEvents>;
export type NewAnalyticsAlertEvent = InferInsertModel<typeof analyticsAlertEvents>;
