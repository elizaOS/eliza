/**
 * Eliza App User Service
 *
 * Manages user accounts for Eliza App authentication.
 * Primary auth: Telegram OAuth + phone number (entered by user in frontend).
 * Auto-creates organizations for new users with initial credit balance.
 *
 * Cross-platform support:
 * - Telegram bot: lookup by telegram_id
 * - iMessage: lookup by phone_number (same phone entered during Telegram OAuth)
 */

import { organizationsRepository } from "@/db/repositories/organizations";
import { type UserWithOrganization, usersRepository } from "@/db/repositories/users";
import type { Organization } from "@/db/schemas/organizations";
import type { NewUser, User } from "@/db/schemas/users";
import { apiKeysService } from "@/lib/services/api-keys";
import { creditsService } from "@/lib/services/credits";
import { redeemSignupCode } from "@/lib/services/signup-code";
import { isValidEmail, maskEmailForLogging } from "@/lib/utils/email-validation";
import { logger } from "@/lib/utils/logger";
import { normalizePhoneNumber } from "@/lib/utils/phone-normalization";
import type { TelegramAuthData } from "./telegram-auth";

const ELIZA_APP_INITIAL_CREDITS = 5.0;

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Error) {
    // PostgreSQL unique violation error code
    return (
      error.message.includes("unique constraint") ||
      error.message.includes("duplicate key") ||
      (error as { code?: string }).code === "23505"
    );
  }
  return false;
}

export interface FindOrCreateResult {
  user: User;
  organization: Organization;
  isNew: boolean;
}

function generateSlugFromTelegram(username?: string, telegramId?: string): string {
  const base = username ? username.toLowerCase().replace(/[^a-z0-9]/g, "-") : `tg-${telegramId}`;
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `${base}-${timestamp}${random}`;
}

function generateSlugFromPhone(phoneNumber: string): string {
  const lastFour = phoneNumber.replace(/\D/g, "").slice(-4);
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `phone-${lastFour}-${timestamp}${random}`;
}

function generateSlugFromEmail(email: string): string {
  const prefix = email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `email-${prefix}-${timestamp}${random}`;
}

function generateSlugFromDiscord(username?: string, discordId?: string): string {
  const base = username ? username.toLowerCase().replace(/[^a-z0-9]/g, "-") : discordId;
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `discord-${base}-${timestamp}${random}`;
}

function generateSlugFromWhatsApp(whatsappId: string): string {
  const lastFour = whatsappId.slice(-4);
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `wa-${lastFour}-${timestamp}${random}`;
}

async function ensureUniqueSlug(generateFn: () => string, maxAttempts = 10): Promise<string> {
  let slug = generateFn();
  let attempts = 0;

  while (await organizationsRepository.findBySlug(slug)) {
    attempts++;
    if (attempts >= maxAttempts) {
      throw new Error("Failed to generate unique organization slug");
    }
    slug = generateFn();
  }

  return slug;
}

async function createUserWithOrganization(params: {
  userData: Omit<NewUser, "organization_id">;
  organizationName: string;
  slugGenerator: () => string;
  signupCode?: string;
}): Promise<FindOrCreateResult> {
  const { userData, organizationName, slugGenerator, signupCode } = params;
  const slug = await ensureUniqueSlug(slugGenerator);

  const organization = await organizationsRepository.create({
    name: organizationName,
    slug,
    credit_balance: "0.00",
  });

  if (ELIZA_APP_INITIAL_CREDITS > 0) {
    await creditsService.addCredits({
      organizationId: organization.id,
      amount: ELIZA_APP_INITIAL_CREDITS,
      description: "Eliza App - Welcome bonus",
      metadata: { type: "initial_free_credits", source: "eliza-app-signup" },
    });
  }

  const user = await usersRepository.create({
    ...userData,
    organization_id: organization.id,
    role: "owner",
    is_active: true,
  });

  /* WHY try/catch: Invalid or already-used code must not block account creation; log and continue. */
  if (signupCode) {
    try {
      await redeemSignupCode(organization.id, signupCode);
    } catch (error) {
      logger.warn("[ElizaAppUserService] Signup code redemption failed for new org", {
        organizationId: organization.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await apiKeysService.create({
    user_id: user.id,
    organization_id: organization.id,
    name: "Eliza App Default Key",
    is_active: true,
  });

  logger.info("[ElizaAppUserService] Created new user and organization", {
    userId: user.id,
    organizationId: organization.id,
    telegramId: user.telegram_id,
    phoneNumber: user.phone_number,
  });

  return { user, organization, isNew: true };
}

class ElizaAppUserService {
  /**
   * Find or create user by Telegram OAuth data WITH phone number.
   * This is the primary authentication method - requires both Telegram and phone.
   * Phone number enables cross-platform messaging (iMessage lookup).
   *
   * Cross-platform linking scenarios:
   * 1. User exists by telegram_id → update profile, ensure phone is set
   * 2. User exists by phone_number (iMessage-first) → link Telegram to that user
   * 3. Neither exists → create new user with both
   */
  async findOrCreateByTelegramWithPhone(
    telegramData: TelegramAuthData,
    phoneNumber: string,
    signupCode?: string,
  ): Promise<FindOrCreateResult> {
    const telegramId = String(telegramData.id);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    // Scenario 1: Check if user exists by telegram_id (returning Telegram user)
    const existingTelegramUser = await usersRepository.findByTelegramIdWithOrganization(telegramId);

    if (existingTelegramUser && existingTelegramUser.organization) {
      // Update Telegram profile data and ensure phone is set
      const updates: Partial<NewUser> = {
        telegram_username: telegramData.username || existingTelegramUser.telegram_username,
        telegram_first_name: telegramData.first_name,
        telegram_photo_url: telegramData.photo_url || existingTelegramUser.telegram_photo_url,
        updated_at: new Date(),
      };

      // Set phone number if not already set - but first check it's not taken
      if (!existingTelegramUser.phone_number) {
        const phoneOwner = await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);
        if (phoneOwner && phoneOwner.id !== existingTelegramUser.id) {
          // Phone is owned by a different user - this is a conflict
          logger.warn("[ElizaAppUserService] Phone already owned by another user", {
            telegramUserId: existingTelegramUser.id,
            phoneOwnerId: phoneOwner.id,
            phone: `***${normalizedPhone.slice(-4)}`,
          });
          throw new Error("PHONE_ALREADY_LINKED");
        }
        updates.phone_number = normalizedPhone;
        updates.phone_verified = true;
      } else if (existingTelegramUser.phone_number !== normalizedPhone) {
        // User already has a different phone linked - reject the mismatch
        logger.warn("[ElizaAppUserService] Telegram user has different phone linked", {
          telegramId,
          existingPhone: `***${existingTelegramUser.phone_number.slice(-4)}`,
          requestedPhone: `***${normalizedPhone.slice(-4)}`,
        });
        throw new Error("PHONE_MISMATCH");
      }

      try {
        await usersRepository.update(existingTelegramUser.id, updates);
      } catch (error) {
        // Handle race condition: unique constraint violation on phone_number
        if (isUniqueConstraintError(error)) {
          logger.warn("[ElizaAppUserService] Race condition on phone update", {
            telegramId,
            phone: `***${normalizedPhone.slice(-4)}`,
          });
          throw new Error("PHONE_ALREADY_LINKED");
        }
        throw error;
      }

      logger.info("[ElizaAppUserService] Found existing Telegram user, updated", {
        userId: existingTelegramUser.id,
        telegramId,
        phoneAdded: !existingTelegramUser.phone_number,
      });

      // Refetch to get updated data
      const updatedUser = await usersRepository.findByTelegramIdWithOrganization(telegramId);
      return {
        user: updatedUser!,
        organization: updatedUser!.organization!,
        isNew: false,
      };
    }

    // Scenario 2: Check if user exists by phone_number (iMessage-first user linking Telegram)
    const existingPhoneUser =
      await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);

    if (existingPhoneUser && existingPhoneUser.organization) {
      // Re-check telegram_id to prevent race condition (TOCTOU)
      // Another request may have linked a different Telegram account between auth check and now
      if (existingPhoneUser.telegram_id && existingPhoneUser.telegram_id !== telegramId) {
        logger.warn(
          "[ElizaAppUserService] Phone user already linked to different Telegram (race)",
          {
            phoneUserId: existingPhoneUser.id,
            existingTelegramId: existingPhoneUser.telegram_id,
            newTelegramId: telegramId,
          },
        );
        throw new Error("PHONE_ALREADY_LINKED");
      }

      // Link Telegram to the existing phone-only user
      try {
        await usersRepository.update(existingPhoneUser.id, {
          telegram_id: telegramId,
          telegram_username: telegramData.username,
          telegram_first_name: telegramData.first_name,
          telegram_photo_url: telegramData.photo_url,
          // Update name if user only had phone-based name like "User ***1234"
          name: existingPhoneUser.name?.startsWith("User ***")
            ? telegramData.last_name
              ? `${telegramData.first_name} ${telegramData.last_name}`
              : telegramData.first_name
            : existingPhoneUser.name,
          updated_at: new Date(),
        });
      } catch (error) {
        // Handle race condition: unique constraint violation on telegram_id
        if (isUniqueConstraintError(error)) {
          logger.warn("[ElizaAppUserService] Race condition on telegram link", {
            telegramId,
            phoneUserId: existingPhoneUser.id,
          });
          throw new Error("PHONE_ALREADY_LINKED");
        }
        throw error;
      }

      logger.info("[ElizaAppUserService] Linked Telegram to existing phone user (iMessage-first)", {
        userId: existingPhoneUser.id,
        telegramId,
        username: telegramData.username,
        phone: `***${normalizedPhone.slice(-4)}`,
      });

      // Refetch to get updated data
      const updatedUser = await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);
      return {
        user: updatedUser!,
        organization: updatedUser!.organization!,
        isNew: false,
      };
    }

    // Scenario 3: Neither exists - create new user with both Telegram and phone
    const displayName = telegramData.last_name
      ? `${telegramData.first_name} ${telegramData.last_name}`
      : telegramData.first_name;

    const organizationName = telegramData.username
      ? `${telegramData.username}'s Workspace`
      : `${telegramData.first_name}'s Workspace`;

    try {
      return await createUserWithOrganization({
        userData: {
          steward_user_id: `telegram:${telegramId}`,
          telegram_id: telegramId,
          telegram_username: telegramData.username,
          telegram_first_name: telegramData.first_name,
          telegram_photo_url: telegramData.photo_url,
          phone_number: normalizedPhone,
          phone_verified: true,
          name: displayName,
          is_anonymous: false,
        },
        organizationName,
        slugGenerator: () => generateSlugFromTelegram(telegramData.username, telegramId),
        signupCode,
      });
    } catch (error) {
      // Handle race condition: another request created the user first
      if (isUniqueConstraintError(error)) {
        // Try to find the user that was created by the other request (by telegram_id)
        const userByTelegram = await usersRepository.findByTelegramIdWithOrganization(telegramId);
        if (userByTelegram && userByTelegram.organization) {
          logger.info("[ElizaAppUserService] Recovered from race condition (telegram)", {
            telegramId,
          });
          return {
            user: userByTelegram,
            organization: userByTelegram.organization,
            isNew: false,
          };
        }

        // Constraint may have been on phone_number (same phone, different Telegram ID)
        const userByPhone =
          await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);
        if (userByPhone && userByPhone.organization) {
          logger.warn("[ElizaAppUserService] Phone already linked by race condition", {
            telegramId,
            phone: `***${normalizedPhone.slice(-4)}`,
          });
          throw new Error("PHONE_ALREADY_LINKED");
        }
      }
      throw error;
    }
  }

  async findOrCreateByPhone(phoneNumber: string): Promise<FindOrCreateResult> {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const existingUser = await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);

    if (existingUser && existingUser.organization) {
      if (!existingUser.phone_verified) {
        await usersRepository.update(existingUser.id, {
          phone_verified: true,
          updated_at: new Date(),
        });
      }
      logger.info("[ElizaAppUserService] Linked phone to existing user (iMessage)", {
        userId: existingUser.id,
        phone: `***${normalizedPhone.slice(-4)}`,
      });
      return {
        user: existingUser,
        organization: existingUser.organization,
        isNew: false,
      };
    }

    const lastFour = normalizedPhone.slice(-4);
    const displayName = `User ***${lastFour}`;
    const organizationName = `User ***${lastFour}'s Workspace`;

    try {
      return await createUserWithOrganization({
        userData: {
          steward_user_id: `phone:${normalizedPhone}`,
          phone_number: normalizedPhone,
          phone_verified: true,
          name: displayName,
          is_anonymous: false,
        },
        organizationName,
        slugGenerator: () => generateSlugFromPhone(normalizedPhone),
      });
    } catch (error) {
      // Handle race condition: another request created the user first
      if (isUniqueConstraintError(error)) {
        const user = await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);
        if (user && user.organization) {
          logger.info("[ElizaAppUserService] Recovered from race condition", {
            phone: `***${normalizedPhone.slice(-2)}`,
          });
          return { user, organization: user.organization, isNew: false };
        }
      }
      throw error;
    }
  }

  /**
   * Find or create user by email (Apple ID).
   * Used for iMessage users who send from their Apple ID email instead of phone.
   * These users can later link their phone via Telegram OAuth for cross-platform.
   */
  async findOrCreateByEmail(email: string): Promise<FindOrCreateResult> {
    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await usersRepository.findByEmailWithOrganization(normalizedEmail);

    if (existingUser && existingUser.organization) {
      logger.info("[ElizaAppUserService] Linked email to existing user (iMessage)", {
        userId: existingUser.id,
        email: maskEmailForLogging(normalizedEmail),
      });
      return {
        user: existingUser,
        organization: existingUser.organization,
        isNew: false,
      };
    }

    // Create display name from email (mask middle part)
    const emailPrefix = normalizedEmail.split("@")[0];
    const maskedPrefix =
      emailPrefix.length > 4
        ? `${emailPrefix.slice(0, 2)}***${emailPrefix.slice(-2)}`
        : `${emailPrefix.slice(0, 1)}***`;
    const displayName = `User ${maskedPrefix}`;
    const organizationName = `${maskedPrefix}'s Workspace`;

    try {
      return await createUserWithOrganization({
        userData: {
          steward_user_id: `email:${normalizedEmail}`,
          email: normalizedEmail,
          email_verified: false, // iMessage delivery doesn't prove email ownership
          name: displayName,
          is_anonymous: false,
        },
        organizationName,
        slugGenerator: () => generateSlugFromEmail(normalizedEmail),
      });
    } catch (error) {
      // Handle race condition: another request created the user first
      if (isUniqueConstraintError(error)) {
        const user = await usersRepository.findByEmailWithOrganization(normalizedEmail);
        if (user && user.organization) {
          logger.info("[ElizaAppUserService] Recovered from race condition (email)", {
            email: maskEmailForLogging(normalizedEmail),
          });
          return { user, organization: user.organization, isNew: false };
        }
      }
      throw error;
    }
  }

  async getById(userId: string): Promise<UserWithOrganization | undefined> {
    return usersRepository.findWithOrganization(userId);
  }

  async getByTelegramId(telegramId: string): Promise<UserWithOrganization | undefined> {
    return usersRepository.findByTelegramIdWithOrganization(telegramId);
  }

  async getByPhoneNumber(phoneNumber: string): Promise<UserWithOrganization | undefined> {
    return usersRepository.findByPhoneNumberWithOrganization(normalizePhoneNumber(phoneNumber));
  }

  async getByEmail(email: string): Promise<UserWithOrganization | undefined> {
    return usersRepository.findByEmailWithOrganization(email.toLowerCase().trim());
  }

  async getByDiscordId(discordId: string): Promise<UserWithOrganization | undefined> {
    return usersRepository.findByDiscordIdWithOrganization(discordId);
  }

  /**
   * Find or create user by Discord ID.
   * Used by Discord OAuth2 flow to provision accounts on first login.
   *
   * Cross-platform linking scenarios:
   * 1. User exists by discord_id → update profile, return existing
   * 2. User exists by phone_number (Telegram/iMessage-first) → link Discord to that user
   * 3. Neither exists → create new user
   *
   * @param phoneNumber Optional phone number for cross-platform linking (step 2)
   */
  async findOrCreateByDiscordId(
    discordId: string,
    discordData: {
      username: string;
      globalName?: string | null;
      avatarUrl?: string | null;
    },
    phoneNumber?: string,
    signupCode?: string,
  ): Promise<FindOrCreateResult> {
    // Validate required fields
    if (!discordId?.trim()) {
      throw new Error("Discord ID is required");
    }
    if (!discordData.username?.trim()) {
      throw new Error("Discord username is required");
    }

    const normalizedPhone = phoneNumber ? normalizePhoneNumber(phoneNumber) : undefined;

    // Scenario 1: Check if user exists by discord_id (returning Discord user)
    const existingUser = await usersRepository.findByDiscordIdWithOrganization(discordId);

    if (existingUser && existingUser.organization) {
      // Update Discord profile data if changed (non-critical - graceful degradation)
      const updates: Partial<NewUser> = {};
      let needsUpdate = false;

      if (discordData.username && discordData.username !== existingUser.discord_username) {
        updates.discord_username = discordData.username;
        needsUpdate = true;
      }
      if (
        discordData.globalName !== undefined &&
        discordData.globalName !== existingUser.discord_global_name
      ) {
        updates.discord_global_name = discordData.globalName || undefined;
        needsUpdate = true;
      }
      if (
        discordData.avatarUrl !== undefined &&
        discordData.avatarUrl !== existingUser.discord_avatar_url
      ) {
        updates.discord_avatar_url = discordData.avatarUrl || undefined;
        needsUpdate = true;
      }

      // Also set phone number if provided and not already set
      if (normalizedPhone && !existingUser.phone_number) {
        const phoneOwner = await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);
        if (phoneOwner && phoneOwner.id !== existingUser.id) {
          logger.warn("[ElizaAppUserService] Phone already owned by another user", {
            discordUserId: existingUser.id,
            phoneOwnerId: phoneOwner.id,
            phone: `***${normalizedPhone.slice(-4)}`,
          });
          throw new Error("PHONE_ALREADY_LINKED");
        }
        updates.phone_number = normalizedPhone;
        updates.phone_verified = true;
        needsUpdate = true;
      }

      if (needsUpdate) {
        try {
          updates.updated_at = new Date();
          await usersRepository.update(existingUser.id, updates);
          logger.info("[ElizaAppUserService] Updated Discord user profile", {
            userId: existingUser.id,
            discordId,
            phoneAdded: !!normalizedPhone && !existingUser.phone_number,
          });
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            // Phone unique constraint hit - another user has this phone
            if (normalizedPhone) {
              throw new Error("PHONE_ALREADY_LINKED");
            }
          }
          // Profile update is non-critical - log warning and continue with stale data
          logger.warn(
            "[ElizaAppUserService] Failed to update Discord profile, continuing with stale data",
            {
              userId: existingUser.id,
              discordId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }

      // Refetch if we updated phone
      if (normalizedPhone && !existingUser.phone_number) {
        const refetched = await usersRepository.findByDiscordIdWithOrganization(discordId);
        if (refetched && refetched.organization) {
          return {
            user: refetched,
            organization: refetched.organization,
            isNew: false,
          };
        }
      }

      return {
        user: existingUser,
        organization: existingUser.organization,
        isNew: false,
      };
    }

    // Scenario 2: Check if user exists by phone_number (Telegram/iMessage-first user linking Discord)
    if (normalizedPhone) {
      const existingPhoneUser =
        await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);

      if (existingPhoneUser && existingPhoneUser.organization) {
        // Re-check discord_id to prevent race condition (TOCTOU)
        if (existingPhoneUser.discord_id && existingPhoneUser.discord_id !== discordId) {
          logger.warn(
            "[ElizaAppUserService] Phone user already linked to different Discord (race)",
            {
              phoneUserId: existingPhoneUser.id,
              existingDiscordId: existingPhoneUser.discord_id,
              newDiscordId: discordId,
            },
          );
          throw new Error("DISCORD_ALREADY_LINKED");
        }

        // Link Discord to the existing phone-based user
        try {
          await usersRepository.update(existingPhoneUser.id, {
            discord_id: discordId,
            discord_username: discordData.username,
            discord_global_name: discordData.globalName || undefined,
            discord_avatar_url: discordData.avatarUrl || undefined,
            updated_at: new Date(),
          });
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            logger.warn("[ElizaAppUserService] Race condition on discord link", {
              discordId,
              phoneUserId: existingPhoneUser.id,
            });
            throw new Error("DISCORD_ALREADY_LINKED");
          }
          throw error;
        }

        logger.info(
          "[ElizaAppUserService] Linked Discord to existing phone user (cross-platform)",
          {
            userId: existingPhoneUser.id,
            discordId,
            username: discordData.username,
            phone: `***${normalizedPhone.slice(-4)}`,
          },
        );

        // Refetch to get updated data
        const updatedUser =
          await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);
        return {
          user: updatedUser!,
          organization: updatedUser!.organization!,
          isNew: false,
        };
      }
    }

    // Scenario 3: Neither exists - create new user with Discord identity
    const displayName = discordData.globalName || discordData.username;
    const organizationName = `${displayName}'s Workspace`;

    try {
      return await createUserWithOrganization({
        userData: {
          steward_user_id: `discord:${discordId}`,
          discord_id: discordId,
          discord_username: discordData.username,
          discord_global_name: discordData.globalName || undefined,
          discord_avatar_url: discordData.avatarUrl || undefined,
          ...(normalizedPhone && {
            phone_number: normalizedPhone,
            phone_verified: true,
          }),
          name: displayName,
          is_anonymous: false,
        },
        organizationName,
        slugGenerator: () => generateSlugFromDiscord(discordData.username, discordId),
        signupCode,
      });
    } catch (error) {
      // Handle race condition: another request created the user first
      if (isUniqueConstraintError(error)) {
        const user = await usersRepository.findByDiscordIdWithOrganization(discordId);
        if (user && user.organization) {
          logger.info("[ElizaAppUserService] Recovered from race condition (discord)", {
            discordId,
          });
          return { user, organization: user.organization, isNew: false };
        }

        // Constraint may have been on phone_number
        if (normalizedPhone) {
          const userByPhone =
            await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);
          if (userByPhone && userByPhone.organization) {
            logger.warn("[ElizaAppUserService] Phone already linked by race condition", {
              discordId,
              phone: `***${normalizedPhone.slice(-4)}`,
            });
            throw new Error("PHONE_ALREADY_LINKED");
          }
        }
      }
      throw error;
    }
  }

  /**
   * Update Discord profile for an existing user.
   */
  async updateDiscordProfile(
    userId: string,
    discordData: {
      username?: string;
      globalName?: string | null;
      avatarUrl?: string | null;
    },
  ): Promise<void> {
    const updates: Partial<NewUser> = { updated_at: new Date() };

    if (discordData.username !== undefined) {
      updates.discord_username = discordData.username;
    }
    if (discordData.globalName !== undefined) {
      updates.discord_global_name = discordData.globalName || undefined;
    }
    if (discordData.avatarUrl !== undefined) {
      updates.discord_avatar_url = discordData.avatarUrl || undefined;
    }

    await usersRepository.update(userId, updates);
    logger.info("[ElizaAppUserService] Updated Discord profile", { userId });
  }

  /**
   * Look up user by phone number OR email.
   * Detects which type of identifier was provided based on format.
   * Used by Blooio webhook since iMessage can identify users by either phone or Apple ID email.
   */
  async getByPhoneOrEmail(identifier: string): Promise<UserWithOrganization | undefined> {
    const trimmed = identifier.trim();

    // If it contains @, treat as email
    if (trimmed.includes("@")) {
      return this.getByEmail(trimmed);
    }

    // Otherwise treat as phone number
    return this.getByPhoneNumber(trimmed);
  }

  async updateUser(userId: string, data: Partial<NewUser>): Promise<User | undefined> {
    return usersRepository.update(userId, {
      ...data,
      updated_at: new Date(),
    });
  }

  async linkPhoneToUser(
    userId: string,
    phoneNumber: string,
  ): Promise<{ success: boolean; error?: string }> {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const existingPhoneUser =
      await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);

    if (existingPhoneUser) {
      if (existingPhoneUser.id === userId) {
        return { success: true };
      }
      logger.warn("[ElizaAppUserService] Phone already linked to another user", {
        userId,
        existingUserId: existingPhoneUser.id,
        phone: `***${normalizedPhone.slice(-2)}`,
      });
      return {
        success: false,
        error: "This phone number is already linked to another account",
      };
    }

    try {
      await usersRepository.update(userId, {
        phone_number: normalizedPhone,
        phone_verified: true,
        updated_at: new Date(),
      });
    } catch (error) {
      // Handle race condition: another request linked this phone first
      if (isUniqueConstraintError(error)) {
        logger.warn("[ElizaAppUserService] Phone linking race condition", {
          userId,
          phone: `***${normalizedPhone.slice(-2)}`,
        });
        return {
          success: false,
          error: "This phone number is already linked to another account",
        };
      }
      throw error;
    }

    logger.info("[ElizaAppUserService] Linked phone to user", {
      userId,
      phone: `***${normalizedPhone.slice(-2)}`,
    });

    return { success: true };
  }

  /**
   * Link an email (e.g., Apple ID) to a user account.
   * Used for iMessage support where users may message from their Apple ID email.
   */
  async linkEmailToUser(
    userId: string,
    email: string,
  ): Promise<{ success: boolean; error?: string }> {
    const normalizedEmail = email.toLowerCase().trim();

    // Email validation using shared utility
    if (!isValidEmail(normalizedEmail)) {
      return { success: false, error: "Invalid email format" };
    }

    const existingEmailUser = await usersRepository.findByEmailWithOrganization(normalizedEmail);

    if (existingEmailUser) {
      if (existingEmailUser.id === userId) {
        return { success: true };
      }
      logger.warn("[ElizaAppUserService] Email already linked to another user", {
        userId,
        existingUserId: existingEmailUser.id,
        email: maskEmailForLogging(normalizedEmail), // Mask for logs
      });
      return {
        success: false,
        error: "This email is already linked to another account",
      };
    }

    try {
      await usersRepository.update(userId, {
        email: normalizedEmail,
        email_verified: false, // Not verified until user confirms via email link
        updated_at: new Date(),
      });
    } catch (error) {
      // Handle race condition: another request linked this email first
      if (isUniqueConstraintError(error)) {
        logger.warn("[ElizaAppUserService] Email linking race condition", {
          userId,
          email: maskEmailForLogging(normalizedEmail),
        });
        return {
          success: false,
          error: "This email is already linked to another account",
        };
      }
      throw error;
    }

    logger.info("[ElizaAppUserService] Linked email to user", {
      userId,
      email: maskEmailForLogging(normalizedEmail),
    });

    return { success: true };
  }

  async linkTelegramToUser(
    userId: string,
    telegramData: TelegramAuthData,
  ): Promise<{ success: boolean; error?: string }> {
    const telegramId = String(telegramData.id);
    const existingTelegramUser = await usersRepository.findByTelegramIdWithOrganization(telegramId);

    if (existingTelegramUser && existingTelegramUser.id !== userId) {
      logger.warn("[ElizaAppUserService] Telegram already linked to another user", {
        userId,
        existingUserId: existingTelegramUser.id,
        telegramId,
      });
      return {
        success: false,
        error: "This Telegram account is already linked to another account",
      };
    }

    try {
      await usersRepository.update(userId, {
        telegram_id: telegramId,
        telegram_username: telegramData.username,
        telegram_first_name: telegramData.first_name,
        telegram_photo_url: telegramData.photo_url,
        updated_at: new Date(),
      });
    } catch (error) {
      // Handle race condition: another request linked this Telegram first
      if (isUniqueConstraintError(error)) {
        logger.warn("[ElizaAppUserService] Telegram linking race condition", {
          userId,
          telegramId,
        });
        return {
          success: false,
          error: "This Telegram account is already linked to another account",
        };
      }
      throw error;
    }

    logger.info("[ElizaAppUserService] Linked Telegram to user", {
      userId,
      telegramId,
      username: telegramData.username,
    });

    return { success: true };
  }

  /**
   * Link a Discord account to an existing user.
   * Used for session-based linking (user already authenticated via another platform).
   * Mirrors linkTelegramToUser pattern.
   */
  async linkDiscordToUser(
    userId: string,
    discordData: {
      discordId: string;
      username: string;
      globalName?: string | null;
      avatarUrl?: string | null;
    },
  ): Promise<{ success: boolean; error?: string }> {
    const { discordId, username, globalName, avatarUrl } = discordData;

    // Check if this Discord ID is already linked to a different user
    const existingDiscordUser = await usersRepository.findByDiscordIdWithOrganization(discordId);

    if (existingDiscordUser && existingDiscordUser.id !== userId) {
      logger.warn("[ElizaAppUserService] Discord already linked to another user", {
        userId,
        existingUserId: existingDiscordUser.id,
        discordId,
      });
      return {
        success: false,
        error: "This Discord account is already linked to another account",
      };
    }

    // If already linked to the same user, treat as idempotent success
    if (existingDiscordUser && existingDiscordUser.id === userId) {
      return { success: true };
    }

    try {
      await usersRepository.update(userId, {
        discord_id: discordId,
        discord_username: username,
        discord_global_name: globalName || undefined,
        discord_avatar_url: avatarUrl || undefined,
        updated_at: new Date(),
      });
    } catch (error) {
      // Handle race condition: another request linked this Discord account first
      if (isUniqueConstraintError(error)) {
        logger.warn("[ElizaAppUserService] Discord linking race condition", {
          userId,
          discordId,
        });
        return {
          success: false,
          error: "This Discord account is already linked to another account",
        };
      }
      throw error;
    }

    logger.info("[ElizaAppUserService] Linked Discord to user", {
      userId,
      discordId,
      username,
    });

    return { success: true };
  }

  // ============================================================================
  // WhatsApp Methods
  // ============================================================================

  /**
   * Find or create user by WhatsApp ID.
   * Used by WhatsApp webhook to auto-provision users on first message.
   *
   * Cross-platform linking scenarios:
   * 1. User exists by whatsapp_id → update profile name, return existing
   * 2. User exists by phone_number (Telegram/iMessage-first) → link WhatsApp to that user
   * 3. Neither exists → create new user with whatsapp_id + auto-derived phone_number
   *
   * Since WhatsApp ID IS a phone number (digits only), we auto-derive phone_number
   * by prepending "+". This means cross-platform linking happens automatically.
   */
  async findOrCreateByWhatsAppId(
    whatsappId: string,
    profileName?: string,
  ): Promise<FindOrCreateResult> {
    // Auto-derive E.164 phone number from WhatsApp ID
    const derivedPhone = `+${whatsappId.replace(/\D/g, "")}`;

    // Scenario 1: Check if user exists by whatsapp_id (returning WhatsApp user)
    const existingWhatsAppUser = await usersRepository.findByWhatsAppIdWithOrganization(whatsappId);

    if (existingWhatsAppUser && existingWhatsAppUser.organization) {
      // Update WhatsApp profile name if changed
      if (profileName && profileName !== existingWhatsAppUser.whatsapp_name) {
        try {
          await usersRepository.update(existingWhatsAppUser.id, {
            whatsapp_name: profileName,
            updated_at: new Date(),
          });
        } catch (error) {
          // Non-critical - log warning and continue with stale data
          logger.warn("[ElizaAppUserService] Failed to update WhatsApp name", {
            userId: existingWhatsAppUser.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info("[ElizaAppUserService] Found existing WhatsApp user", {
        userId: existingWhatsAppUser.id,
        whatsappId,
      });

      return {
        user: existingWhatsAppUser,
        organization: existingWhatsAppUser.organization,
        isNew: false,
      };
    }

    // Scenario 2: Check if user exists by phone_number (Telegram/iMessage-first user)
    const existingPhoneUser = await usersRepository.findByPhoneNumberWithOrganization(derivedPhone);

    if (existingPhoneUser && existingPhoneUser.organization) {
      // Re-check whatsapp_id to prevent race condition (TOCTOU)
      if (existingPhoneUser.whatsapp_id && existingPhoneUser.whatsapp_id !== whatsappId) {
        logger.warn(
          "[ElizaAppUserService] Phone user already linked to different WhatsApp (race)",
          {
            phoneUserId: existingPhoneUser.id,
            existingWhatsAppId: existingPhoneUser.whatsapp_id,
            newWhatsAppId: whatsappId,
          },
        );
        throw new Error("WHATSAPP_ALREADY_LINKED");
      }

      // Link WhatsApp to the existing phone-based user
      try {
        await usersRepository.update(existingPhoneUser.id, {
          whatsapp_id: whatsappId,
          whatsapp_name: profileName,
          updated_at: new Date(),
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          logger.warn("[ElizaAppUserService] Race condition on whatsapp link", {
            whatsappId,
            phoneUserId: existingPhoneUser.id,
          });
          throw new Error("WHATSAPP_ALREADY_LINKED");
        }
        throw error;
      }

      logger.info("[ElizaAppUserService] Linked WhatsApp to existing phone user (cross-platform)", {
        userId: existingPhoneUser.id,
        whatsappId,
        phone: `***${derivedPhone.slice(-4)}`,
      });

      // Refetch to get updated data
      const updatedUser = await usersRepository.findByPhoneNumberWithOrganization(derivedPhone);
      return {
        user: updatedUser!,
        organization: updatedUser!.organization!,
        isNew: false,
      };
    }

    // Scenario 3: Neither exists - create new user with WhatsApp ID + auto-derived phone
    const displayName = profileName || `WhatsApp ***${whatsappId.slice(-4)}`;
    const organizationName = `${displayName}'s Workspace`;

    try {
      return await createUserWithOrganization({
        userData: {
          steward_user_id: `whatsapp:${whatsappId}`,
          whatsapp_id: whatsappId,
          whatsapp_name: profileName,
          phone_number: derivedPhone,
          phone_verified: true, // WhatsApp verifies phone numbers
          name: displayName,
          is_anonymous: false,
        },
        organizationName,
        slugGenerator: () => generateSlugFromWhatsApp(whatsappId),
      });
    } catch (error) {
      // Handle race condition: another request created the user first
      if (isUniqueConstraintError(error)) {
        // Try to find the user that was created by the other request (by whatsapp_id)
        const userByWhatsApp = await usersRepository.findByWhatsAppIdWithOrganization(whatsappId);
        if (userByWhatsApp && userByWhatsApp.organization) {
          logger.info("[ElizaAppUserService] Recovered from race condition (whatsapp)", {
            whatsappId,
          });
          return {
            user: userByWhatsApp,
            organization: userByWhatsApp.organization,
            isNew: false,
          };
        }

        // Constraint may have been on phone_number (same phone, different WhatsApp ID)
        const userByPhone = await usersRepository.findByPhoneNumberWithOrganization(derivedPhone);
        if (userByPhone && userByPhone.organization) {
          logger.warn("[ElizaAppUserService] Phone already linked by race condition (whatsapp)", {
            whatsappId,
            phone: `***${derivedPhone.slice(-4)}`,
          });
          throw new Error("PHONE_ALREADY_LINKED");
        }
      }
      throw error;
    }
  }

  async getByWhatsAppId(whatsappId: string): Promise<UserWithOrganization | undefined> {
    return usersRepository.findByWhatsAppIdWithOrganization(whatsappId);
  }

  /**
   * Link a WhatsApp account to an existing user.
   * Used for session-based linking.
   */
  async linkWhatsAppToUser(
    userId: string,
    whatsappData: {
      whatsappId: string;
      name?: string;
    },
  ): Promise<{ success: boolean; error?: string }> {
    const { whatsappId, name } = whatsappData;

    // Check if this WhatsApp ID is already linked to a different user
    const existingWhatsAppUser = await usersRepository.findByWhatsAppIdWithOrganization(whatsappId);

    if (existingWhatsAppUser && existingWhatsAppUser.id !== userId) {
      logger.warn("[ElizaAppUserService] WhatsApp already linked to another user", {
        userId,
        existingUserId: existingWhatsAppUser.id,
        whatsappId,
      });
      return {
        success: false,
        error: "This WhatsApp account is already linked to another account",
      };
    }

    // If already linked to the same user, treat as idempotent success
    if (existingWhatsAppUser && existingWhatsAppUser.id === userId) {
      return { success: true };
    }

    try {
      await usersRepository.update(userId, {
        whatsapp_id: whatsappId,
        whatsapp_name: name,
        updated_at: new Date(),
      });
    } catch (error) {
      // Handle race condition: another request linked this WhatsApp account first
      if (isUniqueConstraintError(error)) {
        logger.warn("[ElizaAppUserService] WhatsApp linking race condition", {
          userId,
          whatsappId,
        });
        return {
          success: false,
          error: "This WhatsApp account is already linked to another account",
        };
      }
      throw error;
    }

    logger.info("[ElizaAppUserService] Linked WhatsApp to user", {
      userId,
      whatsappId,
    });

    return { success: true };
  }
}

export const elizaAppUserService = new ElizaAppUserService();
