import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const sensitiveRequestKindEnum = pgEnum("sensitive_request_kind", [
  "secret",
  "payment",
  "oauth",
  "private_info",
]);

export const sensitiveRequestStatusEnum = pgEnum("sensitive_request_status", [
  "pending",
  "fulfilled",
  "failed",
  "canceled",
  "expired",
]);

export const sensitiveRequestAuditEventEnum = pgEnum("sensitive_request_audit_event", [
  "request.created",
  "request.viewed",
  "request.submitted",
  "request.fulfilled",
  "request.failed",
  "request.canceled",
  "request.expired",
  "token.used",
  "secret.set",
  "private_info.submitted",
]);

export const sensitiveRequestActorTypeEnum = pgEnum("sensitive_request_actor_type", [
  "user",
  "api_key",
  "token",
  "system",
]);

export type SensitiveRequestKind = (typeof sensitiveRequestKindEnum.enumValues)[number];
export type SensitiveRequestStatus = (typeof sensitiveRequestStatusEnum.enumValues)[number];
export type SensitiveRequestAuditEventType =
  (typeof sensitiveRequestAuditEventEnum.enumValues)[number];
export type SensitiveRequestActorType = (typeof sensitiveRequestActorTypeEnum.enumValues)[number];

export const sensitiveRequests = pgTable(
  "sensitive_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: sensitiveRequestKindEnum("kind").notNull(),
    status: sensitiveRequestStatusEnum("status").notNull().default("pending"),
    organization_id: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    agent_id: text("agent_id").notNull(),
    owner_entity_id: text("owner_entity_id"),
    requester_entity_id: text("requester_entity_id"),
    source_room_id: text("source_room_id"),
    source_channel_type: text("source_channel_type"),
    source_platform: text("source_platform"),
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    delivery: jsonb("delivery").$type<Record<string, unknown>>().notNull(),
    callback: jsonb("callback").$type<Record<string, unknown>>().notNull().default({}),
    token_hash: text("token_hash"),
    token_used_at: timestamp("token_used_at"),
    expires_at: timestamp("expires_at").notNull(),
    fulfilled_at: timestamp("fulfilled_at"),
    canceled_at: timestamp("canceled_at"),
    expired_at: timestamp("expired_at"),
    created_by: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("sensitive_requests_organization_idx").on(table.organization_id),
    agent_idx: index("sensitive_requests_agent_idx").on(table.agent_id),
    status_expires_idx: index("sensitive_requests_status_expires_idx").on(
      table.status,
      table.expires_at,
    ),
    token_hash_idx: uniqueIndex("sensitive_requests_token_hash_idx").on(table.token_hash),
    created_by_idx: index("sensitive_requests_created_by_idx").on(table.created_by),
  }),
);

export const sensitiveRequestEvents = pgTable(
  "sensitive_request_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    request_id: uuid("request_id")
      .notNull()
      .references(() => sensitiveRequests.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    event_type: sensitiveRequestAuditEventEnum("event_type").notNull(),
    actor_type: sensitiveRequestActorTypeEnum("actor_type").notNull().default("system"),
    actor_id: text("actor_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    request_created_idx: index("sensitive_request_events_request_created_idx").on(
      table.request_id,
      table.created_at,
    ),
    organization_created_idx: index("sensitive_request_events_organization_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    event_type_idx: index("sensitive_request_events_event_type_idx").on(table.event_type),
  }),
);

export type SensitiveRequest = InferSelectModel<typeof sensitiveRequests>;
export type NewSensitiveRequest = InferInsertModel<typeof sensitiveRequests>;
export type SensitiveRequestEvent = InferSelectModel<typeof sensitiveRequestEvents>;
export type NewSensitiveRequestEvent = InferInsertModel<typeof sensitiveRequestEvents>;
