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
/**
 * `all_adults` v1 is an owner-configured quorum of independently authenticated
 * adult principals. It does not claim that the provider exposes a complete or
 * designated adult-membership roster; that audience-attestation work remains
 * a separate policy layer.
 */
export type PersonalSharedGroupConsentMode = "single_owner" | "all_adults";
export type PersonalSharedGroupConsentProvenance = "owner_binding" | "authenticated_dm";
export type PersonalSharedGroupJoinChallengeStage = "authenticate" | "confirm";
export type PersonalSharedGroupDeliveryAttemptState = "committed" | "uncertain" | "reconciled";

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
    consent_mode: text("consent_mode")
      .$type<PersonalSharedGroupConsentMode>()
      .notNull()
      .default("single_owner"),
    required_principal_count: integer("required_principal_count").notNull().default(1),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platform_check: check(
      "personal_shared_group_claims_platform_check",
      sql`${table.platform} IN ('telegram', 'blooio')`,
    ),
    consent_config_check: check(
      "personal_shared_group_claims_consent_config_check",
      sql`(${table.consent_mode} = 'single_owner' AND ${table.required_principal_count} = 1)
        OR (${table.consent_mode} = 'all_adults' AND ${table.required_principal_count} BETWEEN 2 AND 32)`,
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
    consent_mode: text("consent_mode")
      .$type<PersonalSharedGroupConsentMode>()
      .notNull()
      .default("single_owner"),
    required_principal_count: integer("required_principal_count").notNull().default(1),
    consent_version: bigint("consent_version", { mode: "number" }).notNull().default(1),
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
    consent_config_check: check(
      "personal_shared_group_bindings_consent_config_check",
      sql`(${table.consent_mode} = 'single_owner' AND ${table.required_principal_count} = 1)
        OR (${table.consent_mode} = 'all_adults' AND ${table.required_principal_count} BETWEEN 2 AND 32)`,
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

/**
 * Hashed, single-use, actor-bound join handshakes.
 *
 * `provider_thread_id` is the normalized provider sub-thread identity. An
 * empty string means the provider event had no sub-thread, which remains an
 * exact value rather than a wildcard during confirmation.
 */
export const personalSharedGroupJoinChallenges = pgTable(
  "personal_shared_group_join_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code_hash: text("code_hash").notNull().unique(),
    stage: text("stage").$type<PersonalSharedGroupJoinChallengeStage>().notNull(),
    binding_id: uuid("binding_id")
      .notNull()
      .references(() => personalSharedGroupBindings.id, { onDelete: "cascade" }),
    consent_version: bigint("consent_version", { mode: "number" }).notNull(),
    platform: text("platform").$type<PersonalSharedGroupPlatform>().notNull(),
    project: text("project").notNull(),
    connector_account_id: text("connector_account_id").notNull(),
    provider_chat_id: text("provider_chat_id").notNull(),
    provider_thread_id: text("provider_thread_id").notNull().default(""),
    issued_to_platform_user_id: text("issued_to_platform_user_id").notNull(),
    source_message_id: text("source_message_id").notNull(),
    linked_user_id: uuid("linked_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    consumed_by_source_message_id: text("consumed_by_source_message_id"),
    superseded_at: timestamp("superseded_at", { withTimezone: true }),
    superseded_by_source_message_id: text("superseded_by_source_message_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stage_check: check(
      "personal_shared_group_join_challenges_stage_check",
      sql`${table.stage} IN ('authenticate', 'confirm')`,
    ),
    platform_check: check(
      "personal_shared_group_join_challenges_platform_check",
      sql`${table.platform} IN ('telegram', 'blooio')`,
    ),
    linked_user_stage_check: check(
      "personal_shared_group_join_challenges_linked_user_stage_check",
      sql`(${table.stage} = 'authenticate' AND ${table.linked_user_id} IS NULL)
        OR (${table.stage} = 'confirm' AND ${table.linked_user_id} IS NOT NULL)`,
    ),
    superseded_source_check: check(
      "personal_shared_group_join_challenges_superseded_source_check",
      sql`(${table.superseded_at} IS NULL) = (${table.superseded_by_source_message_id} IS NULL)`,
    ),
    binding_stage_idx: index("personal_shared_group_join_challenges_binding_stage_idx").on(
      table.binding_id,
      table.stage,
    ),
    expires_idx: index("personal_shared_group_join_challenges_expires_idx").on(table.expires_at),
    linked_user_idx: index("personal_shared_group_join_challenges_linked_user_idx").on(
      table.linked_user_id,
    ),
    source_unique: uniqueIndex("personal_shared_group_join_challenges_source_uidx").on(
      table.binding_id,
      table.stage,
      table.issued_to_platform_user_id,
      table.source_message_id,
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
    /** Authenticated Eliza account; never model-facing or returned by status APIs. */
    linked_user_id: uuid("linked_user_id").references(() => users.id),
    consented_at: timestamp("consented_at", { withTimezone: true }),
    consent_provenance: text("consent_provenance").$type<PersonalSharedGroupConsentProvenance>(),
    /** Roster/authority tombstone; it does not imply this participant previously consented. */
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
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
    consent_provenance_check: check(
      "personal_shared_group_participants_consent_provenance_check",
      sql`${table.consent_provenance} IS NULL OR ${table.consent_provenance} IN ('owner_binding', 'authenticated_dm')`,
    ),
    consent_shape_check: check(
      "personal_shared_group_participants_consent_shape_check",
      sql`(${table.linked_user_id} IS NULL AND ${table.consented_at} IS NULL AND ${table.consent_provenance} IS NULL)
        OR (${table.linked_user_id} IS NOT NULL AND ${table.consented_at} IS NOT NULL AND ${table.consent_provenance} IS NOT NULL AND ${table.revoked_at} IS NULL)`,
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
    linked_user_unique: uniqueIndex("personal_shared_group_participants_linked_user_uidx").on(
      table.binding_id,
      table.linked_user_id,
    ),
    linked_user_idx: index("personal_shared_group_participants_linked_user_idx").on(
      table.linked_user_id,
    ),
  }),
);

export const personalSharedGroupDeliveryAttempts = pgTable(
  "personal_shared_group_delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    binding_id: uuid("binding_id")
      .notNull()
      .references(() => personalSharedGroupBindings.id, { onDelete: "cascade" }),
    platform: text("platform").$type<PersonalSharedGroupPlatform>().notNull(),
    project: text("project").notNull(),
    connector_account_id: text("connector_account_id").notNull(),
    provider_chat_id: text("provider_chat_id").notNull(),
    source_message_id: text("source_message_id").notNull(),
    lease_token: uuid("lease_token").notNull(),
    state: text("state").$type<PersonalSharedGroupDeliveryAttemptState>().notNull(),
    committed_at: timestamp("committed_at", { withTimezone: true }).notNull(),
    uncertain_at: timestamp("uncertain_at", { withTimezone: true }),
    reconciled_at: timestamp("reconciled_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platform_check: check(
      "personal_shared_group_delivery_attempts_platform_check",
      sql`${table.platform} IN ('telegram', 'blooio')`,
    ),
    state_check: check(
      "personal_shared_group_delivery_attempts_state_check",
      sql`${table.state} IN ('committed', 'uncertain', 'reconciled')`,
    ),
    state_timestamps_check: check(
      "personal_shared_group_delivery_attempts_state_timestamps_check",
      sql`(${table.state} = 'committed' AND ${table.uncertain_at} IS NULL AND ${table.reconciled_at} IS NULL)
        OR (${table.state} = 'uncertain' AND ${table.uncertain_at} IS NOT NULL AND ${table.reconciled_at} IS NULL)
        OR (${table.state} = 'reconciled' AND ${table.reconciled_at} IS NOT NULL)`,
    ),
    binding_source_unique: uniqueIndex(
      "personal_shared_group_delivery_attempts_binding_source_uidx",
    ).on(table.binding_id, table.source_message_id),
    binding_token_unique: uniqueIndex(
      "personal_shared_group_delivery_attempts_binding_token_uidx",
    ).on(table.binding_id, table.lease_token),
    state_committed_idx: index("personal_shared_group_delivery_attempts_state_committed_idx").on(
      table.state,
      table.committed_at,
    ),
  }),
);

export type PersonalSharedGroupClaim = InferSelectModel<typeof personalSharedGroupClaims>;
export type NewPersonalSharedGroupClaim = InferInsertModel<typeof personalSharedGroupClaims>;
export type PersonalSharedGroupBinding = InferSelectModel<typeof personalSharedGroupBindings>;
export type NewPersonalSharedGroupBinding = InferInsertModel<typeof personalSharedGroupBindings>;
export type PersonalSharedGroupJoinChallenge = InferSelectModel<
  typeof personalSharedGroupJoinChallenges
>;
export type NewPersonalSharedGroupJoinChallenge = InferInsertModel<
  typeof personalSharedGroupJoinChallenges
>;
export type PersonalSharedGroupDeliveryReceipt = InferSelectModel<
  typeof personalSharedGroupDeliveryReceipts
>;
export type PersonalSharedGroupParticipant = InferSelectModel<
  typeof personalSharedGroupParticipants
>;
export type NewPersonalSharedGroupParticipant = InferInsertModel<
  typeof personalSharedGroupParticipants
>;
export type PersonalSharedGroupDeliveryAttempt = InferSelectModel<
  typeof personalSharedGroupDeliveryAttempts
>;
