/**
 * PR / press distribution domain model (#11818).
 *
 * This stores the Cloud-owned release draft, distribution attempts, media
 * contacts, and coverage artifacts. External newswire/provider execution is a
 * later slice; this schema gives those providers an idempotent state machine to
 * attach to without inventing their own persistence.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export type PressReleaseStatus =
  | "draft"
  | "ready"
  | "submitted"
  | "distributed"
  | "failed"
  | "cancelled";

export type PressDistributionStatus =
  | "pending"
  | "submitted"
  | "distributed"
  | "failed"
  | "cancelled";

export type MediaContactStatus = "active" | "inactive";

export interface PressReleaseAsset {
  url: string;
  mimeType?: string;
  label?: string;
}

export interface PressReleaseTargetAudience {
  niches?: string[];
  regions?: string[];
  languages?: string[];
  outletTypes?: string[];
}

export const pressReleases = pgTable(
  "press_releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_by_user_id: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    title: text("title").notNull(),
    summary: text("summary"),
    body: text("body").notNull(),
    boilerplate: text("boilerplate"),
    status: text("status").$type<PressReleaseStatus>().notNull().default("draft"),
    target_audience: jsonb("target_audience")
      .$type<PressReleaseTargetAudience>()
      .notNull()
      .default({}),
    target_regions: jsonb("target_regions").$type<string[]>().notNull().default([]),
    assets: jsonb("assets").$type<PressReleaseAsset[]>().notNull().default([]),
    embargo_at: timestamp("embargo_at"),
    submitted_at: timestamp("submitted_at"),
    distributed_at: timestamp("distributed_at"),
    failed_reason: text("failed_reason"),
    idempotency_key: text("idempotency_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    org_idx: index("press_releases_org_idx").on(table.organization_id),
    status_idx: index("press_releases_status_idx").on(table.status),
    created_idx: index("press_releases_created_idx").on(table.created_at),
    idempotency_key_uidx: uniqueIndex("press_releases_idempotency_key_uidx").on(
      table.idempotency_key,
    ),
  }),
);

export const pressReleaseDistributions = pgTable(
  "press_release_distributions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    press_release_id: uuid("press_release_id")
      .notNull()
      .references(() => pressReleases.id, { onDelete: "cascade" }),

    provider: text("provider").notNull(),
    external_distribution_id: text("external_distribution_id"),
    status: text("status").$type<PressDistributionStatus>().notNull().default("pending"),
    idempotency_key: text("idempotency_key"),
    request_payload: jsonb("request_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    provider_response: jsonb("provider_response")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    error_message: text("error_message"),
    submitted_at: timestamp("submitted_at"),
    completed_at: timestamp("completed_at"),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    org_idx: index("press_release_distributions_org_idx").on(table.organization_id),
    release_idx: index("press_release_distributions_release_idx").on(table.press_release_id),
    provider_idx: index("press_release_distributions_provider_idx").on(table.provider),
    idempotency_key_uidx: uniqueIndex("press_release_distributions_idempotency_key_uidx").on(
      table.idempotency_key,
    ),
  }),
);

export const pressMediaContacts = pgTable(
  "press_media_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_by_user_id: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    name: text("name").notNull(),
    outlet: text("outlet").notNull(),
    email: text("email"),
    beat: text("beat"),
    region: text("region"),
    status: text("status").$type<MediaContactStatus>().notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    org_idx: index("press_media_contacts_org_idx").on(table.organization_id),
    status_idx: index("press_media_contacts_status_idx").on(table.status),
  }),
);

export const pressCoverage = pgTable(
  "press_coverage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    press_release_id: uuid("press_release_id")
      .notNull()
      .references(() => pressReleases.id, { onDelete: "cascade" }),
    distribution_id: uuid("distribution_id").references(() => pressReleaseDistributions.id, {
      onDelete: "set null",
    }),

    url: text("url").notNull(),
    title: text("title"),
    outlet: text("outlet"),
    published_at: timestamp("published_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    org_idx: index("press_coverage_org_idx").on(table.organization_id),
    release_idx: index("press_coverage_release_idx").on(table.press_release_id),
    url_uidx: uniqueIndex("press_coverage_release_url_uidx").on(table.press_release_id, table.url),
  }),
);

export type PressRelease = InferSelectModel<typeof pressReleases>;
export type NewPressRelease = InferInsertModel<typeof pressReleases>;
export type PressReleaseDistribution = InferSelectModel<typeof pressReleaseDistributions>;
export type NewPressReleaseDistribution = InferInsertModel<typeof pressReleaseDistributions>;
export type PressMediaContact = InferSelectModel<typeof pressMediaContacts>;
export type NewPressMediaContact = InferInsertModel<typeof pressMediaContacts>;
export type PressCoverage = InferSelectModel<typeof pressCoverage>;
export type NewPressCoverage = InferInsertModel<typeof pressCoverage>;
