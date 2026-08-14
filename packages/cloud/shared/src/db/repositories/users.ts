// Persists users records for cloud services through the shared DB boundary.
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { type Organization, organizations } from "../schemas/organizations";
import { type UserIdentity, userIdentities } from "../schemas/user-identities";
import { type NewUser, type User, users } from "../schemas/users";

export type { NewUser, User, UserIdentity };

export type IdentityProvider = "steward" | "telegram" | "discord" | "whatsapp" | "phone";

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
    const [updated] = await dbWrite
      .update(users)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    return updated;
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

  /**
   * Links a verified phone on both the canonical user and the identity lookup
   * projection in one transaction. Phone gateways resolve through the
   * projection, so committing only the canonical row would fabricate a
   * successful link that inbound routing cannot observe.
   */
  async linkVerifiedPhone(id: string, phoneNumber: string): Promise<User | undefined> {
    return dbWrite.transaction(async (tx) => {
      const now = new Date();
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
        const [existing] = await tx
          .select({ phone_number: users.phone_number })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (!existing || !existing.phone_number) {
          // A present row with a NULL phone would have matched the UPDATE
          // predicate, so a phoneless miss means the user row is gone.
          return { status: "user_not_found" };
        }
        return { status: "phone_mismatch", existingPhone: existing.phone_number };
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
    const [updated] = await dbWrite
      .update(users)
      .set({
        steward_user_id: stewardUserId,
        updated_at: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return updated;
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
    const user = await this.findUserByPredicate(database, predicate);
    return user ? await this.attachOrganization(database, user) : undefined;
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

  private async attachOrganization(
    database: typeof dbRead,
    user: User,
  ): Promise<UserWithOrganization> {
    const organizationId = user.organization_id;

    if (!organizationId) {
      return {
        ...user,
        organization: null,
      };
    }

    // Keep organization hydration on the same relational query path used by the
    // pre-regression auth lookup. Direct table selects changed numeric formatting
    // for credit_balance in the failing regression case.
    const relationalUser = (await database.query.users.findFirst({
      columns: {
        id: true,
      },
      where: eq(users.id, user.id),
      with: {
        organization: true,
      },
    })) as { organization: Organization | null } | undefined;

    return {
      ...user,
      organization: relationalUser?.organization ?? null,
    };
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
    await dbWrite.delete(users).where(eq(users.id, id));
  }
}

/**
 * Singleton instance of UsersRepository.
 */
export const usersRepository = new UsersRepository();
