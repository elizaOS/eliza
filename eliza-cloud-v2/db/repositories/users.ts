import { eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { users, type User, type NewUser } from "../schemas/users";
import { type Organization } from "../schemas/organizations";

export type { User, NewUser };

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
    return await dbRead.query.users.findFirst({
      where: eq(users.id, id),
    });
  }

  /**
   * Finds a user by email address.
   */
  async findByEmail(email: string): Promise<User | undefined> {
    return await dbRead.query.users.findFirst({
      where: eq(users.email, email),
    });
  }

  /**
   * Finds a user by Privy user ID with organization data.
   */
  async findByPrivyIdWithOrganization(
    privyUserId: string,
  ): Promise<UserWithOrganization | undefined> {
    const user = await dbRead.query.users.findFirst({
      where: eq(users.privy_user_id, privyUserId),
      with: {
        organization: true,
      },
    });

    return user as UserWithOrganization | undefined;
  }

  /**
   * Finds a user by ID with organization data.
   */
  async findWithOrganization(
    userId: string,
  ): Promise<UserWithOrganization | undefined> {
    const user = await dbRead.query.users.findFirst({
      where: eq(users.id, userId),
      with: {
        organization: true,
      },
    });

    return user as UserWithOrganization | undefined;
  }

  /**
   * Finds a user by email with organization data.
   */
  async findByEmailWithOrganization(
    email: string,
  ): Promise<UserWithOrganization | undefined> {
    const user = await dbRead.query.users.findFirst({
      where: eq(users.email, email),
      with: {
        organization: true,
      },
    });

    return user as UserWithOrganization | undefined;
  }

  /**
   * Finds a user by wallet address (case-insensitive).
   */
  async findByWalletAddress(walletAddress: string): Promise<User | undefined> {
    return await dbRead.query.users.findFirst({
      where: eq(users.wallet_address, walletAddress.toLowerCase()),
    });
  }

  /**
   * Finds a user by Telegram ID.
   */
  async findByTelegramId(telegramId: string): Promise<User | undefined> {
    return await dbRead.query.users.findFirst({
      where: eq(users.telegram_id, telegramId),
    });
  }

  /**
   * Finds a user by Telegram ID with organization data.
   */
  async findByTelegramIdWithOrganization(
    telegramId: string,
  ): Promise<UserWithOrganization | undefined> {
    const user = await dbRead.query.users.findFirst({
      where: eq(users.telegram_id, telegramId),
      with: {
        organization: true,
      },
    });

    return user as UserWithOrganization | undefined;
  }

  /**
   * Finds a user by phone number (E.164 format).
   */
  async findByPhoneNumber(phoneNumber: string): Promise<User | undefined> {
    return await dbRead.query.users.findFirst({
      where: eq(users.phone_number, phoneNumber),
    });
  }

  /**
   * Finds a user by phone number with organization data.
   */
  async findByPhoneNumberWithOrganization(
    phoneNumber: string,
  ): Promise<UserWithOrganization | undefined> {
    const user = await dbRead.query.users.findFirst({
      where: eq(users.phone_number, phoneNumber),
      with: {
        organization: true,
      },
    });

    return user as UserWithOrganization | undefined;
  }

  /**
   * Finds a user by wallet address with organization data.
   */
  async findByWalletAddressWithOrganization(
    walletAddress: string,
  ): Promise<UserWithOrganization | undefined> {
    const user = await dbRead.query.users.findFirst({
      where: eq(users.wallet_address, walletAddress.toLowerCase()),
      with: {
        organization: true,
      },
    });

    return user as UserWithOrganization | undefined;
  }

  /**
   * Lists all users in an organization.
   */
  async listByOrganization(organizationId: string): Promise<User[]> {
    return await dbRead.query.users.findMany({
      where: eq(users.organization_id, organizationId),
    });
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
