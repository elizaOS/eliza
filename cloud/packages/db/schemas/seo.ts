import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { users } from "./users";

export const seoRequestTypeEnum = pgEnum("seo_request_type", [
  "keyword_research",
  "serp_snapshot",
  "meta_generate",
  "schema_generate",
  "publish_bundle",
  "index_now",
  "health_check",
]);

export const seoRequestStatusEnum = pgEnum("seo_request_status", [
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

export const seoArtifactTypeEnum = pgEnum("seo_artifact_type", [
  "keywords",
  "meta",
  "schema",
  "serp_snapshot",
  "health_report",
  "indexnow_submission",
]);

export const seoProviderEnum = pgEnum("seo_provider", [
  "dataforseo",
  "serpapi",
  "claude",
  "indexnow",
  "bing",
]);

export const seoProviderStatusEnum = pgEnum("seo_provider_status", [
  "pending",
  "completed",
  "failed",
]);

export const seoRequests = pgTable(
  "seo_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app_id: uuid("app_id").references(() => apps.id, { onDelete: "set null" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    api_key_id: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    type: seoRequestTypeEnum("type").notNull(),
    status: seoRequestStatusEnum("status").notNull().default("pending"),
    page_url: text("page_url"),
    locale: text("locale").notNull().default("en-US"),
    search_engine: text("search_engine").notNull().default("google"),
    device: text("device").notNull().default("desktop"),
    environment: text("environment").notNull().default("production"),
    agent_identifier: text("agent_identifier"),
    keywords: jsonb("keywords").$type<string[]>().default([]),
    prompt_context: text("prompt_context"),
    prompt_context_storage: text("prompt_context_storage").notNull().default("inline"),
    prompt_context_key: text("prompt_context_key"),
    idempotency_key: text("idempotency_key"),
    total_cost: numeric("total_cost", { precision: 10, scale: 4 }).notNull().default("0"),
    error: text("error"),
    completed_at: timestamp("completed_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    org_idx: index("seo_requests_org_idx").on(table.organization_id),
    app_idx: index("seo_requests_app_idx").on(table.app_id),
    type_idx: index("seo_requests_type_idx").on(table.type),
    status_idx: index("seo_requests_status_idx").on(table.status),
    org_status_created_idx: index("seo_requests_org_status_created_idx").on(
      table.organization_id,
      table.status,
      table.created_at,
    ),
    idempotency_idx: uniqueIndex("seo_requests_idempotency_idx").on(
      table.organization_id,
      table.idempotency_key,
    ),
  }),
);

export const seoArtifacts = pgTable(
  "seo_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    request_id: uuid("request_id")
      .notNull()
      .references(() => seoRequests.id, { onDelete: "cascade" }),
    type: seoArtifactTypeEnum("type").notNull(),
    provider: seoProviderEnum("provider").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    data_storage: text("data_storage").notNull().default("inline"),
    data_key: text("data_key"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    request_idx: index("seo_artifacts_request_idx").on(table.request_id),
    type_idx: index("seo_artifacts_type_idx").on(table.type),
  }),
);

export const seoProviderCalls = pgTable(
  "seo_provider_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    request_id: uuid("request_id")
      .notNull()
      .references(() => seoRequests.id, { onDelete: "cascade" }),
    provider: seoProviderEnum("provider").notNull(),
    operation: text("operation").notNull(),
    status: seoProviderStatusEnum("status").notNull().default("pending"),
    external_id: text("external_id"),
    cost: numeric("cost", { precision: 10, scale: 4 }).notNull().default("0"),
    request_payload: jsonb("request_payload").$type<Record<string, unknown>>(),
    request_payload_storage: text("request_payload_storage").notNull().default("inline"),
    request_payload_key: text("request_payload_key"),
    response_payload: jsonb("response_payload").$type<Record<string, unknown>>(),
    response_payload_storage: text("response_payload_storage").notNull().default("inline"),
    response_payload_key: text("response_payload_key"),
    error: text("error"),
    started_at: timestamp("started_at").notNull().defaultNow(),
    completed_at: timestamp("completed_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    request_idx: index("seo_provider_calls_request_idx").on(table.request_id),
    provider_idx: index("seo_provider_calls_provider_idx").on(table.provider),
    status_idx: index("seo_provider_calls_status_idx").on(table.status),
  }),
);

export type SeoRequest = InferSelectModel<typeof seoRequests>;
export type NewSeoRequest = InferInsertModel<typeof seoRequests>;

export type SeoArtifact = InferSelectModel<typeof seoArtifacts>;
export type NewSeoArtifact = InferInsertModel<typeof seoArtifacts>;

export type SeoProviderCall = InferSelectModel<typeof seoProviderCalls>;
export type NewSeoProviderCall = InferInsertModel<typeof seoProviderCalls>;
