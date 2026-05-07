import { and, asc, eq, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { type Organization } from "../schemas/organizations";
import { type UserIdentity, userIdentities } from "../schemas/user-identities";
import { type NewUser, type User, users } from "../schemas/users";

export type { NewUser, User };

/**
 * User with associated organization data.
 */
export interface UserWithOrganization extends User {
  organization: Organization | null;
}

/**
 * Repository for user database operations.
 *
 * Read operations → dbRead (read replica)
 * Write operations → dbWrite (primary)
 */
export class UsersRepository {
  // ============================================================================
  // READ OPERATIONS (use read replica)
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
   * Use after writes when replica lag could hide the just-written identity row.
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
   * Lists all users in an organization.
   */
  async listByOrganization(organizationId: string): Promise<User[]> {
    return await this.listUsersByPredicate(dbRead, eq(users.organization_id, organizationId));
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

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
   * Use after writes when replica lag could return a stale identity row.
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
   * Lists active, non-anonymous users with email addresses that still need a
   * Steward user mapping.
   */
  async listPendingStewardProvisioning(
    limit: number,
  ): Promise<Array<Pick<User, "id" | "email" | "email_verified" | "name" | "steward_user_id">>> {
    return await dbWrite
      .select({
        id: users.id,
        email: users.email,
        email_verified: users.email_verified,
        name: users.name,
        steward_user_id: users.steward_user_id,
      })
      .from(users)
      .where(
        and(
          eq(users.is_active, true),
          eq(users.is_anonymous, false),
          isNull(users.steward_user_id),
          isNotNull(users.email),
        ),
      )
      .orderBy(asc(users.created_at), asc(users.id))
      .limit(limit);
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
