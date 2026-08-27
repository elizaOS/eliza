/** Persists user records and identity transitions through the shared database boundary. */

import { ElizaError } from "@elizaos/core/edge";
import { convergeTodoScopesInTransaction } from "@elizaos/plugin-todos/edge";
import { and, desc, eq, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  sharedRuntimeConversationRoomId,
  sharedRuntimeWorldId,
  sharedTodoStorageScope,
} from "../../lib/services/shared-runtime/shared-runtime-storage-identity";
import type { DbTransaction } from "../client";
import { type SqlExecutor, sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { type Organization, organizations } from "../schemas/organizations";
import {
  type PersonalAccountConvergence,
  personalAccountConvergences,
} from "../schemas/personal-account-convergences";
import { type UserIdentity, userIdentities } from "../schemas/user-identities";
import { type NewUser, type User, users } from "../schemas/users";
import { revokePersonalSharedGroupConsentForUser } from "./personal-shared-group-consent-lifecycle";

const stewardAuthorityIdentity = alias(userIdentities, "steward_authority_identity");
const canonicalStewardIdentity = alias(userIdentities, "canonical_steward_identity");

function userMutationRevokesPersonalSharedConsent(data: Partial<NewUser>): boolean {
  return (
    data.is_active === false ||
    data.deleted_at != null ||
    data.is_anonymous === true ||
    data.phone_verified === false ||
    Object.hasOwn(data, "organization_id") ||
    Object.hasOwn(data, "steward_user_id") ||
    Object.hasOwn(data, "telegram_id") ||
    Object.hasOwn(data, "phone_number")
  );
}

export type { NewUser, User, UserIdentity };

export type IdentityProvider = "steward" | "telegram" | "discord" | "whatsapp" | "phone";
export type MessagingIdentityProvider = Exclude<IdentityProvider, "steward">;

export type LinkMessagingIdentityResult =
  | { status: "linked"; user: User }
  | { status: "user_not_found" }
  | { status: "handle_conflict" };

/**
 * Maps a messaging-platform name as it appears on the wire to the identity
 * provider column family that stores it. `twilio` and `blooio` are two carriers
 * of the same phone identity, so both collapse onto `phone`.
 *
 * An unrecognised platform yields `undefined`, and callers must decide what
 * that means for them: passing it to `resolveIdentity` opts into the
 * shape-sniffing lookup, which is right for a generic resolve endpoint and
 * wrong for anything that would grant authority from the result.
 */
export function providerForPlatform(platform: string | undefined): IdentityProvider | undefined {
  switch (platform) {
    case "telegram":
      return "telegram";
    case "discord":
      return "discord";
    case "whatsapp":
      return "whatsapp";
    case "twilio":
    case "blooio":
      return "phone";
    default:
      return undefined;
  }
}

export type LinkTelegramAndPhoneResult =
  | { status: "linked"; user: User }
  | { status: "user_not_found" }
  | { status: "phone_mismatch"; existingPhone: string };

export interface ResolvedIdentity {
  user: User;
  identity?: UserIdentity;
}

export interface FindOrCreateMessagingPersonalAccountResult {
  user: User;
  organization: Organization;
  isNew: boolean;
}

export type MessagingPersonalAccountParams =
  | {
      platform: "telegram";
      telegramId: string;
      telegramUsername?: string;
      telegramFirstName?: string;
      displayName: string;
      organizationName: string;
      organizationSlug: string;
    }
  | {
      platform: "discord";
      discordId: string;
      discordUsername: string;
      discordGlobalName?: string | null;
      discordAvatarUrl?: string | null;
      displayName: string;
      organizationName: string;
      organizationSlug: string;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

/**
 * User with associated organization data.
 */
export type UserWithOrganization = User & {
  organization: Organization | null;
};

export interface TelegramPhoneIdentityLink {
  telegram_id: string;
  telegram_username?: string;
  telegram_first_name?: string;
  telegram_photo_url?: string;
  phone_number: string;
}

export interface DiscordIdentityLink {
  discord_id: string;
  discord_username: string;
  discord_global_name?: string | null;
  discord_avatar_url?: string | null;
}

export interface TelegramIdentityLink {
  telegram_id: string;
  telegram_username?: string | null;
  telegram_first_name?: string | null;
  telegram_photo_url?: string | null;
}

export interface WhatsAppIdentityLink {
  whatsapp_id: string;
  whatsapp_name?: string | null;
}

export interface FindOrCreatePhonePersonalAccountResult {
  user: User;
  organization: Organization;
  isNew: boolean;
}

/** Non-merging outcome when a verified phone claims its provisional account. */
export type PromotePhonePersonalAccountResult =
  | { status: "promoted"; user: User; organization: Organization }
  | { status: "already_promoted"; user: User; organization: Organization }
  | { status: "not_found" }
  | { status: "phone_owned_by_mature_account" }
  | { status: "steward_subject_owned_by_other_user" }
  | { status: "phone_account_inactive" }
  | { status: "phone_account_deleted" }
  | { status: "identity_projection_conflict" };

class PhonePromotionProjectionConflictError extends Error {}

/** Non-merging outcome when a trusted DM continuation claims its Telegram account. */
export type PromoteTelegramPersonalAccountResult =
  | { status: "promoted"; user: User; organization: Organization }
  | { status: "already_promoted"; user: User; organization: Organization }
  | { status: "not_found" }
  | { status: "telegram_owned_by_mature_account" }
  | { status: "steward_subject_owned_by_other_user" }
  | { status: "telegram_account_inactive" }
  | { status: "telegram_account_deleted" }
  | { status: "identity_projection_conflict" }
  | { status: "continuation_account_mismatch" };

class TelegramPromotionProjectionConflictError extends ElizaError {
  constructor() {
    super("Telegram identity projection changed during account promotion", {
      code: "TELEGRAM_PROMOTION_PROJECTION_CONFLICT",
      severity: "fatal",
    });
  }
}

export interface PhoneTelegramConvergenceProof {
  phoneNumber: string;
  telegramId: string;
  stewardUserId: string;
  expectedTelegramUserId: string;
  expectedTelegramOrganizationId: string;
}

export interface PhoneTelegramConvergencePlan {
  sourceUser: User;
  sourceOrganization: Organization;
  targetUser: User;
  targetOrganization: Organization;
}

export type InspectPhoneTelegramConvergenceResult =
  | { status: "eligible"; plan: PhoneTelegramConvergencePlan }
  | {
      status: "resume_alias";
      receipt: PersonalAccountConvergence;
      user: User;
      organization: Organization;
    }
  | { status: "not_dual_account" }
  | { status: "continuation_account_mismatch" }
  | { status: "identity_projection_conflict" }
  | { status: "steward_subject_owned_by_other_user" }
  | { status: "phone_account_mature" }
  | { status: "telegram_account_mature" }
  | { status: "funded_account" }
  | { status: "agent_bearing_account" };

export interface CommitPhoneTelegramConvergenceParams extends PhoneTelegramConvergenceProof {
  sourceUserId: string;
  sourceOrganizationId: string;
  sourceAgentId: string;
  targetUserId: string;
  targetOrganizationId: string;
  targetAgentId: string;
  token: string;
}

export type CommitPhoneTelegramConvergenceResult =
  | {
      status: "committed" | "already_committed";
      receipt: PersonalAccountConvergence;
      user: User;
      organization: Organization;
    }
  | Exclude<InspectPhoneTelegramConvergenceResult, { status: "eligible" | "resume_alias" }>;

export type FindPendingPhoneTelegramConvergenceResult =
  | {
      status: "resume_alias";
      receipt: PersonalAccountConvergence;
      user: User;
      organization: Organization;
    }
  | { status: "canonical_user"; user: UserWithOrganization }
  | { status: "not_found" }
  | { status: "identity_projection_conflict" };

function convergenceReceiptMatchesCommit(
  receipt: PersonalAccountConvergence,
  params: CommitPhoneTelegramConvergenceParams,
): boolean {
  return (
    receipt.phone_number === params.phoneNumber &&
    receipt.telegram_id === params.telegramId &&
    receipt.steward_user_id === params.stewardUserId &&
    receipt.source_user_id === params.sourceUserId &&
    receipt.source_organization_id === params.sourceOrganizationId &&
    receipt.source_agent_id === params.sourceAgentId &&
    receipt.target_user_id === params.targetUserId &&
    receipt.target_organization_id === params.targetOrganizationId &&
    receipt.target_agent_id === params.targetAgentId
  );
}

function hasOnlyEmptySettings(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function isZeroBalance(value: unknown): boolean {
  const amount = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(amount) && amount === 0;
}

function isPristineProvisionalOrganization(organization: Organization): boolean {
  return (
    organization.is_active &&
    isZeroBalance(organization.credit_balance) &&
    organization.balance_revision === 0 &&
    hasOnlyEmptySettings(organization.settings) &&
    organization.stripe_customer_id === null &&
    organization.billing_email === null &&
    organization.stripe_payment_method_id === null &&
    organization.stripe_default_payment_method === null &&
    organization.auto_top_up_enabled === false &&
    organization.auto_top_up_threshold === null &&
    organization.auto_top_up_amount === null &&
    organization.pay_as_you_go_from_earnings === true &&
    organization.steward_tenant_id === null &&
    organization.steward_tenant_api_key === null
  );
}

function hasNoMatureIdentity(user: User): boolean {
  return (
    user.email === null &&
    user.email_verified === false &&
    user.wallet_address === null &&
    user.wallet_chain_type === null &&
    user.wallet_verified === false &&
    user.avatar === null &&
    user.discord_id === null &&
    user.discord_username === null &&
    user.discord_global_name === null &&
    user.discord_avatar_url === null &&
    user.whatsapp_id === null &&
    user.whatsapp_name === null &&
    user.anonymous_session_id === null &&
    user.expires_at === null &&
    user.nickname === null &&
    user.work_function === null &&
    user.preferences === null &&
    user.email_notifications === true &&
    user.response_notifications === true &&
    user.email_ciphertext === null &&
    user.email_nonce === null &&
    user.email_auth_tag === null &&
    user.email_kms_key_id === null &&
    user.email_kms_key_version === null &&
    user.email_blind_index === null &&
    user.phone_ciphertext === null &&
    user.phone_nonce === null &&
    user.phone_auth_tag === null &&
    user.phone_kms_key_id === null &&
    user.phone_kms_key_version === null &&
    user.phone_blind_index === null &&
    user.wallet_address_ciphertext === null &&
    user.wallet_address_nonce === null &&
    user.wallet_address_auth_tag === null &&
    user.wallet_address_kms_key_id === null &&
    user.wallet_address_kms_key_version === null &&
    user.wallet_address_blind_index === null &&
    user.telegram_id_ciphertext === null &&
    user.telegram_id_nonce === null &&
    user.telegram_id_auth_tag === null &&
    user.telegram_id_kms_key_id === null &&
    user.telegram_id_kms_key_version === null &&
    user.discord_id_ciphertext === null &&
    user.discord_id_nonce === null &&
    user.discord_id_auth_tag === null &&
    user.discord_id_kms_key_id === null &&
    user.discord_id_kms_key_version === null &&
    !user.is_anonymous &&
    user.role === "owner" &&
    user.is_active &&
    user.deleted_at === null
  );
}

function sameOptionalTimestamp(left: Date | null, right: Date | null): boolean {
  return left === null || right === null ? left === right : left.getTime() === right.getTime();
}

function isPhoneProvisionalUser(user: User, phoneNumber: string): boolean {
  return (
    hasNoMatureIdentity(user) &&
    user.steward_user_id === `phone:${phoneNumber}` &&
    user.phone_number === phoneNumber &&
    user.phone_verified === true &&
    user.telegram_id === null &&
    user.telegram_username === null &&
    user.telegram_first_name === null &&
    user.telegram_photo_url === null
  );
}

function isTelegramProvisionalUser(user: User, telegramId: string, stewardUserId: string): boolean {
  return (
    hasNoMatureIdentity(user) &&
    (user.steward_user_id === `telegram:${telegramId}` || user.steward_user_id === stewardUserId) &&
    user.telegram_id === telegramId &&
    user.phone_number === null &&
    user.phone_verified === false
  );
}

function projectionMatchesUser(user: User, identity: UserIdentity): boolean {
  return (
    identity.user_id === user.id &&
    identity.steward_user_id === user.steward_user_id &&
    identity.is_anonymous === user.is_anonymous &&
    identity.anonymous_session_id === user.anonymous_session_id &&
    sameOptionalTimestamp(identity.expires_at, user.expires_at) &&
    identity.telegram_id === user.telegram_id &&
    identity.telegram_username === user.telegram_username &&
    identity.telegram_first_name === user.telegram_first_name &&
    identity.telegram_photo_url === user.telegram_photo_url &&
    identity.phone_number === user.phone_number &&
    identity.phone_verified === user.phone_verified &&
    identity.discord_id === user.discord_id &&
    identity.discord_username === user.discord_username &&
    identity.discord_global_name === user.discord_global_name &&
    identity.discord_avatar_url === user.discord_avatar_url &&
    identity.whatsapp_id === user.whatsapp_id &&
    identity.whatsapp_name === user.whatsapp_name
  );
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

type ProvisionalOwnershipKind = "user" | "organization";

interface ProvisionalOwnershipReference {
  table_schema: string;
  table_name: string;
  column_name: string;
  owner_kind: ProvisionalOwnershipKind;
  native_type: "text" | "uuid";
}

// These columns intentionally retain ownership provenance without a database
// FK. Everything else is discovered from pg_constraint so new FK names such as
// payer_user_id are covered without relying on naming conventions.
const PROVISIONAL_OWNERSHIP_COLUMNS_WITHOUT_FOREIGN_KEYS = [
  ["ad_report_shares", "created_by_user_id", "user"],
  ["alb_priorities", "user_id", "user"],
  ["app_usage_projections", "user_id", "user"],
  ["eliza_room_characters", "user_id", "user"],
  ["invoices", "organization_id", "organization"],
  ["oauth_success_proof_tickets", "organization_id", "organization"],
  ["oauth_success_proof_tickets", "user_id", "user"],
  ["phone_gateway_devices", "organization_id", "organization"],
  ["secret_audit_log", "organization_id", "organization"],
] as const satisfies readonly (readonly [string, string, ProvisionalOwnershipKind])[];

async function findUnexpectedProvisionalAccountState(
  db: SqlExecutor,
  input: {
    sourceUserId: string;
    sourceOrganizationId: string;
    targetUserId: string;
    targetOrganizationId: string;
  },
): Promise<"phone" | "telegram" | undefined> {
  const foreignKeyReferences = await sqlRows<ProvisionalOwnershipReference>(
    db,
    sql`
      SELECT
        source_namespace.nspname AS table_schema,
        source_relation.relname AS table_name,
        source_attribute.attname AS column_name,
        CASE target_relation.relname
          WHEN 'users' THEN 'user'
          WHEN 'organizations' THEN 'organization'
        END AS owner_kind,
        format_type(source_attribute.atttypid, source_attribute.atttypmod) AS native_type
      FROM pg_constraint ownership_fk
      INNER JOIN pg_class source_relation
        ON source_relation.oid = ownership_fk.conrelid
      INNER JOIN pg_namespace source_namespace
        ON source_namespace.oid = source_relation.relnamespace
      INNER JOIN pg_class target_relation
        ON target_relation.oid = ownership_fk.confrelid
      INNER JOIN pg_namespace target_namespace
        ON target_namespace.oid = target_relation.relnamespace
      INNER JOIN pg_attribute source_attribute
        ON source_attribute.attrelid = source_relation.oid
        AND source_attribute.attnum = ownership_fk.conkey[1]
      INNER JOIN pg_attribute target_attribute
        ON target_attribute.attrelid = target_relation.oid
        AND target_attribute.attnum = ownership_fk.confkey[1]
      WHERE ownership_fk.contype = 'f'
        AND array_length(ownership_fk.conkey, 1) = 1
        AND array_length(ownership_fk.confkey, 1) = 1
        AND source_namespace.nspname = 'public'
        AND target_namespace.nspname = 'public'
        AND target_relation.relname IN ('users', 'organizations')
        AND source_relation.relname NOT IN ('users', 'user_identities')
        AND source_attribute.atttypid = target_attribute.atttypid
      ORDER BY source_namespace.nspname, source_relation.relname, source_attribute.attname
    `,
  );

  const registryValues = sql.join(
    PROVISIONAL_OWNERSHIP_COLUMNS_WITHOUT_FOREIGN_KEYS.map(
      ([tableName, columnName, ownerKind]) => sql`(${tableName}, ${columnName}, ${ownerKind})`,
    ),
    sql`, `,
  );
  const registeredReferences = await sqlRows<ProvisionalOwnershipReference>(
    db,
    sql`
      WITH registered(table_name, column_name, owner_kind) AS (
        VALUES ${registryValues}
      )
      SELECT
        namespace.nspname AS table_schema,
        relation.relname AS table_name,
        attribute.attname AS column_name,
        registered.owner_kind,
        format_type(attribute.atttypid, attribute.atttypmod) AS native_type
      FROM registered
      INNER JOIN pg_namespace namespace ON namespace.nspname = 'public'
      INNER JOIN pg_class relation
        ON relation.relnamespace = namespace.oid
        AND relation.relname = registered.table_name
        AND relation.relkind IN ('r', 'p')
      INNER JOIN pg_attribute attribute
        ON attribute.attrelid = relation.oid
        AND attribute.attname = registered.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      WHERE format_type(attribute.atttypid, attribute.atttypmod) IN ('text', 'uuid')
        AND NOT EXISTS (
          SELECT 1
          FROM pg_constraint ownership_fk
          INNER JOIN pg_class target_relation
            ON target_relation.oid = ownership_fk.confrelid
          INNER JOIN pg_namespace target_namespace
            ON target_namespace.oid = target_relation.relnamespace
          WHERE ownership_fk.contype = 'f'
            AND ownership_fk.conrelid = relation.oid
            AND attribute.attnum = ANY(ownership_fk.conkey)
            AND target_namespace.nspname = 'public'
            AND target_relation.relname IN ('users', 'organizations')
        )
      ORDER BY relation.relname, attribute.attname
    `,
  );

  for (const reference of [...foreignKeyReferences, ...registeredReferences]) {
    const qualifiedTable = `${quotePostgresIdentifier(reference.table_schema)}.${quotePostgresIdentifier(reference.table_name)}`;
    const column = quotePostgresIdentifier(reference.column_name);
    const sourceId =
      reference.owner_kind === "organization" ? input.sourceOrganizationId : input.sourceUserId;
    const targetId =
      reference.owner_kind === "organization" ? input.targetOrganizationId : input.targetUserId;
    const sourceValue =
      reference.native_type === "uuid" ? sql`CAST(${sourceId} AS uuid)` : sql`${sourceId}`;
    const targetValue =
      reference.native_type === "uuid" ? sql`CAST(${targetId} AS uuid)` : sql`${targetId}`;
    const [occupied] = await sqlRows<{ source_found: boolean; target_found: boolean }>(
      db,
      sql`
        SELECT
          EXISTS (
            SELECT 1 FROM ${sql.raw(qualifiedTable)}
            WHERE ${sql.raw(column)} = ${sourceValue}
            LIMIT 1
          ) AS source_found,
          EXISTS (
            SELECT 1 FROM ${sql.raw(qualifiedTable)}
            WHERE ${sql.raw(column)} = ${targetValue}
            LIMIT 1
          ) AS target_found
      `,
    );
    if (!occupied) {
      throw new Error(`Provisional resource scan returned no row for ${reference.table_name}`);
    }
    if (occupied.source_found) return "phone";
    if (occupied.target_found) return "telegram";
  }
  return undefined;
}

/**
 * Repository for user database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class UsersRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a user by ID.
   */
  async findById(id: string): Promise<User | undefined> {
    return await this.findUserByPredicate(dbRead, eq(users.id, id));
  }

  /**
   * Finds a user by ID from primary storage.
   *
   * Lifecycle mutations use this reader when the current organization and
   * identity binding determine which durable authorization fences must move.
   */
  async findByIdForWrite(id: string): Promise<User | undefined> {
    return await this.findUserByPredicate(dbWrite, eq(users.id, id));
  }

  /**
   * Finds a user by email address.
   */
  async findByEmail(email: string): Promise<User | undefined> {
    return await this.findUserByPredicate(dbRead, eq(users.email, email));
  }

  /**
   * Finds a user by Steward user ID with organization data.
   * Prefer the identity projection, but fall back to the legacy users column
   * while backfill is still converging.
   */
  async findByStewardIdWithOrganization(
    stewardUserId: string,
  ): Promise<UserWithOrganization | undefined> {
    return this.findByStewardIdWithOrganizationUsingDb(dbRead, stewardUserId);
  }

  /**
   * Finds a user by Steward user ID with organization data from primary.
   * Use after writes when the just-written identity row must be visible.
   */
  async findByStewardIdWithOrganizationForWrite(
    stewardUserId: string,
  ): Promise<UserWithOrganization | undefined> {
    const user = await this.findUserWithOrganizationByStewardId(dbWrite, stewardUserId);

    if (user) {
      return user;
    }

    const identityUserId = await this.findIdentityUserIdByStewardId(dbWrite, stewardUserId);

    if (!identityUserId) {
      return undefined;
    }

    return await this.findUserWithOrganizationById(dbWrite, identityUserId);
  }

  /**
   * Finds a user by ID with organization data.
   */
  async findWithOrganization(userId: string): Promise<UserWithOrganization | undefined> {
    return await this.findUserWithOrganizationById(dbRead, userId);
  }

  /**
   * Finds a user by ID with organization data from primary. Use after identity
   * writes when the just-written canonical row must be visible immediately.
   */
  async findWithOrganizationForWrite(userId: string): Promise<UserWithOrganization | undefined> {
    return await this.findUserWithOrganizationById(dbWrite, userId);
  }

  /**
   * Finds a user by email with organization data.
   */
  async findByEmailWithOrganization(email: string): Promise<UserWithOrganization | undefined> {
    return await this.findUserWithOrganizationByPredicate(dbRead, eq(users.email, email));
  }

  /**
   * Finds a user by wallet address (case-insensitive).
   */
  async findByWalletAddress(walletAddress: string): Promise<User | undefined> {
    return await this.findUserByPredicate(
      dbRead,
      eq(users.wallet_address, walletAddress.toLowerCase()),
    );
  }

  /**
   * Finds a user by Telegram ID (via identity table).
   */
  async findByTelegramId(telegramId: string): Promise<User | undefined> {
    const identity = await dbRead.query.userIdentities.findFirst({
      where: eq(userIdentities.telegram_id, telegramId),
    });
    if (!identity) return undefined;
    return this.findById(identity.user_id);
  }

  /**
   * Finds a user by Telegram ID with organization data (via identity table).
   */
  async findByTelegramIdWithOrganization(
    telegramId: string,
  ): Promise<UserWithOrganization | undefined> {
    const identity = await dbRead.query.userIdentities.findFirst({
      where: eq(userIdentities.telegram_id, telegramId),
    });
    if (!identity) return undefined;
    return this.findWithOrganization(identity.user_id);
  }

  /**
   * Primary-storage Telegram identity read for account-link decisions. A
   * just-created first-message account must be visible before a verified web
   * login decides whether it may bind another Cloud identity.
   */
  async findByTelegramIdWithOrganizationForWrite(
    telegramId: string,
  ): Promise<UserWithOrganization | undefined> {
    const identity = await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.telegram_id, telegramId),
    });
    if (!identity) return undefined;
    return this.findWithOrganizationForWrite(identity.user_id);
  }

  /**
   * Finds a user by phone number (E.164 format, via identity table).
   */
  async findByPhoneNumber(phoneNumber: string): Promise<User | undefined> {
    const identity = await dbRead.query.userIdentities.findFirst({
      where: eq(userIdentities.phone_number, phoneNumber),
    });
    if (!identity) return undefined;
    return this.findById(identity.user_id);
  }

  /**
   * Finds a user by phone number with organization data (via identity table).
   */
  async findByPhoneNumberWithOrganization(
    phoneNumber: string,
  ): Promise<UserWithOrganization | undefined> {
    const identity = await dbRead.query.userIdentities.findFirst({
      where: eq(userIdentities.phone_number, phoneNumber),
    });
    if (!identity) return undefined;
    return this.findWithOrganization(identity.user_id);
  }

  /**
   * Finds a user by Discord ID (via identity table).
   */
  async findByDiscordId(discordId: string): Promise<User | undefined> {
    const identity = await dbRead.query.userIdentities.findFirst({
      where: eq(userIdentities.discord_id, discordId),
    });
    if (!identity) return undefined;
    return this.findById(identity.user_id);
  }

  /**
   * Finds a user by Discord ID with organization data (via identity table).
   */
  async findByDiscordIdWithOrganization(
    discordId: string,
  ): Promise<UserWithOrganization | undefined> {
    const identity = await dbRead.query.userIdentities.findFirst({
      where: eq(userIdentities.discord_id, discordId),
    });
    if (!identity) return undefined;
    return this.findWithOrganization(identity.user_id);
  }

  /**
   * Finds a user by the CANONICAL `users.discord_id` column, bypassing the
   * identity projection. Only for converging legacy canonical-only links
   * (written before {@link refreshDiscordProjectionForWrite} existed) back
   * into the projection — routing and normal lookups must keep resolving via
   * {@link findByDiscordIdWithOrganization}.
   */
  async findByCanonicalDiscordIdWithOrganization(
    discordId: string,
  ): Promise<UserWithOrganization | undefined> {
    return await this.findUserWithOrganizationByPredicate(dbRead, eq(users.discord_id, discordId));
  }

  async listForAdminDashboard(
    limit: number,
  ): Promise<
    Array<
      Pick<
        User,
        | "id"
        | "email"
        | "email_verified"
        | "wallet_address"
        | "wallet_chain_type"
        | "name"
        | "avatar"
        | "organization_id"
        | "role"
        | "is_active"
        | "is_anonymous"
        | "created_at"
        | "updated_at"
      >
    >
  > {
    return dbRead
      .select({
        id: users.id,
        email: users.email,
        email_verified: users.email_verified,
        wallet_address: users.wallet_address,
        wallet_chain_type: users.wallet_chain_type,
        name: users.name,
        avatar: users.avatar,
        organization_id: users.organization_id,
        role: users.role,
        is_active: users.is_active,
        is_anonymous: users.is_anonymous,
        created_at: users.created_at,
        updated_at: users.updated_at,
      })
      .from(users)
      .orderBy(desc(users.created_at))
      .limit(limit);
  }

  /**
   * Finds a user by WhatsApp ID (via identity table).
   */
  async findByWhatsAppId(whatsappId: string): Promise<User | undefined> {
    const identity = await dbRead.query.userIdentities.findFirst({
      where: eq(userIdentities.whatsapp_id, whatsappId),
    });
    if (!identity) return undefined;
    return this.findById(identity.user_id);
  }

  /**
   * Finds a user by WhatsApp ID with organization data (via identity table).
   */
  async findByWhatsAppIdWithOrganization(
    whatsappId: string,
  ): Promise<UserWithOrganization | undefined> {
    const identity = await dbRead.query.userIdentities.findFirst({
      where: eq(userIdentities.whatsapp_id, whatsappId),
    });
    if (!identity) return undefined;
    return this.findWithOrganization(identity.user_id);
  }

  /**
   * Finds a user by wallet address with organization data.
   */
  async findByWalletAddressWithOrganization(
    walletAddress: string,
  ): Promise<UserWithOrganization | undefined> {
    return await this.findUserWithOrganizationByPredicate(
      dbRead,
      eq(users.wallet_address, walletAddress.toLowerCase()),
    );
  }

  /**
   * Finds a user by Solana wallet address (case-sensitive base58, no folding).
   */
  async findBySolanaWalletAddressWithOrganization(
    walletAddress: string,
  ): Promise<UserWithOrganization | undefined> {
    return await this.findUserWithOrganizationByPredicate(
      dbRead,
      eq(users.wallet_address, walletAddress),
    );
  }

  /**
   * Lists all users in an organization.
   */
  async listByOrganization(organizationId: string): Promise<User[]> {
    return await this.listUsersByPredicate(dbRead, eq(users.organization_id, organizationId));
  }

  /**
   * Lists organization membership from the primary database for decisions that
   * immediately gate an identity or authority mutation.
   */
  async listByOrganizationForWrite(organizationId: string): Promise<User[]> {
    return await this.listUsersByPredicate(dbWrite, eq(users.organization_id, organizationId));
  }

  async resolveIdentity(
    identifier: string,
    provider?: IdentityProvider,
  ): Promise<ResolvedIdentity | null> {
    if (provider) {
      const identity = await this.findIdentityByProvider(provider, identifier);
      if (identity) {
        const user = await this.findById(identity.user_id);
        return user ? { user, identity } : null;
      }

      const user = await this.findCanonicalUserByProvider(provider, identifier);
      if (!user) return null;
      const projectedIdentity = await dbRead.query.userIdentities.findFirst({
        where: eq(userIdentities.user_id, user.id),
      });
      return { user, identity: projectedIdentity };
    }

    let user: User | undefined;
    if (UUID_RE.test(identifier)) {
      user = await this.findById(identifier);
    } else if (identifier.includes("@")) {
      user = await this.findByEmail(identifier.toLowerCase());
    } else if (EVM_ADDRESS_RE.test(identifier)) {
      user = await this.findByWalletAddress(identifier);
    }

    if (user) {
      const identity = await dbRead.query.userIdentities.findFirst({
        where: eq(userIdentities.user_id, user.id),
      });
      return { user, identity };
    }

    const identity = await this.findFirstIdentity(identifier);
    if (!identity) return null;

    user = await this.findById(identity.user_id);
    return user ? { user, identity } : null;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Builds the only account-level merge plan this repository permits: a
   * continuation-bound Telegram provisional account plus a separately verified
   * phone provisional account. Both transports are explicit proof inputs from
   * the auth boundary; arbitrary users, organizations, or identity strings are
   * never accepted as merge candidates.
   */
  async inspectPhoneTelegramPersonalAccountConvergence(
    proof: PhoneTelegramConvergenceProof,
  ): Promise<InspectPhoneTelegramConvergenceResult> {
    return dbWrite.transaction(async (tx) => {
      const lockKeys = [
        `phone_personal_account:${proof.phoneNumber}`,
        `steward_subject:${proof.stewardUserId}`,
        `telegram_personal_account:${proof.telegramId}`,
        `user:${proof.expectedTelegramUserId}`,
      ].sort();
      for (const lockKey of lockKeys) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      }

      const [receipt] = await tx
        .select()
        .from(personalAccountConvergences)
        .where(
          and(
            eq(personalAccountConvergences.phone_number, proof.phoneNumber),
            eq(personalAccountConvergences.telegram_id, proof.telegramId),
          ),
        )
        .limit(1);
      if (receipt) {
        if (
          receipt.steward_user_id !== proof.stewardUserId ||
          receipt.target_user_id !== proof.expectedTelegramUserId ||
          receipt.target_organization_id !== proof.expectedTelegramOrganizationId
        ) {
          return { status: "continuation_account_mismatch" };
        }
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, receipt.target_user_id))
          .limit(1);
        const [organization] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, receipt.target_organization_id))
          .limit(1);
        const [identity] = await tx
          .select()
          .from(userIdentities)
          .where(eq(userIdentities.user_id, receipt.target_user_id))
          .limit(1);
        if (
          !user ||
          !organization ||
          !identity ||
          user.organization_id !== organization.id ||
          user.steward_user_id !== proof.stewardUserId ||
          user.telegram_id !== proof.telegramId ||
          user.phone_number !== proof.phoneNumber ||
          user.phone_verified !== true ||
          !projectionMatchesUser(user, identity)
        ) {
          return { status: "identity_projection_conflict" };
        }
        return { status: "resume_alias", receipt, user, organization };
      }

      const [phoneUser] = await tx
        .select()
        .from(users)
        .where(eq(users.phone_number, proof.phoneNumber))
        .limit(1);
      const [phoneIdentity] = await tx
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.phone_number, proof.phoneNumber))
        .limit(1);
      const [telegramUser] = await tx
        .select()
        .from(users)
        .where(eq(users.telegram_id, proof.telegramId))
        .limit(1);
      const [telegramIdentity] = await tx
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.telegram_id, proof.telegramId))
        .limit(1);

      if (!telegramUser || !telegramIdentity) {
        return { status: "continuation_account_mismatch" };
      }
      if (
        telegramUser.id !== proof.expectedTelegramUserId ||
        telegramUser.organization_id !== proof.expectedTelegramOrganizationId
      ) {
        return { status: "continuation_account_mismatch" };
      }
      if (!projectionMatchesUser(telegramUser, telegramIdentity)) {
        return { status: "identity_projection_conflict" };
      }
      if (!phoneUser && !phoneIdentity) {
        return { status: "not_dual_account" };
      }
      if (!phoneUser || !phoneIdentity || !projectionMatchesUser(phoneUser, phoneIdentity)) {
        return { status: "identity_projection_conflict" };
      }
      if (phoneUser.id === telegramUser.id) {
        return { status: "not_dual_account" };
      }

      const [stewardCanonical] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.steward_user_id, proof.stewardUserId))
        .limit(1);
      const [stewardProjection] = await tx
        .select({ userId: userIdentities.user_id })
        .from(userIdentities)
        .where(eq(userIdentities.steward_user_id, proof.stewardUserId))
        .limit(1);
      if (
        (stewardCanonical && stewardCanonical.id !== telegramUser.id) ||
        (stewardProjection && stewardProjection.userId !== telegramUser.id)
      ) {
        return { status: "steward_subject_owned_by_other_user" };
      }

      if (!isPhoneProvisionalUser(phoneUser, proof.phoneNumber)) {
        return { status: "phone_account_mature" };
      }
      if (!isTelegramProvisionalUser(telegramUser, proof.telegramId, proof.stewardUserId)) {
        return { status: "telegram_account_mature" };
      }
      if (!phoneUser.organization_id || !telegramUser.organization_id) {
        return { status: "identity_projection_conflict" };
      }

      const [phoneOrganization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, phoneUser.organization_id))
        .limit(1);
      const [telegramOrganization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, telegramUser.organization_id))
        .limit(1);
      if (!phoneOrganization || !telegramOrganization) {
        return { status: "identity_projection_conflict" };
      }
      if (phoneOrganization.id === telegramOrganization.id) {
        return { status: "identity_projection_conflict" };
      }
      if (!isPristineProvisionalOrganization(phoneOrganization)) {
        return { status: "phone_account_mature" };
      }
      if (!isPristineProvisionalOrganization(telegramOrganization)) {
        return { status: "telegram_account_mature" };
      }
      const organizationMembers = await tx
        .select({ id: users.id, organizationId: users.organization_id })
        .from(users)
        .where(
          or(
            eq(users.organization_id, phoneOrganization.id),
            eq(users.organization_id, telegramOrganization.id),
          ),
        );
      if (
        organizationMembers.some(
          (member) => member.organizationId === phoneOrganization.id && member.id !== phoneUser.id,
        )
      ) {
        return { status: "phone_account_mature" };
      }
      if (
        organizationMembers.some(
          (member) =>
            member.organizationId === telegramOrganization.id && member.id !== telegramUser.id,
        )
      ) {
        return { status: "telegram_account_mature" };
      }

      const [resources] = await sqlRows<{
        phone_agents: boolean;
        telegram_agents: boolean;
        phone_funding: boolean;
        telegram_funding: boolean;
        phone_mature: boolean;
        telegram_mature: boolean;
      }>(
        tx,
        sql`
          SELECT
            EXISTS (
              SELECT 1 FROM agent_sandboxes
              WHERE organization_id = ${phoneOrganization.id}
                AND pool_status IS NULL AND deleted_at IS NULL
            ) OR EXISTS (
              SELECT 1 FROM user_characters
              WHERE organization_id = ${phoneOrganization.id}
            ) AS phone_agents,
            EXISTS (
              SELECT 1 FROM agent_sandboxes
              WHERE organization_id = ${telegramOrganization.id}
                AND pool_status IS NULL AND deleted_at IS NULL
            ) OR EXISTS (
              SELECT 1 FROM user_characters
              WHERE organization_id = ${telegramOrganization.id}
            ) AS telegram_agents,
            EXISTS (
              SELECT 1 FROM credit_transactions
              WHERE organization_id = ${phoneOrganization.id}
            ) AS phone_funding,
            EXISTS (
              SELECT 1 FROM credit_transactions
              WHERE organization_id = ${telegramOrganization.id}
            ) AS telegram_funding,
            EXISTS (
              SELECT 1 FROM api_keys WHERE organization_id = ${phoneOrganization.id}
            ) OR EXISTS (
              SELECT 1 FROM conversations WHERE organization_id = ${phoneOrganization.id}
            ) AS phone_mature,
            EXISTS (
              SELECT 1 FROM api_keys WHERE organization_id = ${telegramOrganization.id}
            ) OR EXISTS (
              SELECT 1 FROM conversations WHERE organization_id = ${telegramOrganization.id}
            ) AS telegram_mature
        `,
      );
      if (!resources) {
        throw new Error("Provisional account resource guard returned no row");
      }
      if (resources.phone_funding || resources.telegram_funding) {
        return { status: "funded_account" };
      }
      if (resources.phone_agents || resources.telegram_agents) {
        return { status: "agent_bearing_account" };
      }
      if (resources.phone_mature) return { status: "phone_account_mature" };
      if (resources.telegram_mature) return { status: "telegram_account_mature" };

      const unexpectedState = await findUnexpectedProvisionalAccountState(tx, {
        sourceUserId: phoneUser.id,
        sourceOrganizationId: phoneOrganization.id,
        targetUserId: telegramUser.id,
        targetOrganizationId: telegramOrganization.id,
      });
      if (unexpectedState === "phone") return { status: "phone_account_mature" };
      if (unexpectedState === "telegram") return { status: "telegram_account_mature" };

      return {
        status: "eligible",
        plan: {
          sourceUser: phoneUser,
          sourceOrganization: phoneOrganization,
          targetUser: telegramUser,
          targetOrganization: telegramOrganization,
        },
      };
    });
  }

  /**
   * Commits a previously history-sealed convergence plan. Identity and Todo
   * state move in one transaction; every eligibility predicate is checked
   * again under deterministic locks so intervening drift fails closed.
   */
  async commitPhoneTelegramPersonalAccountConvergence(
    params: CommitPhoneTelegramConvergenceParams,
  ): Promise<CommitPhoneTelegramConvergenceResult> {
    const inspection = await this.inspectPhoneTelegramPersonalAccountConvergence(params);
    if (inspection.status === "resume_alias") {
      if (!convergenceReceiptMatchesCommit(inspection.receipt, params)) {
        return { status: "continuation_account_mismatch" };
      }
      return {
        status: "already_committed",
        receipt: inspection.receipt,
        user: inspection.user,
        organization: inspection.organization,
      };
    }
    if (inspection.status !== "eligible") return inspection;
    if (
      inspection.plan.sourceUser.id !== params.sourceUserId ||
      inspection.plan.sourceOrganization.id !== params.sourceOrganizationId ||
      inspection.plan.targetUser.id !== params.targetUserId ||
      inspection.plan.targetOrganization.id !== params.targetOrganizationId
    ) {
      return { status: "continuation_account_mismatch" };
    }

    return dbWrite.transaction(async (tx) => {
      const lockKeys = [
        `organization:${params.sourceOrganizationId}`,
        `organization:${params.targetOrganizationId}`,
        `phone_personal_account:${params.phoneNumber}`,
        `steward_subject:${params.stewardUserId}`,
        `telegram_personal_account:${params.telegramId}`,
        `user:${params.sourceUserId}`,
        `user:${params.targetUserId}`,
      ].sort();
      for (const lockKey of lockKeys) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      }

      const [existingReceipt] = await tx
        .select()
        .from(personalAccountConvergences)
        .where(eq(personalAccountConvergences.token, params.token))
        .limit(1);
      if (existingReceipt) {
        if (!convergenceReceiptMatchesCommit(existingReceipt, params)) {
          return { status: "continuation_account_mismatch" };
        }
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, existingReceipt.target_user_id))
          .limit(1);
        const [organization] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, existingReceipt.target_organization_id))
          .limit(1);
        if (!user || !organization) return { status: "identity_projection_conflict" };
        return { status: "already_committed", receipt: existingReceipt, user, organization };
      }

      const [sourceUser] = await tx
        .select()
        .from(users)
        .where(eq(users.id, params.sourceUserId))
        .for("update")
        .limit(1);
      const [targetUser] = await tx
        .select()
        .from(users)
        .where(eq(users.id, params.targetUserId))
        .for("update")
        .limit(1);
      const [sourceIdentity] = await tx
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.user_id, params.sourceUserId))
        .for("update")
        .limit(1);
      const [targetIdentity] = await tx
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.user_id, params.targetUserId))
        .for("update")
        .limit(1);
      const [sourceOrganization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, params.sourceOrganizationId))
        .for("update")
        .limit(1);
      const [targetOrganization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, params.targetOrganizationId))
        .for("update")
        .limit(1);

      if (
        !sourceUser ||
        !targetUser ||
        !sourceIdentity ||
        !targetIdentity ||
        !sourceOrganization ||
        !targetOrganization ||
        sourceUser.organization_id !== sourceOrganization.id ||
        targetUser.organization_id !== targetOrganization.id ||
        targetUser.id !== params.expectedTelegramUserId ||
        targetOrganization.id !== params.expectedTelegramOrganizationId ||
        sourceOrganization.id === targetOrganization.id
      ) {
        return { status: "continuation_account_mismatch" };
      }
      if (
        !projectionMatchesUser(sourceUser, sourceIdentity) ||
        !projectionMatchesUser(targetUser, targetIdentity)
      ) {
        return { status: "identity_projection_conflict" };
      }
      if (!isPhoneProvisionalUser(sourceUser, params.phoneNumber)) {
        return { status: "phone_account_mature" };
      }
      if (!isTelegramProvisionalUser(targetUser, params.telegramId, params.stewardUserId)) {
        return { status: "telegram_account_mature" };
      }
      if (!isPristineProvisionalOrganization(sourceOrganization)) {
        return { status: "phone_account_mature" };
      }
      if (!isPristineProvisionalOrganization(targetOrganization)) {
        return { status: "telegram_account_mature" };
      }
      const organizationMembers = await tx
        .select({ id: users.id, organizationId: users.organization_id })
        .from(users)
        .where(
          or(
            eq(users.organization_id, sourceOrganization.id),
            eq(users.organization_id, targetOrganization.id),
          ),
        );
      if (
        organizationMembers.some(
          (member) =>
            member.organizationId === sourceOrganization.id && member.id !== sourceUser.id,
        )
      ) {
        return { status: "phone_account_mature" };
      }
      if (
        organizationMembers.some(
          (member) =>
            member.organizationId === targetOrganization.id && member.id !== targetUser.id,
        )
      ) {
        return { status: "telegram_account_mature" };
      }

      const [resources] = await sqlRows<{
        has_agents: boolean;
        has_funding: boolean;
        has_mature_state: boolean;
      }>(
        tx,
        sql`
          SELECT
            EXISTS (
              SELECT 1 FROM agent_sandboxes
              WHERE organization_id IN (${sourceOrganization.id}, ${targetOrganization.id})
                AND pool_status IS NULL AND deleted_at IS NULL
            ) OR EXISTS (
              SELECT 1 FROM user_characters
              WHERE organization_id IN (${sourceOrganization.id}, ${targetOrganization.id})
            ) AS has_agents,
            EXISTS (
              SELECT 1 FROM credit_transactions
              WHERE organization_id IN (${sourceOrganization.id}, ${targetOrganization.id})
            ) AS has_funding,
            EXISTS (
              SELECT 1 FROM api_keys
              WHERE organization_id IN (${sourceOrganization.id}, ${targetOrganization.id})
            ) OR EXISTS (
              SELECT 1 FROM conversations
              WHERE organization_id IN (${sourceOrganization.id}, ${targetOrganization.id})
            ) AS has_mature_state
        `,
      );
      if (!resources) throw new Error("Provisional account resource guard returned no row");
      if (resources.has_funding) return { status: "funded_account" };
      if (resources.has_agents) return { status: "agent_bearing_account" };
      if (resources.has_mature_state) return { status: "phone_account_mature" };

      const unexpectedState = await findUnexpectedProvisionalAccountState(tx, {
        sourceUserId: sourceUser.id,
        sourceOrganizationId: sourceOrganization.id,
        targetUserId: targetUser.id,
        targetOrganizationId: targetOrganization.id,
      });
      if (unexpectedState === "phone") return { status: "phone_account_mature" };
      if (unexpectedState === "telegram") return { status: "telegram_account_mature" };

      const [sourceSchedulingState] = await sqlRows<{ has_state: boolean }>(
        tx,
        sql`
          SELECT
            EXISTS (
              SELECT 1
                FROM app_scheduling.life_scheduled_tasks
               WHERE agent_id = ${params.sourceAgentId}
            ) OR EXISTS (
              SELECT 1
                FROM app_scheduling.life_scheduled_task_log
               WHERE agent_id = ${params.sourceAgentId}
            ) AS has_state
        `,
      );
      if (!sourceSchedulingState) {
        throw new Error("Provisional scheduling-state guard returned no row");
      }
      // Phone transports do not expose the Shared reminder plugin. Any source
      // scheduler state therefore represents an unsupported ownership shape;
      // deleting the source account would orphan it, so convergence stops.
      if (sourceSchedulingState.has_state) return { status: "phone_account_mature" };

      const [canonicalStewardOwner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.steward_user_id, params.stewardUserId))
        .limit(1);
      const [projectedStewardOwner] = await tx
        .select({ userId: userIdentities.user_id })
        .from(userIdentities)
        .where(eq(userIdentities.steward_user_id, params.stewardUserId))
        .limit(1);
      if (
        (canonicalStewardOwner && canonicalStewardOwner.id !== targetUser.id) ||
        (projectedStewardOwner && projectedStewardOwner.userId !== targetUser.id)
      ) {
        return { status: "steward_subject_owned_by_other_user" };
      }

      const sourceTodoScope = sharedTodoStorageScope({
        sourceAgentId: params.sourceAgentId,
        ownerId: sourceUser.id,
      });
      const targetTodoScope = sharedTodoStorageScope({
        sourceAgentId: params.targetAgentId,
        ownerId: targetUser.id,
      });
      const sourceRoomId = sharedRuntimeConversationRoomId(params.sourceAgentId);
      const targetRoomId = sharedRuntimeConversationRoomId(params.targetAgentId);
      const sourceWorldId = sharedRuntimeWorldId(params.sourceAgentId);
      const targetWorldId = sharedRuntimeWorldId(params.targetAgentId);
      await convergeTodoScopesInTransaction(tx, {
        sourceScope: sourceTodoScope,
        targetScope: targetTodoScope,
        roomIdMap: { [sourceRoomId]: targetRoomId },
        worldIdMap: { [sourceWorldId]: targetWorldId },
      });

      const deletedProjection = await tx
        .delete(userIdentities)
        .where(eq(userIdentities.user_id, sourceUser.id))
        .returning({ id: userIdentities.id });
      if (deletedProjection.length !== 1) {
        throw new Error("Phone provisional identity disappeared during convergence");
      }
      const deletedUser = await tx
        .delete(users)
        .where(eq(users.id, sourceUser.id))
        .returning({ id: users.id });
      if (deletedUser.length !== 1) {
        throw new Error("Phone provisional user disappeared during convergence");
      }

      const updatedAt = new Date();
      const [mergedUser] = await tx
        .update(users)
        .set({
          steward_user_id: params.stewardUserId,
          phone_number: params.phoneNumber,
          phone_verified: true,
          updated_at: updatedAt,
        })
        .where(
          and(
            eq(users.id, targetUser.id),
            eq(users.organization_id, targetOrganization.id),
            eq(users.telegram_id, params.telegramId),
          ),
        )
        .returning();
      if (!mergedUser) throw new Error("Telegram target changed during convergence");

      const [mergedIdentity] = await tx
        .update(userIdentities)
        .set({
          steward_user_id: params.stewardUserId,
          phone_number: params.phoneNumber,
          phone_verified: true,
          updated_at: updatedAt,
        })
        .where(
          and(
            eq(userIdentities.user_id, targetUser.id),
            eq(userIdentities.telegram_id, params.telegramId),
          ),
        )
        .returning();
      if (!mergedIdentity || !projectionMatchesUser(mergedUser, mergedIdentity)) {
        throw new Error("Merged personal identity projection did not converge");
      }

      const [receipt] = await tx
        .insert(personalAccountConvergences)
        .values({
          token: params.token,
          source_user_id: sourceUser.id,
          source_organization_id: sourceOrganization.id,
          source_agent_id: params.sourceAgentId,
          target_user_id: mergedUser.id,
          target_organization_id: targetOrganization.id,
          target_agent_id: params.targetAgentId,
          phone_number: params.phoneNumber,
          telegram_id: params.telegramId,
          steward_user_id: params.stewardUserId,
          status: "pending_alias",
          updated_at: updatedAt,
        })
        .returning();
      if (!receipt) throw new Error("Personal account convergence receipt was not persisted");

      const deletedOrganization = await tx
        .delete(organizations)
        .where(eq(organizations.id, sourceOrganization.id))
        .returning({ id: organizations.id });
      if (deletedOrganization.length !== 1) {
        throw new Error("Phone provisional organization disappeared during convergence");
      }

      return {
        status: "committed",
        receipt,
        user: mergedUser,
        organization: targetOrganization,
      };
    });
  }

  /**
   * Finds recovery authority from the independently verified Steward subject.
   * Its pending receipt must still point at that subject's canonical projected
   * owner; a newly asserted phone, when present, is an additional exact-match
   * constraint rather than required retry authority.
   */
  async findPendingPhoneTelegramPersonalAccountConvergence(input: {
    phoneNumber?: string;
    stewardUserId: string;
  }): Promise<FindPendingPhoneTelegramConvergenceResult> {
    const stewardSubject = dbWrite.$with("steward_subject").as((qb) =>
      qb
        .select({
          stewardUserId: sql<string>`${input.stewardUserId}`.as("requested_steward_subject_id"),
        })
        .from(sql`(select 1)`),
    );
    const [inspection] = await dbWrite
      .with(stewardSubject)
      .select({
        canonicalUser: users,
        organization: organizations,
        authorityUserId: stewardAuthorityIdentity.user_id,
        canonicalIdentityStewardUserId: canonicalStewardIdentity.steward_user_id,
        pendingReceiptToken: personalAccountConvergences.token,
      })
      .from(stewardSubject)
      .leftJoin(users, eq(users.steward_user_id, stewardSubject.stewardUserId))
      .leftJoin(
        stewardAuthorityIdentity,
        eq(stewardAuthorityIdentity.steward_user_id, stewardSubject.stewardUserId),
      )
      .leftJoin(canonicalStewardIdentity, eq(canonicalStewardIdentity.user_id, users.id))
      .leftJoin(organizations, eq(organizations.id, users.organization_id))
      .leftJoin(
        personalAccountConvergences,
        and(
          eq(personalAccountConvergences.target_user_id, users.id),
          eq(personalAccountConvergences.steward_user_id, stewardSubject.stewardUserId),
          eq(personalAccountConvergences.status, "pending_alias"),
        ),
      )
      .limit(1);

    // The projection remains session authority while legacy canonical-only rows
    // converge. Accept the repairable canonical-only case, but never choose one
    // owner while the same Steward subject projects to another.
    if (!inspection?.canonicalUser) {
      return inspection?.authorityUserId
        ? { status: "identity_projection_conflict" }
        : { status: "not_found" };
    }
    if (
      (inspection.authorityUserId && inspection.authorityUserId !== inspection.canonicalUser.id) ||
      (inspection.canonicalIdentityStewardUserId &&
        inspection.canonicalIdentityStewardUserId !== input.stewardUserId)
    ) {
      return { status: "identity_projection_conflict" };
    }
    if (!inspection.pendingReceiptToken) {
      return {
        status: "canonical_user",
        user: { ...inspection.canonicalUser, organization: inspection.organization },
      };
    }

    return await this.validatePendingPhoneTelegramPersonalAccountConvergence(input);
  }

  /**
   * Revalidates a detected pending receipt within the original primary
   * transaction so rare alias recovery retains its existing snapshot checks.
   */
  private async validatePendingPhoneTelegramPersonalAccountConvergence(input: {
    phoneNumber?: string;
    stewardUserId: string;
  }): Promise<FindPendingPhoneTelegramConvergenceResult> {
    return dbWrite.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.steward_user_id, input.stewardUserId))
        .limit(1);
      if (!user) return { status: "not_found" };

      const [receipt] = await tx
        .select()
        .from(personalAccountConvergences)
        .where(
          and(
            eq(personalAccountConvergences.target_user_id, user.id),
            eq(personalAccountConvergences.steward_user_id, input.stewardUserId),
            eq(personalAccountConvergences.status, "pending_alias"),
          ),
        )
        .limit(1);
      if (!receipt) return { status: "not_found" };
      if (input.phoneNumber && receipt.phone_number !== input.phoneNumber) {
        return { status: "identity_projection_conflict" };
      }

      const [organization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, receipt.target_organization_id))
        .limit(1);
      const [identity] = await tx
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.user_id, receipt.target_user_id))
        .limit(1);
      if (
        !organization ||
        !identity ||
        user.organization_id !== organization.id ||
        user.steward_user_id !== input.stewardUserId ||
        user.phone_number !== receipt.phone_number ||
        user.phone_verified !== true ||
        user.telegram_id !== receipt.telegram_id ||
        !projectionMatchesUser(user, identity)
      ) {
        return { status: "identity_projection_conflict" };
      }

      return { status: "resume_alias", receipt, user, organization };
    });
  }

  /** Marks the exact history alias receipt complete; retries are idempotent. */
  async markPhoneTelegramPersonalAccountAliasComplete(
    token: string,
  ): Promise<PersonalAccountConvergence | undefined> {
    const [receipt] = await dbWrite
      .update(personalAccountConvergences)
      .set({ status: "complete", updated_at: new Date() })
      .where(eq(personalAccountConvergences.token, token))
      .returning();
    return receipt;
  }

  /** Prevents Dedicated from snapshotting the target before its source history lands. */
  async hasPendingPhoneTelegramPersonalAccountConvergenceTarget(input: {
    targetUserId: string;
    targetOrganizationId: string;
    targetAgentId: string;
  }): Promise<boolean> {
    const [receipt] = await dbWrite
      .select({ token: personalAccountConvergences.token })
      .from(personalAccountConvergences)
      .where(
        and(
          eq(personalAccountConvergences.target_user_id, input.targetUserId),
          eq(personalAccountConvergences.target_organization_id, input.targetOrganizationId),
          eq(personalAccountConvergences.target_agent_id, input.targetAgentId),
          eq(personalAccountConvergences.status, "pending_alias"),
        ),
      )
      .limit(1);
    return Boolean(receipt);
  }

  /**
   * Creates or reuses the personal account proven by a trusted inbound phone
   * transport. The phone-scoped transaction lock makes concurrent first texts
   * converge before any organization is inserted, so retries cannot leak
   * orphan tenants or split one phone across multiple accounts.
   */
  async findOrCreatePhonePersonalAccount(params: {
    phoneNumber: string;
    displayName: string;
    organizationName: string;
    organizationSlug: string;
  }): Promise<FindOrCreatePhonePersonalAccountResult> {
    return dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`phone_personal_account:${params.phoneNumber}`}))`,
      );

      const [projected] = await tx
        .select({ userId: userIdentities.user_id })
        .from(userIdentities)
        .where(eq(userIdentities.phone_number, params.phoneNumber))
        .limit(1);
      const [canonical] = await tx
        .select()
        .from(users)
        .where(eq(users.phone_number, params.phoneNumber))
        .limit(1);

      if (projected && canonical && projected.userId !== canonical.id) {
        throw new ElizaError("Phone identity projection disagrees with its canonical owner", {
          code: "PHONE_PERSONAL_ACCOUNT_IDENTITY_CONFLICT",
          context: { canonicalUserId: canonical.id, projectedUserId: projected.userId },
          severity: "fatal",
        });
      }

      const [existingUser] = projected
        ? await tx.select().from(users).where(eq(users.id, projected.userId)).limit(1)
        : canonical
          ? [canonical]
          : [];

      if (projected && !existingUser) {
        throw new ElizaError("Phone identity projection has no canonical owner", {
          code: "PHONE_PERSONAL_ACCOUNT_IDENTITY_CONFLICT",
          context: { projectedUserId: projected.userId },
          severity: "fatal",
        });
      }

      if (existingUser) {
        if (existingUser.deleted_at) {
          throw new ElizaError("Deleted phone personal account cannot receive inbound messages", {
            code: "PHONE_PERSONAL_ACCOUNT_DELETED",
            context: { userId: existingUser.id },
            severity: "fatal",
          });
        }
        if (!existingUser.is_active) {
          throw new ElizaError("Inactive phone personal account cannot receive inbound messages", {
            code: "PHONE_PERSONAL_ACCOUNT_INACTIVE",
            context: { userId: existingUser.id },
            severity: "fatal",
          });
        }
        if (!existingUser.organization_id) {
          throw new Error(`Phone account ${existingUser.id} has no organization`);
        }
        const [organization] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, existingUser.organization_id))
          .limit(1);
        if (!organization) {
          throw new Error(`Phone account ${existingUser.id} organization is missing`);
        }
        if (!organization.is_active) {
          throw new ElizaError(
            "Phone personal account organization cannot receive inbound messages",
            {
              code: "PHONE_PERSONAL_ACCOUNT_ORGANIZATION_INACTIVE",
              context: { userId: existingUser.id, organizationId: organization.id },
              severity: "fatal",
            },
          );
        }

        const now = new Date();
        const [verifiedUser] = existingUser.phone_verified
          ? [existingUser]
          : await tx
              .update(users)
              .set({ phone_verified: true, updated_at: now })
              .where(eq(users.id, existingUser.id))
              .returning();
        if (!verifiedUser) {
          throw new Error(`Phone account ${existingUser.id} disappeared during verification`);
        }
        await tx
          .insert(userIdentities)
          .values({
            user_id: verifiedUser.id,
            steward_user_id: verifiedUser.steward_user_id,
            is_anonymous: verifiedUser.is_anonymous,
            anonymous_session_id: verifiedUser.anonymous_session_id,
            expires_at: verifiedUser.expires_at,
            phone_number: params.phoneNumber,
            phone_verified: true,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: userIdentities.user_id,
            set: {
              phone_number: params.phoneNumber,
              phone_verified: true,
              updated_at: now,
            },
          });
        return { user: verifiedUser, organization, isNew: false };
      }

      const [organization] = await tx
        .insert(organizations)
        .values({
          name: params.organizationName,
          slug: params.organizationSlug,
          credit_balance: "0.00",
        })
        .returning();
      if (!organization) {
        throw new Error("Failed to create phone account organization");
      }

      const [user] = await tx
        .insert(users)
        .values({
          steward_user_id: `phone:${params.phoneNumber}`,
          phone_number: params.phoneNumber,
          phone_verified: true,
          name: params.displayName,
          is_anonymous: false,
          organization_id: organization.id,
          role: "owner",
          is_active: true,
        })
        .returning();
      if (!user) {
        throw new Error("Failed to create phone account user");
      }
      await tx.insert(userIdentities).values({
        user_id: user.id,
        steward_user_id: user.steward_user_id,
        is_anonymous: false,
        phone_number: params.phoneNumber,
        phone_verified: true,
      });
      return { user, organization, isNew: true };
    });
  }

  /**
   * Claims the exact personal account created for a trusted inbound phone by
   * replacing its temporary `phone:<E.164>` Steward subject. No mature-account
   * merge is attempted: canonical and projected identities must agree, and a
   * projection failure rolls the canonical update back.
   */
  async promotePhonePersonalAccountToSteward(params: {
    phoneNumber: string;
    stewardUserId: string;
  }): Promise<PromotePhonePersonalAccountResult> {
    try {
      return await dbWrite.transaction(async (tx) => {
        const lockKeys = [
          `phone_personal_account:${params.phoneNumber}`,
          `steward_subject:${params.stewardUserId}`,
        ].sort();
        for (const lockKey of lockKeys) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
        }

        const temporaryStewardUserId = `phone:${params.phoneNumber}`;
        const [canonicalPhoneOwner] = await tx
          .select()
          .from(users)
          .where(eq(users.phone_number, params.phoneNumber))
          .limit(1);
        const [projectedPhoneOwner] = await tx
          .select()
          .from(userIdentities)
          .where(eq(userIdentities.phone_number, params.phoneNumber))
          .limit(1);
        const [canonicalStewardOwner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.steward_user_id, params.stewardUserId))
          .limit(1);
        const [projectedStewardOwner] = await tx
          .select({ userId: userIdentities.user_id })
          .from(userIdentities)
          .where(eq(userIdentities.steward_user_id, params.stewardUserId))
          .limit(1);

        if (!canonicalPhoneOwner) {
          if (canonicalStewardOwner || projectedStewardOwner) {
            return { status: "steward_subject_owned_by_other_user" };
          }
          return projectedPhoneOwner
            ? { status: "identity_projection_conflict" }
            : { status: "not_found" };
        }

        if (
          (canonicalStewardOwner && canonicalStewardOwner.id !== canonicalPhoneOwner.id) ||
          (projectedStewardOwner && projectedStewardOwner.userId !== canonicalPhoneOwner.id)
        ) {
          return { status: "steward_subject_owned_by_other_user" };
        }
        if (canonicalPhoneOwner.deleted_at) {
          return { status: "phone_account_deleted" };
        }
        if (!canonicalPhoneOwner.is_active) {
          return { status: "phone_account_inactive" };
        }
        if (
          canonicalPhoneOwner.phone_verified !== true ||
          canonicalPhoneOwner.is_anonymous ||
          canonicalPhoneOwner.role !== "owner" ||
          !canonicalPhoneOwner.organization_id ||
          (canonicalPhoneOwner.steward_user_id !== temporaryStewardUserId &&
            canonicalPhoneOwner.steward_user_id !== params.stewardUserId)
        ) {
          return { status: "phone_owned_by_mature_account" };
        }

        const [organization] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, canonicalPhoneOwner.organization_id))
          .limit(1);
        if (!organization) {
          return { status: "phone_owned_by_mature_account" };
        }
        if (!organization.is_active) {
          return { status: "phone_account_inactive" };
        }
        if (
          !projectedPhoneOwner ||
          projectedPhoneOwner.user_id !== canonicalPhoneOwner.id ||
          projectedPhoneOwner.phone_verified !== true ||
          projectedPhoneOwner.is_anonymous
        ) {
          return { status: "identity_projection_conflict" };
        }

        if (canonicalPhoneOwner.steward_user_id === params.stewardUserId) {
          return projectedPhoneOwner.steward_user_id === params.stewardUserId
            ? { status: "already_promoted", user: canonicalPhoneOwner, organization }
            : { status: "identity_projection_conflict" };
        }

        const updatedAt = new Date();
        const [promotedUser] = await tx
          .update(users)
          .set({ steward_user_id: params.stewardUserId, updated_at: updatedAt })
          .where(
            and(
              eq(users.id, canonicalPhoneOwner.id),
              eq(users.steward_user_id, temporaryStewardUserId),
              eq(users.phone_number, params.phoneNumber),
              eq(users.phone_verified, true),
              eq(users.is_anonymous, false),
              eq(users.role, "owner"),
              eq(users.is_active, true),
              isNull(users.deleted_at),
            ),
          )
          .returning();
        if (!promotedUser) {
          return { status: "phone_owned_by_mature_account" };
        }

        const [promotedIdentity] = await tx
          .update(userIdentities)
          .set({ steward_user_id: params.stewardUserId, updated_at: updatedAt })
          .where(
            and(
              eq(userIdentities.user_id, promotedUser.id),
              eq(userIdentities.steward_user_id, temporaryStewardUserId),
              eq(userIdentities.phone_number, params.phoneNumber),
              eq(userIdentities.phone_verified, true),
              eq(userIdentities.is_anonymous, false),
            ),
          )
          .returning({ id: userIdentities.id });
        if (!promotedIdentity) {
          throw new PhonePromotionProjectionConflictError();
        }

        return { status: "promoted", user: promotedUser, organization };
      });
    } catch (error) {
      // error-policy:J1 The repository maps its private rollback sentinel to a typed sync result.
      if (error instanceof PhonePromotionProjectionConflictError) {
        return { status: "identity_projection_conflict" };
      }
      throw error;
    }
  }

  /**
   * Claims the exact rowless account named by a trusted Telegram continuation.
   * Only the provisional `telegram:<id>` Steward subject may move; mature
   * accounts are never merged, and canonical/projection ownership plus the
   * continuation's bound user and organization must all agree.
   */
  async promoteTelegramPersonalAccountToSteward(params: {
    telegramId: string;
    stewardUserId: string;
    expectedUserId: string;
    expectedOrganizationId: string;
  }): Promise<PromoteTelegramPersonalAccountResult> {
    try {
      return await dbWrite.transaction(async (tx) => {
        const lockKeys = [
          `telegram_personal_account:${params.telegramId}`,
          `steward_subject:${params.stewardUserId}`,
        ].sort();
        for (const lockKey of lockKeys) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
        }

        const temporaryStewardUserId = `telegram:${params.telegramId}`;
        const [canonicalTelegramOwner] = await tx
          .select()
          .from(users)
          .where(eq(users.telegram_id, params.telegramId))
          .limit(1);
        const [projectedTelegramOwner] = await tx
          .select()
          .from(userIdentities)
          .where(eq(userIdentities.telegram_id, params.telegramId))
          .limit(1);
        const [canonicalStewardOwner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.steward_user_id, params.stewardUserId))
          .limit(1);
        const [projectedStewardOwner] = await tx
          .select({ userId: userIdentities.user_id })
          .from(userIdentities)
          .where(eq(userIdentities.steward_user_id, params.stewardUserId))
          .limit(1);

        if (!canonicalTelegramOwner) {
          if (canonicalStewardOwner || projectedStewardOwner) {
            return { status: "steward_subject_owned_by_other_user" };
          }
          return projectedTelegramOwner
            ? { status: "identity_projection_conflict" }
            : { status: "not_found" };
        }
        if (
          canonicalTelegramOwner.id !== params.expectedUserId ||
          canonicalTelegramOwner.organization_id !== params.expectedOrganizationId
        ) {
          return { status: "continuation_account_mismatch" };
        }
        if (
          (canonicalStewardOwner && canonicalStewardOwner.id !== canonicalTelegramOwner.id) ||
          (projectedStewardOwner && projectedStewardOwner.userId !== canonicalTelegramOwner.id)
        ) {
          return { status: "steward_subject_owned_by_other_user" };
        }
        if (canonicalTelegramOwner.deleted_at) {
          return { status: "telegram_account_deleted" };
        }
        if (!canonicalTelegramOwner.is_active) {
          return { status: "telegram_account_inactive" };
        }
        if (
          canonicalTelegramOwner.is_anonymous ||
          canonicalTelegramOwner.role !== "owner" ||
          !canonicalTelegramOwner.organization_id ||
          (canonicalTelegramOwner.steward_user_id !== temporaryStewardUserId &&
            canonicalTelegramOwner.steward_user_id !== params.stewardUserId)
        ) {
          return { status: "telegram_owned_by_mature_account" };
        }

        const [organization] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, canonicalTelegramOwner.organization_id))
          .limit(1);
        if (!organization || organization.id !== params.expectedOrganizationId) {
          return { status: "continuation_account_mismatch" };
        }
        if (!organization.is_active) {
          return { status: "telegram_account_inactive" };
        }
        if (
          !projectedTelegramOwner ||
          projectedTelegramOwner.user_id !== canonicalTelegramOwner.id ||
          projectedTelegramOwner.telegram_id !== params.telegramId ||
          projectedTelegramOwner.is_anonymous
        ) {
          return { status: "identity_projection_conflict" };
        }

        if (canonicalTelegramOwner.steward_user_id === params.stewardUserId) {
          return projectedTelegramOwner.steward_user_id === params.stewardUserId
            ? { status: "already_promoted", user: canonicalTelegramOwner, organization }
            : { status: "identity_projection_conflict" };
        }

        const updatedAt = new Date();
        const [promotedUser] = await tx
          .update(users)
          .set({ steward_user_id: params.stewardUserId, updated_at: updatedAt })
          .where(
            and(
              eq(users.id, canonicalTelegramOwner.id),
              eq(users.organization_id, params.expectedOrganizationId),
              eq(users.steward_user_id, temporaryStewardUserId),
              eq(users.telegram_id, params.telegramId),
              eq(users.is_anonymous, false),
              eq(users.role, "owner"),
              eq(users.is_active, true),
              isNull(users.deleted_at),
            ),
          )
          .returning();
        if (!promotedUser) {
          return { status: "telegram_owned_by_mature_account" };
        }

        const [promotedIdentity] = await tx
          .update(userIdentities)
          .set({ steward_user_id: params.stewardUserId, updated_at: updatedAt })
          .where(
            and(
              eq(userIdentities.user_id, promotedUser.id),
              eq(userIdentities.steward_user_id, temporaryStewardUserId),
              eq(userIdentities.telegram_id, params.telegramId),
              eq(userIdentities.is_anonymous, false),
            ),
          )
          .returning({ id: userIdentities.id });
        if (!promotedIdentity) {
          throw new TelegramPromotionProjectionConflictError();
        }

        return { status: "promoted", user: promotedUser, organization };
      });
    } catch (error) {
      // error-policy:J1 The repository maps its private rollback sentinel to a typed sync result.
      if (error instanceof TelegramPromotionProjectionConflictError) {
        return { status: "identity_projection_conflict" };
      }
      throw error;
    }
  }

  /**
   * Creates or reuses the $0 personal account proven by a trusted messaging
   * boundary. A provider-sender transaction lock makes concurrent first turns
   * converge without an API key, agent row, or orphan organization.
   */
  async findOrCreateMessagingPersonalAccount(
    params: MessagingPersonalAccountParams,
  ): Promise<FindOrCreateMessagingPersonalAccountResult> {
    const senderId = params.platform === "telegram" ? params.telegramId : params.discordId;
    const identityWhere =
      params.platform === "telegram"
        ? eq(userIdentities.telegram_id, senderId)
        : eq(userIdentities.discord_id, senderId);
    const canonicalWhere =
      params.platform === "telegram"
        ? eq(users.telegram_id, senderId)
        : eq(users.discord_id, senderId);
    const identityFields =
      params.platform === "telegram"
        ? {
            telegram_id: senderId,
            telegram_username: params.telegramUsername,
            telegram_first_name: params.telegramFirstName,
          }
        : {
            discord_id: senderId,
            discord_username: params.discordUsername,
            discord_global_name: params.discordGlobalName,
            discord_avatar_url: params.discordAvatarUrl,
          };
    const label = params.platform === "telegram" ? "Telegram" : "Discord";
    const errorPrefix = params.platform.toUpperCase();

    return dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.platform}_personal_account:${senderId}`}))`,
      );

      const [projection] = await tx
        .select({ userId: userIdentities.user_id })
        .from(userIdentities)
        .where(identityWhere)
        .limit(1);
      const [canonical] = await tx.select().from(users).where(canonicalWhere).limit(1);

      if (projection && canonical && projection.userId !== canonical.id) {
        throw new ElizaError(`${label} identity owners disagree`, {
          code: `${errorPrefix}_PERSONAL_ACCOUNT_IDENTITY_CONFLICT`,
          context: { canonicalUserId: canonical.id, projectedUserId: projection.userId },
          severity: "fatal",
        });
      }

      const [existing] = projection
        ? await tx.select().from(users).where(eq(users.id, projection.userId)).limit(1)
        : canonical
          ? [canonical]
          : [];
      if (projection && !existing) {
        throw new ElizaError(`${label} identity projection has no canonical owner`, {
          code: `${errorPrefix}_PERSONAL_ACCOUNT_IDENTITY_CONFLICT`,
          context: { projectedUserId: projection.userId },
          severity: "fatal",
        });
      }

      if (existing) {
        const existingSenderId =
          params.platform === "telegram" ? existing.telegram_id : existing.discord_id;
        if (projection && existingSenderId && existingSenderId !== senderId) {
          throw new ElizaError(`${label} identity projection belongs to another sender`, {
            code: `${errorPrefix}_PERSONAL_ACCOUNT_IDENTITY_CONFLICT`,
            context: { projectedUserId: projection.userId },
            severity: "fatal",
          });
        }
        if (existing.deleted_at || !existing.is_active || !existing.organization_id) {
          throw new ElizaError(`${label} personal account is unavailable`, {
            code: `${errorPrefix}_PERSONAL_ACCOUNT_UNAVAILABLE`,
            context: { userId: existing.id },
            severity: "fatal",
          });
        }
        const [organization] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, existing.organization_id))
          .limit(1);
        if (!organization?.is_active) {
          throw new ElizaError(`${label} personal account organization is unavailable`, {
            code: `${errorPrefix}_PERSONAL_ACCOUNT_UNAVAILABLE`,
            context: { userId: existing.id, organizationId: existing.organization_id },
            severity: "fatal",
          });
        }

        const now = new Date();
        const [updated] = await tx
          .update(users)
          .set({
            ...identityFields,
            name: existing.name ?? params.displayName,
            updated_at: now,
          })
          .where(eq(users.id, existing.id))
          .returning();
        if (!updated) throw new Error(`${label} account ${existing.id} disappeared`);
        await tx
          .insert(userIdentities)
          .values({
            user_id: updated.id,
            steward_user_id: updated.steward_user_id,
            is_anonymous: updated.is_anonymous,
            ...identityFields,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: userIdentities.user_id,
            set: {
              ...identityFields,
              updated_at: now,
            },
          });
        return { user: updated, organization, isNew: false };
      }

      const [organization] = await tx
        .insert(organizations)
        .values({
          name: params.organizationName,
          slug: params.organizationSlug,
          credit_balance: "0.00",
        })
        .returning();
      if (!organization) throw new Error(`Failed to create ${label} personal organization`);

      const [user] = await tx
        .insert(users)
        .values({
          steward_user_id: `${params.platform}:${senderId}`,
          ...identityFields,
          name: params.displayName,
          is_anonymous: false,
          organization_id: organization.id,
          role: "owner",
          is_active: true,
        })
        .returning();
      if (!user) throw new Error(`Failed to create ${label} personal user`);
      await tx.insert(userIdentities).values({
        user_id: user.id,
        steward_user_id: user.steward_user_id,
        is_anonymous: false,
        ...identityFields,
      });
      return { user, organization, isNew: true };
    });
  }

  /**
   * Creates a new user.
   */
  async create(data: NewUser): Promise<User> {
    const [user] = await dbWrite.insert(users).values(data).returning();
    return user;
  }

  /**
   * Updates an existing user.
   */
  async update(id: string, data: Partial<NewUser>): Promise<User | undefined> {
    return dbWrite.transaction(async (tx) => {
      const now = new Date();
      if (userMutationRevokesPersonalSharedConsent(data)) {
        await revokePersonalSharedGroupConsentForUser(tx, id, now);
      }
      const [updated] = await tx
        .update(users)
        .set({
          ...data,
          updated_at: now,
        })
        .where(eq(users.id, id))
        .returning();
      return updated;
    });
  }

  /**
   * Links Telegram on the canonical user and routing projection atomically.
   * The Telegram gateway resolves senders through the userIdentities
   * projection (`findByTelegramIdWithOrganization`), so a canonical-only
   * write would fabricate a successful link that inbound DM routing cannot
   * observe. Mirrors {@link linkDiscordIdentity}.
   */
  async linkTelegramIdentity(
    userId: string,
    identity: TelegramIdentityLink,
  ): Promise<User | undefined> {
    return dbWrite.transaction(async (tx) => {
      const updatedAt = new Date();
      await revokePersonalSharedGroupConsentForUser(tx, userId, updatedAt);
      const [updated] = await tx
        .update(users)
        .set({ ...identity, updated_at: updatedAt })
        .where(eq(users.id, userId))
        .returning();
      if (!updated) return undefined;

      await tx
        .insert(userIdentities)
        .values({
          user_id: userId,
          steward_user_id: updated.steward_user_id,
          is_anonymous: updated.is_anonymous,
          anonymous_session_id: updated.anonymous_session_id,
          expires_at: updated.expires_at,
          ...identity,
          updated_at: updatedAt,
        })
        .onConflictDoUpdate({
          target: userIdentities.user_id,
          set: { ...identity, updated_at: updatedAt },
        });
      return updated;
    });
  }

  /**
   * Resolves and binds a channel handle using the caller's transaction. This
   * lets identity-link code consumption commit atomically with both identity
   * rows; a failed projection write therefore leaves the code pending.
   */
  async linkMessagingIdentityInTransaction(
    tx: DbTransaction,
    userId: string,
    provider: MessagingIdentityProvider,
    platformId: string,
    platformName?: string,
  ): Promise<LinkMessagingIdentityResult> {
    // Lock and validate the target before revoking any authority. Returning a
    // conflict must not commit a consent revocation when no identity changed.
    const [targetUser] = await tx
      .select({
        id: users.id,
        phoneNumber: users.phone_number,
        phoneVerified: users.phone_verified,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (!targetUser) return { status: "user_not_found" };
    if (
      provider === "phone" &&
      targetUser.phoneVerified === true &&
      targetUser.phoneNumber !== null &&
      targetUser.phoneNumber !== platformId
    ) {
      return { status: "handle_conflict" };
    }

    const ownerPredicates =
      provider === "telegram"
        ? [eq(users.telegram_id, platformId), eq(userIdentities.telegram_id, platformId)]
        : provider === "discord"
          ? [eq(users.discord_id, platformId), eq(userIdentities.discord_id, platformId)]
          : provider === "whatsapp"
            ? [eq(users.whatsapp_id, platformId), eq(userIdentities.whatsapp_id, platformId)]
            : [eq(users.phone_number, platformId), eq(userIdentities.phone_number, platformId)];
    const [canonicalOwner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(ownerPredicates[0])
      .limit(1);
    const [projectionOwner] = await tx
      .select({ userId: userIdentities.user_id })
      .from(userIdentities)
      .where(ownerPredicates[1])
      .limit(1);
    if (
      (canonicalOwner && canonicalOwner.id !== userId) ||
      (projectionOwner && projectionOwner.userId !== userId)
    ) {
      return { status: "handle_conflict" };
    }

    const now = new Date();
    if (provider === "telegram" || provider === "phone") {
      await revokePersonalSharedGroupConsentForUser(tx, userId, now);
    }
    const identity =
      provider === "telegram"
        ? { telegram_id: platformId, telegram_username: platformName ?? null }
        : provider === "discord"
          ? { discord_id: platformId, discord_username: platformName ?? platformId }
          : provider === "whatsapp"
            ? { whatsapp_id: platformId, whatsapp_name: platformName ?? null }
            : { phone_number: platformId, phone_verified: true };
    const targetPredicate =
      provider === "phone"
        ? and(
            eq(users.id, userId),
            or(
              isNull(users.phone_number),
              eq(users.phone_number, platformId),
              sql`${users.phone_verified} IS NOT TRUE`,
            ),
          )
        : eq(users.id, userId);
    const [updated] = await tx
      .update(users)
      .set({ ...identity, updated_at: now })
      .where(targetPredicate)
      .returning();
    if (!updated) {
      // The target row is locked above. A miss is only possible if a guarded
      // phone precondition changes in this transaction; fail closed.
      return { status: "handle_conflict" };
    }

    await tx
      .insert(userIdentities)
      .values({
        user_id: userId,
        steward_user_id: updated.steward_user_id,
        is_anonymous: updated.is_anonymous,
        anonymous_session_id: updated.anonymous_session_id,
        expires_at: updated.expires_at,
        ...identity,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: userIdentities.user_id,
        set: { ...identity, updated_at: now },
      });
    return { status: "linked", user: updated };
  }

  /** Links Discord on the canonical user and routing projection atomically. */
  async linkDiscordIdentity(
    userId: string,
    identity: DiscordIdentityLink,
  ): Promise<User | undefined> {
    return dbWrite.transaction(async (tx) => {
      const updatedAt = new Date();
      const [updated] = await tx
        .update(users)
        .set({ ...identity, updated_at: updatedAt })
        .where(eq(users.id, userId))
        .returning();
      if (!updated) return undefined;

      await tx
        .insert(userIdentities)
        .values({
          user_id: userId,
          steward_user_id: updated.steward_user_id,
          is_anonymous: updated.is_anonymous,
          anonymous_session_id: updated.anonymous_session_id,
          expires_at: updated.expires_at,
          ...identity,
          updated_at: updatedAt,
        })
        .onConflictDoUpdate({
          target: userIdentities.user_id,
          set: { ...identity, updated_at: updatedAt },
        });
      return updated;
    });
  }

  /** Links WhatsApp on the canonical user and routing projection atomically. */
  async linkWhatsAppIdentity(
    userId: string,
    identity: WhatsAppIdentityLink,
  ): Promise<User | undefined> {
    return dbWrite.transaction(async (tx) => {
      const updatedAt = new Date();
      const [updated] = await tx
        .update(users)
        .set({ ...identity, updated_at: updatedAt })
        .where(eq(users.id, userId))
        .returning();
      if (!updated) return undefined;

      await tx
        .insert(userIdentities)
        .values({
          user_id: userId,
          steward_user_id: updated.steward_user_id,
          is_anonymous: updated.is_anonymous,
          anonymous_session_id: updated.anonymous_session_id,
          expires_at: updated.expires_at,
          ...identity,
          updated_at: updatedAt,
        })
        .onConflictDoUpdate({
          target: userIdentities.user_id,
          set: { ...identity, updated_at: updatedAt },
        });
      return updated;
    });
  }

  /**
   * Links a verified phone on both the canonical user and the identity lookup
   * projection in one transaction. Phone gateways resolve through the
   * projection, so committing only the canonical row would fabricate a
   * successful link that inbound routing cannot observe.
   */
  async linkVerifiedPhone(id: string, phoneNumber: string): Promise<User | undefined> {
    return dbWrite.transaction(async (tx) => {
      const now = new Date();
      await revokePersonalSharedGroupConsentForUser(tx, id, now);
      const [updated] = await tx
        .update(users)
        .set({
          phone_number: phoneNumber,
          phone_verified: true,
          updated_at: now,
        })
        .where(
          and(
            eq(users.id, id),
            or(
              isNull(users.phone_number),
              eq(users.phone_number, phoneNumber),
              sql`${users.phone_verified} IS NOT TRUE`,
            ),
          ),
        )
        .returning();
      if (!updated) {
        const [existing] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, id))
          .limit(1);
        if (!existing) return undefined;
        throw new ElizaError("Refusing to replace a different verified phone identity", {
          code: "VERIFIED_PHONE_MISMATCH",
          context: { userId: id },
          severity: "fatal",
        });
      }

      const [identity] = await tx
        .insert(userIdentities)
        .values({
          user_id: updated.id,
          steward_user_id: updated.steward_user_id,
          is_anonymous: updated.is_anonymous,
          anonymous_session_id: updated.anonymous_session_id,
          expires_at: updated.expires_at,
          phone_number: phoneNumber,
          phone_verified: true,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: userIdentities.user_id,
          set: {
            phone_number: phoneNumber,
            phone_verified: true,
            updated_at: now,
          },
        })
        .returning({ id: userIdentities.id });
      if (!identity) {
        throw new Error(`Failed to project verified phone for user ${id}`);
      }
      return updated;
    });
  }

  /**
   * Links Telegram and phone on the canonical row and its lookup projection in
   * one transaction. A uniqueness failure in either table rolls back both.
   *
   * The phone guard lives in the UPDATE predicate (not check-then-write): a
   * user whose row already carries a different verified phone number is
   * refused with `phone_mismatch` rather than silently overwritten.
   * Re-linking the same phone is idempotent, and an unverified placeholder
   * phone may be replaced.
   */
  async linkTelegramAndPhoneIdentity(
    userId: string,
    identity: TelegramPhoneIdentityLink,
  ): Promise<LinkTelegramAndPhoneResult> {
    return dbWrite.transaction(async (tx) => {
      const updatedAt = new Date();
      const [existing] = await tx
        .select({
          phoneNumber: users.phone_number,
          phoneVerified: users.phone_verified,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!existing) return { status: "user_not_found" };
      if (
        existing.phoneVerified === true &&
        existing.phoneNumber !== null &&
        existing.phoneNumber !== identity.phone_number
      ) {
        return { status: "phone_mismatch", existingPhone: existing.phoneNumber };
      }
      await revokePersonalSharedGroupConsentForUser(tx, userId, updatedAt);
      const [updated] = await tx
        .update(users)
        .set({
          ...identity,
          phone_verified: true,
          updated_at: updatedAt,
        })
        .where(
          and(
            eq(users.id, userId),
            or(
              isNull(users.phone_number),
              eq(users.phone_number, identity.phone_number),
              sql`${users.phone_verified} IS NOT TRUE`,
            ),
          ),
        )
        .returning();

      if (!updated) {
        // The user row and guarded phone state are locked above, so a miss is
        // unreachable unless a future mutation adds another predicate.
        return { status: "phone_mismatch", existingPhone: existing.phoneNumber ?? "" };
      }

      await tx
        .insert(userIdentities)
        .values({
          user_id: updated.id,
          steward_user_id: updated.steward_user_id,
          is_anonymous: updated.is_anonymous,
          anonymous_session_id: updated.anonymous_session_id,
          expires_at: updated.expires_at,
          telegram_id: updated.telegram_id,
          telegram_username: updated.telegram_username,
          telegram_first_name: updated.telegram_first_name,
          telegram_photo_url: updated.telegram_photo_url,
          phone_number: updated.phone_number,
          phone_verified: updated.phone_verified,
          updated_at: updatedAt,
        })
        .onConflictDoUpdate({
          target: userIdentities.user_id,
          set: {
            steward_user_id: updated.steward_user_id,
            is_anonymous: updated.is_anonymous,
            anonymous_session_id: updated.anonymous_session_id,
            expires_at: updated.expires_at,
            telegram_id: updated.telegram_id,
            telegram_username: updated.telegram_username,
            telegram_first_name: updated.telegram_first_name,
            telegram_photo_url: updated.telegram_photo_url,
            phone_number: updated.phone_number,
            phone_verified: updated.phone_verified,
            updated_at: updatedAt,
          },
        });

      return { status: "linked", user: updated };
    });
  }

  /**
   * Links a Steward user ID to an existing user.
   */
  async linkStewardId(userId: string, stewardUserId: string): Promise<User | undefined> {
    return dbWrite.transaction(async (tx) => {
      const now = new Date();
      await revokePersonalSharedGroupConsentForUser(tx, userId, now);
      const [updated] = await tx
        .update(users)
        .set({
          steward_user_id: stewardUserId,
          updated_at: now,
        })
        .where(eq(users.id, userId))
        .returning();
      return updated;
    });
  }

  /**
   * Finds the identity projection row for a user from primary.
   * Use after writes when the latest identity row must be visible.
   */
  async findIdentityByUserIdForWrite(userId: string): Promise<UserIdentity | undefined> {
    return await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, userId),
    });
  }

  /**
   * Refreshes WhatsApp projection fields from the canonical users row.
   */
  async refreshWhatsAppProjectionForWrite(userId: string): Promise<void> {
    const [canonicalIdentity] = await dbWrite
      .select({
        whatsapp_id: users.whatsapp_id,
        whatsapp_name: users.whatsapp_name,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!canonicalIdentity) {
      return;
    }

    if (canonicalIdentity.whatsapp_id) {
      const conflictingProjection = await dbWrite.query.userIdentities.findFirst({
        where: and(
          eq(userIdentities.whatsapp_id, canonicalIdentity.whatsapp_id),
          ne(userIdentities.user_id, userId),
        ),
      });

      if (conflictingProjection) {
        return;
      }
    }

    await dbWrite
      .update(userIdentities)
      .set({
        whatsapp_id: canonicalIdentity.whatsapp_id ?? null,
        whatsapp_name: canonicalIdentity.whatsapp_id
          ? (canonicalIdentity.whatsapp_name ?? null)
          : null,
        updated_at: new Date(),
      })
      .where(eq(userIdentities.user_id, userId));
  }

  /**
   * Refreshes Discord projection fields from the canonical users row.
   * Inbound Discord routing resolves senders exclusively through the
   * `user_identities` projection (see {@link findByDiscordIdWithOrganization}),
   * so a canonical-only `users.discord_id` write is invisible to routing until
   * this refresh projects it.
   *
   * Two deliberate behaviors, mirroring {@link refreshWhatsAppProjectionForWrite}
   * and {@link linkTelegramAndPhoneIdentity}:
   * - an existing projection row owned by a DIFFERENT user for the same
   *   discord_id declines the refresh (tenant safety) instead of stealing the
   *   identity;
   * - a user with no projection row yet (created before projection upserts
   *   existed) gets one, because an UPDATE-only refresh would silently leave
   *   routing broken for exactly the accounts this method exists to repair.
   */
  async refreshDiscordProjectionForWrite(userId: string): Promise<void> {
    const [canonical] = await dbWrite
      .select({
        steward_user_id: users.steward_user_id,
        is_anonymous: users.is_anonymous,
        anonymous_session_id: users.anonymous_session_id,
        expires_at: users.expires_at,
        discord_id: users.discord_id,
        discord_username: users.discord_username,
        discord_global_name: users.discord_global_name,
        discord_avatar_url: users.discord_avatar_url,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!canonical) {
      return;
    }

    if (canonical.discord_id) {
      const conflictingProjection = await dbWrite.query.userIdentities.findFirst({
        where: and(
          eq(userIdentities.discord_id, canonical.discord_id),
          ne(userIdentities.user_id, userId),
        ),
      });

      if (conflictingProjection) {
        return;
      }
    }

    const updatedAt = new Date();
    const discordProjection = {
      discord_id: canonical.discord_id ?? null,
      discord_username: canonical.discord_id ? (canonical.discord_username ?? null) : null,
      discord_global_name: canonical.discord_id ? (canonical.discord_global_name ?? null) : null,
      discord_avatar_url: canonical.discord_id ? (canonical.discord_avatar_url ?? null) : null,
    };

    await dbWrite
      .insert(userIdentities)
      .values({
        user_id: userId,
        steward_user_id: canonical.steward_user_id,
        is_anonymous: canonical.is_anonymous,
        anonymous_session_id: canonical.anonymous_session_id,
        expires_at: canonical.expires_at,
        ...discordProjection,
        updated_at: updatedAt,
      })
      .onConflictDoUpdate({
        target: userIdentities.user_id,
        set: {
          ...discordProjection,
          updated_at: updatedAt,
        },
      });
  }

  /**
   * Finds the identity projection row for a Steward user ID from primary.
   * Use when recovery or auth linking must verify projection row ownership directly.
   */
  async findIdentityByStewardIdForWrite(stewardUserId: string): Promise<UserIdentity | undefined> {
    return await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.steward_user_id, stewardUserId),
    });
  }

  private async findByStewardIdWithOrganizationUsingDb(
    database: typeof dbRead,
    stewardUserId: string,
  ): Promise<UserWithOrganization | undefined> {
    const identityUserId = await this.findIdentityUserIdByStewardId(database, stewardUserId);

    if (identityUserId) {
      return await this.findUserWithOrganizationById(database, identityUserId);
    }

    return await this.findUserWithOrganizationByStewardId(database, stewardUserId);
  }

  private async findIdentityUserIdByStewardId(
    database: typeof dbRead,
    stewardUserId: string,
  ): Promise<string | undefined> {
    const [identity] = await database
      .select({ user_id: userIdentities.user_id })
      .from(userIdentities)
      .where(eq(userIdentities.steward_user_id, stewardUserId))
      .limit(1);

    return identity?.user_id;
  }

  private async findIdentityByProvider(
    provider: IdentityProvider,
    identifier: string,
  ): Promise<UserIdentity | undefined> {
    switch (provider) {
      case "steward":
        return dbRead.query.userIdentities.findFirst({
          where: eq(userIdentities.steward_user_id, identifier),
        });
      case "telegram":
        return dbRead.query.userIdentities.findFirst({
          where: eq(userIdentities.telegram_id, identifier),
        });
      case "discord":
        return dbRead.query.userIdentities.findFirst({
          where: eq(userIdentities.discord_id, identifier),
        });
      case "whatsapp":
        return dbRead.query.userIdentities.findFirst({
          where: eq(userIdentities.whatsapp_id, identifier),
        });
      case "phone":
        return dbRead.query.userIdentities.findFirst({
          where: eq(userIdentities.phone_number, identifier),
        });
    }
  }

  private async findCanonicalUserByProvider(
    provider: IdentityProvider,
    identifier: string,
  ): Promise<User | undefined> {
    switch (provider) {
      case "steward":
        return this.findUserByPredicate(dbRead, eq(users.steward_user_id, identifier));
      case "telegram":
        return this.findUserByPredicate(dbRead, eq(users.telegram_id, identifier));
      case "discord":
        return this.findUserByPredicate(dbRead, eq(users.discord_id, identifier));
      case "whatsapp":
        return this.findUserByPredicate(dbRead, eq(users.whatsapp_id, identifier));
      case "phone":
        return this.findUserByPredicate(dbRead, eq(users.phone_number, identifier));
    }
  }

  private async findFirstIdentity(identifier: string): Promise<UserIdentity | undefined> {
    const providers: IdentityProvider[] = ["steward", "telegram", "discord", "whatsapp"];
    for (const provider of providers) {
      const identity = await this.findIdentityByProvider(provider, identifier);
      if (identity) return identity;
    }
    return this.findIdentityByProvider("phone", identifier);
  }

  private async findUserByPredicate(
    database: typeof dbRead,
    predicate: SQL<unknown>,
  ): Promise<User | undefined> {
    const [user] = await database.select().from(users).where(predicate).limit(1);
    return user;
  }

  private async listUsersByPredicate(
    database: typeof dbRead,
    predicate: SQL<unknown>,
  ): Promise<User[]> {
    return await database.select().from(users).where(predicate);
  }

  private async findUserWithOrganizationByPredicate(
    database: typeof dbRead,
    predicate: SQL<unknown>,
  ): Promise<UserWithOrganization | undefined> {
    return (await database.query.users.findFirst({
      where: predicate,
      with: {
        organization: true,
      },
    })) as UserWithOrganization | undefined;
  }

  private async findUserWithOrganizationById(
    database: typeof dbRead,
    userId: string,
  ): Promise<UserWithOrganization | undefined> {
    return await this.findUserWithOrganizationByPredicate(database, eq(users.id, userId));
  }

  private async findUserWithOrganizationByStewardId(
    database: typeof dbRead,
    stewardUserId: string,
  ): Promise<UserWithOrganization | undefined> {
    return await this.findUserWithOrganizationByPredicate(
      database,
      eq(users.steward_user_id, stewardUserId),
    );
  }

  /**
   * Upserts the Steward identity projection for a user.
   */
  async upsertStewardIdentity(userId: string, stewardUserId: string): Promise<UserIdentity> {
    const rows = await sqlRows<UserIdentity>(
      dbWrite,
      sql`
      INSERT INTO ${userIdentities} (
        user_id,
        steward_user_id,
        is_anonymous,
        anonymous_session_id,
        expires_at,
        telegram_id,
        telegram_username,
        telegram_first_name,
        telegram_photo_url,
        phone_number,
        phone_verified,
        discord_id,
        discord_username,
        discord_global_name,
        discord_avatar_url,
        whatsapp_id,
        whatsapp_name
      )
      SELECT
        ${userId},
        ${stewardUserId},
        u.is_anonymous,
        u.anonymous_session_id,
        u.expires_at,
        u.telegram_id,
        u.telegram_username,
        u.telegram_first_name,
        u.telegram_photo_url,
        u.phone_number,
        u.phone_verified,
        u.discord_id,
        u.discord_username,
        u.discord_global_name,
        u.discord_avatar_url,
        u.whatsapp_id,
        u.whatsapp_name
      FROM ${users} u
      WHERE u.id = ${userId}
      ON CONFLICT (user_id) DO UPDATE
      SET
        steward_user_id = EXCLUDED.steward_user_id,
        is_anonymous = EXCLUDED.is_anonymous,
        anonymous_session_id = EXCLUDED.anonymous_session_id,
        expires_at = EXCLUDED.expires_at,
        telegram_id = EXCLUDED.telegram_id,
        telegram_username = EXCLUDED.telegram_username,
        telegram_first_name = EXCLUDED.telegram_first_name,
        telegram_photo_url = EXCLUDED.telegram_photo_url,
        phone_number = EXCLUDED.phone_number,
        phone_verified = EXCLUDED.phone_verified,
        discord_id = EXCLUDED.discord_id,
        discord_username = EXCLUDED.discord_username,
        discord_global_name = EXCLUDED.discord_global_name,
        discord_avatar_url = EXCLUDED.discord_avatar_url,
        whatsapp_id = EXCLUDED.whatsapp_id,
        whatsapp_name = EXCLUDED.whatsapp_name,
        updated_at = NOW()
      RETURNING *
    `,
    );

    const [identity] = rows;

    if (!identity) {
      throw new Error(`User ${userId} not found while upserting Steward identity ${stewardUserId}`);
    }

    return identity;
  }

  /**
   * Deletes a user by ID.
   */
  async delete(id: string): Promise<void> {
    await dbWrite.transaction(async (tx) => {
      await revokePersonalSharedGroupConsentForUser(tx, id, new Date());
      await tx.delete(users).where(eq(users.id, id));
    });
  }

  /**
   * Removes a sole-user personal organization as one database transaction.
   * Deleting the organization first lets its declared cascades erase the user
   * and associated content. Any restrictive retention FK aborts the entire
   * transaction, so a retry can never observe a half-deleted account.
   */
  async deletePersonalOrganizationAtomically(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    await dbWrite.transaction(async (tx) => {
      const observedMembers = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organization_id, organizationId));
      if (!observedMembers.some((member) => member.id === userId)) {
        throw new Error("Account deletion user is not a member of its personal organization");
      }
      if (observedMembers.length !== 1) {
        throw new Error("Account deletion requires a sole-user personal organization");
      }

      await revokePersonalSharedGroupConsentForUser(tx, userId, new Date());
      const lockedMembers = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organization_id, organizationId))
        .for("update");
      if (lockedMembers.length !== 1 || lockedMembers[0]?.id !== userId) {
        throw new Error("Account deletion personal organization membership changed");
      }

      const deleted = await tx
        .delete(organizations)
        .where(eq(organizations.id, organizationId))
        .returning({ id: organizations.id });
      if (deleted.length !== 1) {
        throw new Error("Personal organization disappeared during account deletion");
      }
    });
  }
}

/**
 * Singleton instance of UsersRepository.
 */
export const usersRepository = new UsersRepository();
