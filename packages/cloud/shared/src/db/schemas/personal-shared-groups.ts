/**
 * Durable owner claims, provider-chat bindings, and the per-binding participant
 * identity registry for one canonical Personal Shared agent.
 */
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export type PersonalSharedGroupPlatform = "telegram" | "blooio";
export type PersonalSharedGroupBindingState = "active" | "suspended" | "revoked";
export type PersonalSharedGroupResponsePolicy = "mention_only" | "ambient";

export const personalSharedGroupClaims = pgTable(
  "personal_shared_group_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code_hash: text("code_hash").notNull().unique(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    owner_user_id: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    personal_agent_id: text("personal_agent_id").notNull(),
    platform: text("platform").$type<PersonalSharedGroupPlatform>().notNull(),
    project: text("project").notNull(),
    connector_account_id: text("connector_account_id").notNull(),
    issued_to_platform_user_id: text("issued_to_platform_user_id").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platform_check: check(
      "personal_shared_group_claims_platform_check",
      sql`${table.platform} IN ('telegram', 'blooio')`,
    ),
    expires_idx: index("personal_shared_group_claims_expires_idx").on(table.expires_at),
    owner_idx: index("personal_shared_group_claims_owner_idx").on(
      table.owner_user_id,
      table.platform,
    ),
  }),
);

export const personalSharedGroupBindings = pgTable(
  "personal_shared_group_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    owner_user_id: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    personal_agent_id: text("personal_agent_id").notNull(),
    platform: text("platform").$type<PersonalSharedGroupPlatform>().notNull(),
    project: text("project").notNull(),
    connector_account_id: text("connector_account_id").notNull(),
    provider_chat_id: text("provider_chat_id").notNull(),
    conversation_id: text("conversation_id").notNull(),
    state: text("state").$type<PersonalSharedGroupBindingState>().notNull().default("active"),
    response_policy: text("response_policy")
      .$type<PersonalSharedGroupResponsePolicy>()
      .notNull()
      .default("mention_only"),
    authority_version: bigint("authority_version", { mode: "number" }).notNull().default(1),
    delivery_lease_source_id: text("delivery_lease_source_id"),
    delivery_lease_token: uuid("delivery_lease_token"),
    delivery_lease_expires_at: timestamp("delivery_lease_expires_at", {
      withTimezone: true,
    }),
    delivery_lease_committed_at: timestamp("delivery_lease_committed_at", {
      withTimezone: true,
    }),
    created_by_platform_user_id: text("created_by_platform_user_id").notNull(),
    last_verified_at: timestamp("last_verified_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platform_check: check(
      "personal_shared_group_bindings_platform_check",
      sql`${table.platform} IN ('telegram', 'blooio')`,
    ),
    state_check: check(
      "personal_shared_group_bindings_state_check",
      sql`${table.state} IN ('active', 'suspended', 'revoked')`,
    ),
    policy_check: check(
      "personal_shared_group_bindings_policy_check",
      sql`${table.response_policy} IN ('mention_only', 'ambient')`,
    ),
    provider_chat_unique: uniqueIndex("personal_shared_group_bindings_provider_chat_uidx").on(
      table.platform,
      table.project,
      table.connector_account_id,
      table.provider_chat_id,
    ),
    owner_idx: index("personal_shared_group_bindings_owner_idx").on(
      table.owner_user_id,
      table.state,
    ),
  }),
);

export const personalSharedGroupDeliveryReceipts = pgTable(
  "personal_shared_group_delivery_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    binding_id: uuid("binding_id")
      .notNull()
      .references(() => personalSharedGroupBindings.id, {
        onDelete: "cascade",
      }),
    platform: text("platform").$type<PersonalSharedGroupPlatform>().notNull(),
    project: text("project").notNull(),
    connector_account_id: text("connector_account_id").notNull(),
    provider_chat_id: text("provider_chat_id").notNull(),
    source_message_id: text("source_message_id").notNull(),
    provider_message_id: text("provider_message_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platform_check: check(
      "personal_shared_group_delivery_receipts_platform_check",
      sql`${table.platform} IN ('telegram', 'blooio')`,
    ),
    provider_unique: uniqueIndex("personal_shared_group_delivery_receipts_provider_uidx").on(
      table.platform,
      table.project,
      table.connector_account_id,
      table.provider_chat_id,
      table.provider_message_id,
    ),
    binding_created_idx: index("personal_shared_group_delivery_receipts_binding_created_idx").on(
      table.binding_id,
      table.created_at,
    ),
  }),
);

/**
 * Model-facing identity for the speakers of one bound provider group.
 *
 * The label the model reads is `display_name ?? ordinal`, where `display_name`
 * is a connector-supplied name that survived the resolution rules; the raw
 * connector handle in `platform_user_id` is server-side only and must never be
 * rendered into a prompt or a reply. See 0311 for the full rationale.
 */
export const personalSharedGroupParticipants = pgTable(
  "personal_shared_group_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    binding_id: uuid("binding_id")
      .notNull()
      .references(() => personalSharedGroupBindings.id, { onDelete: "cascade" }),
    /** Raw connector handle (Blooio phone, Telegram numeric id). Never model-facing. */
    platform_user_id: text("platform_user_id").notNull(),
    /** 1-based, assigned in first-seen order within the binding, then stable. */
    ordinal: integer("ordinal").notNull(),
    /** Connector-supplied name that passed the resolution rules, else null. */
    display_name: text("display_name"),
    first_seen_at: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ordinal_check: check(
      "personal_shared_group_participants_ordinal_check",
      sql`${table.ordinal} > 0`,
    ),
    display_name_check: check(
      "personal_shared_group_participants_display_name_check",
      sql`${table.display_name} IS NULL OR (length(${table.display_name}) > 0 AND length(${table.display_name}) <= 128)`,
    ),
    actor_unique: uniqueIndex("personal_shared_group_participants_actor_uidx").on(
      table.binding_id,
      table.platform_user_id,
    ),
    // Two participants speaking at once must not both take ordinal N.
    ordinal_unique: uniqueIndex("personal_shared_group_participants_ordinal_uidx").on(
      table.binding_id,
      table.ordinal,
    ),
  }),
);

export type PersonalSharedGroupClaim = InferSelectModel<typeof personalSharedGroupClaims>;
export type NewPersonalSharedGroupClaim = InferInsertModel<typeof personalSharedGroupClaims>;
export type PersonalSharedGroupBinding = InferSelectModel<typeof personalSharedGroupBindings>;
export type NewPersonalSharedGroupBinding = InferInsertModel<typeof personalSharedGroupBindings>;
export type PersonalSharedGroupDeliveryReceipt = InferSelectModel<
  typeof personalSharedGroupDeliveryReceipts
>;
export type PersonalSharedGroupParticipant = InferSelectModel<
  typeof personalSharedGroupParticipants
>;
export type NewPersonalSharedGroupParticipant = InferInsertModel<
  typeof personalSharedGroupParticipants
>;
