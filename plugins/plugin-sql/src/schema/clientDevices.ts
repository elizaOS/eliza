/** Enrollment only; proposals and execution receipts stay in approval_requests. */
import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
export const clientDeviceTable = pgTable(
  "client_devices",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentTable.id, { onDelete: "cascade" }),
    subjectUserId: text("subject_user_id").notNull(),
    installationId: text("installation_id").notNull(),
    enrollmentId: uuid("enrollment_id").notNull(),
    keyHash: text("key_hash").notNull(),
    label: text("label").notNull(),
    /** Trusted workflow owner; null preserves pre-binding enrollments. */
    workflowOwnerId: text("workflow_owner_id"),
    /** Authenticated installation view subset; null preserves legacy clients. */
    viewProfile: text("view_profile"),
    workflowProtocol: integer("workflow_protocol").notNull().default(0),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.subjectUserId, table.installationId] })]
);
