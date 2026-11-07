/** Existing calendar receipt table identity is retained across plugin ownership. */
import { index, integer, pgSchema, text, unique } from "drizzle-orm/pg-core";

const appLifeopsPgSchema = pgSchema("app_lifeops");
export const lifeCalendarMutationAttempts = appLifeopsPgSchema.table(
  "life_calendar_mutation_attempts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    approvalRequestId: text("approval_request_id").notNull(),
    approvalSha256: text("approval_sha256").notNull(),
    operationKey: text("operation_key").notNull(),
    operation: text("operation").notNull(),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    executorSessionId: text("executor_session_id"),
    claimToken: text("claim_token"),
    provider: text("provider"),
    sourceId: text("source_id"),
    calendarId: text("calendar_id"),
    eventId: text("event_id"),
    providerEventId: text("provider_event_id"),
    providerVersion: text("provider_version"),
    receiptJson: text("receipt_json"),
    lastFailureJson: text("last_failure_json"),
    firstAttemptedAt: text("first_attempted_at"),
    lastAttemptedAt: text("last_attempted_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.approvalRequestId),
    unique().on(t.agentId, t.operationKey),
    index("idx_life_calendar_mutation_state").on(
      t.agentId,
      t.state,
      t.updatedAt,
    ),
  ],
);
