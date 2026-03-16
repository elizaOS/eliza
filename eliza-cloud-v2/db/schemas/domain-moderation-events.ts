/**
 * Domain Moderation Events Schema
 *
 * Tracks moderation actions and events for managed domains.
 * Used for audit trail and escalation tracking.
 */

import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { managedDomains } from "./managed-domains";
import { users } from "./users";

export const domainEventTypeEnum = pgEnum("domain_event_type", [
  "name_check",
  "auto_flag",
  "admin_flag",
  "health_check",
  "content_scan",
  "user_report",
  "suspension",
  "reinstatement",
  "dns_change",
  "assignment_change",
  "verification",
  "renewal",
  "expiration_warning",
]);

export const domainEventSeverityEnum = pgEnum("domain_event_severity", [
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);

export const domainEventDetectedByEnum = pgEnum("domain_event_detected_by", [
  "system",
  "admin",
  "user_report",
  "automated_scan",
  "health_monitor",
]);

// Evidence structure for moderation events
export interface DomainEventEvidence {
  screenshot?: string; // URL to screenshot
  contentSample?: string; // Sample of flagged content
  dnsRecords?: Record<string, string>[];
  httpResponse?: {
    statusCode: number;
    headers?: Record<string, string>;
  };
  matchedPatterns?: string[];
  externalReports?: string[];
}

export const domainModerationEvents = pgTable(
  "domain_moderation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => managedDomains.id, { onDelete: "cascade" }),

    // Event details
    eventType: domainEventTypeEnum("event_type").notNull(),
    severity: domainEventSeverityEnum("severity").notNull(),
    description: text("description").notNull(),

    // Detection source
    detectedBy: domainEventDetectedByEnum("detected_by").notNull(),
    adminUserId: uuid("admin_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // Evidence and context
    evidence: jsonb("evidence").$type<DomainEventEvidence>(),

    // Action taken
    actionTaken: text("action_taken"), // 'flagged', 'suspended', 'warning_sent', etc.
    previousStatus: text("previous_status"),
    newStatus: text("new_status"),

    // Resolution
    resolvedAt: timestamp("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    resolutionNotes: text("resolution_notes"),

    // Timestamps
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    domainIdx: index("domain_mod_events_domain_idx").on(table.domainId),
    eventTypeIdx: index("domain_mod_events_type_idx").on(table.eventType),
    severityIdx: index("domain_mod_events_severity_idx").on(table.severity),
    createdIdx: index("domain_mod_events_created_idx").on(table.createdAt),
    unresolvedIdx: index("domain_mod_events_unresolved_idx").on(
      table.resolvedAt,
    ),
  }),
);

export type DomainModerationEvent = InferSelectModel<
  typeof domainModerationEvents
>;
export type NewDomainModerationEvent = InferInsertModel<
  typeof domainModerationEvents
>;
