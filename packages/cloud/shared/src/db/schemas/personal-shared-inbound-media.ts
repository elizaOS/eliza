/**
 * Durable admission ledger for pooled-key vision descriptions of inbound
 * Personal Shared media. One description row per connector message id is the
 * enrichment idempotency record (a provider redelivery reuses the stored text
 * instead of re-spending); the quota rows are atomic per-day image counters
 * for the sending account and for the connector as a whole.
 */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export type PersonalSharedInboundMediaPlatform = "blooio";
export type PersonalSharedInboundMediaDescriptionState = "pending" | "described" | "failed";
export type PersonalSharedInboundMediaQuotaScope = "sender" | "connector";

export const personalSharedInboundMediaDescriptions = pgTable(
  "personal_shared_inbound_media_descriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    platform: text("platform").$type<PersonalSharedInboundMediaPlatform>().notNull(),
    project: text("project").notNull(),
    connector_account_id: text("connector_account_id").notNull(),
    /** The connector message id the gateway forwards as the turn's clientMessageId. */
    source_message_id: text("source_message_id").notNull(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Digest of the exact media URL list the claim covers. */
    media_digest: text("media_digest").notNull(),
    image_count: integer("image_count").notNull(),
    state: text("state")
      .$type<PersonalSharedInboundMediaDescriptionState>()
      .notNull()
      .default("pending"),
    /** Fences completion to the execution that holds the live claim. */
    claim_token: uuid("claim_token").notNull(),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    attempt_count: integer("attempt_count").notNull().default(1),
    description: text("description"),
    failure_reason: text("failure_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    platform_check: check(
      "personal_shared_inbound_media_descriptions_platform_check",
      sql`${table.platform} IN ('blooio')`,
    ),
    state_check: check(
      "personal_shared_inbound_media_descriptions_state_check",
      sql`${table.state} IN ('pending', 'described', 'failed')`,
    ),
    image_count_check: check(
      "personal_shared_inbound_media_descriptions_image_count_check",
      sql`${table.image_count} > 0`,
    ),
    attempt_count_check: check(
      "personal_shared_inbound_media_descriptions_attempt_count_check",
      sql`${table.attempt_count} > 0`,
    ),
    terminal_shape_check: check(
      "personal_shared_inbound_media_descriptions_terminal_shape_check",
      sql`(
        ${table.state} = 'pending'
        AND ${table.description} IS NULL
        AND ${table.failure_reason} IS NULL
        AND ${table.completed_at} IS NULL
      ) OR (
        ${table.state} = 'described'
        AND ${table.description} IS NOT NULL
        AND ${table.failure_reason} IS NULL
        AND ${table.completed_at} IS NOT NULL
      ) OR (
        ${table.state} = 'failed'
        AND ${table.description} IS NULL
        AND ${table.failure_reason} IS NOT NULL
        AND ${table.completed_at} IS NOT NULL
      )`,
    ),
    source_unique: uniqueIndex("personal_shared_inbound_media_descriptions_source_uidx").on(
      table.platform,
      table.project,
      table.connector_account_id,
      table.source_message_id,
    ),
    organization_created_idx: index(
      "personal_shared_inbound_media_descriptions_org_created_idx",
    ).on(table.organization_id, table.created_at),
  }),
);

export const personalSharedInboundMediaQuotas = pgTable(
  "personal_shared_inbound_media_quotas",
  {
    scope: text("scope").$type<PersonalSharedInboundMediaQuotaScope>().notNull(),
    /** `sender`: the resolved account's organization id; `connector`: platform:project:connector account. */
    scope_key: text("scope_key").notNull(),
    /** UTC day bucket (YYYY-MM-DD). */
    day: date("day").notNull(),
    image_count: integer("image_count").notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "personal_shared_inbound_media_quotas_pkey",
      columns: [table.scope, table.scope_key, table.day],
    }),
    scope_check: check(
      "personal_shared_inbound_media_quotas_scope_check",
      sql`${table.scope} IN ('sender', 'connector')`,
    ),
    image_count_check: check(
      "personal_shared_inbound_media_quotas_image_count_check",
      sql`${table.image_count} >= 0`,
    ),
  }),
);

export type PersonalSharedInboundMediaDescription = InferSelectModel<
  typeof personalSharedInboundMediaDescriptions
>;
export type NewPersonalSharedInboundMediaDescription = InferInsertModel<
  typeof personalSharedInboundMediaDescriptions
>;
export type PersonalSharedInboundMediaQuota = InferSelectModel<
  typeof personalSharedInboundMediaQuotas
>;
