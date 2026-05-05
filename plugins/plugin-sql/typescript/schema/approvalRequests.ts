import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";

/**
 * Persistent backing store for the LifeOps human-in-the-loop approval queue.
 *
 * Owned by `plugins/app-lifeops` (see `src/lifeops/approval-queue.types.ts`),
 * but lives in plugin-sql so the runtime migrator picks it up automatically
 * for both PostgreSQL and PGlite deployments.
 *
 * Migration safety: this table is additive. It is created on first boot via
 * the runtime migrator when absent, and existing databases are unaffected.
 *
 * State, action, channel, resolved_by, resolution_reason, and resolved_at are
 * intentionally text/timestamp without a CHECK constraint — the application
 * layer is the single source of truth for the state machine and the closed
 * action/channel enums (Commandment 7).
 */
export const approvalRequestTable = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Lifecycle state. See `ApprovalRequestState` in app-lifeops. */
    state: text("state").notNull(),
    /** Agent or service that enqueued the request. */
    requestedBy: text("requested_by").notNull(),
    /** Owner whose approval is required. */
    subjectUserId: text("subject_user_id").notNull(),
    /** Closed enum from `ApprovalAction`. */
    action: text("action").notNull(),
    /** Discriminated union from `ApprovalPayload`. */
    payload: jsonb("payload").notNull(),
    /** Closed enum from `ApprovalChannel`. */
    channel: text("channel").notNull(),
    /** Required justification for the request. */
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Null until the request leaves `pending`. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Null until resolved; resolver identity. */
    resolvedBy: text("resolved_by"),
    /** Null until resolved; human-readable resolution note. */
    resolutionReason: text("resolution_reason"),
    /** Owning agent (cascade-deletes when the agent is removed). */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    index("approval_requests_subject_state_idx").on(table.subjectUserId, table.state),
    index("approval_requests_agent_state_idx").on(table.agentId, table.state),
    index("approval_requests_state_expires_idx").on(table.state, table.expiresAt),
  ]
);
