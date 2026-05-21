import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Append-only audit log for authentication and authorization events.
 *
 * Mirrors the `AuditEvent` shape exported by `@elizaos/security/audit`. Rows
 * are written by the `AuditEventsSink` registered on the global dispatcher in
 * `cloud-api/bootstrap-app.ts`.
 *
 * SOC2 references: CC6.1 (logical access), CC6.3 (authorization), CC7.2
 * (monitoring), CC4.1 (control monitoring).
 */
export const authEvents = pgTable(
  "auth_events",
  {
    event_id: uuid("event_id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actor_type: text("actor_type").notNull(),
    actor_id: text("actor_id").notNull(),
    action: text("action").notNull(),
    result: text("result").notNull(),
    resource_type: text("resource_type"),
    resource_id: text("resource_id"),
    ip: text("ip"),
    ua: text("ua"),
    request_id: text("request_id"),
    org_id: text("org_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => ({
    ts_idx: index("auth_events_ts_idx").on(table.ts),
    actor_idx: index("auth_events_actor_idx").on(table.actor_type, table.actor_id),
    action_idx: index("auth_events_action_idx").on(table.action),
    org_idx: index("auth_events_org_idx").on(table.org_id),
    result_idx: index("auth_events_result_idx").on(table.result),
  }),
);

export type AuthEventRow = InferSelectModel<typeof authEvents>;
export type NewAuthEventRow = InferInsertModel<typeof authEvents>;
