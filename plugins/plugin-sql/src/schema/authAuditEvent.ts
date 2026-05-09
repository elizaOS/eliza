import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Append-only audit row for every sensitive auth action.
 *
 * Rows are also mirrored to JSONL on disk so a wiped DB does not lose history.
 * Token-shaped values in `metadata` MUST be redacted before insert by the
 * caller.
 */
export const authAuditEventTable = pgTable(
  "auth_audit_events",
  {
    id: text("id").primaryKey(),
    ts: bigint("ts", { mode: "number" }).notNull(),
    actorIdentityId: text("actor_identity_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean>>().notNull(),
  },
  (table) => [
    index("auth_audit_events_action_idx").on(table.action),
    index("auth_audit_events_ts_idx").on(table.ts),
    index("auth_audit_events_actor_idx").on(table.actorIdentityId),
  ]
);

export type AuthAuditOutcome = "success" | "failure";
