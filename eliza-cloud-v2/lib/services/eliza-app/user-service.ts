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

import { usersRepository, type UserWithOrganization } from "@/db/repositories/users";
import { organizationsRepository } from "@/db/repositories/organizations";
import { creditsService } from "@/lib/services/credits";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import { normalizePhoneNumber } from "@/lib/utils/phone-normalization";
import { isValidEmail, maskEmailForLogging } from "@/lib/utils/email-validation";
import type { TelegramAuthData } from "./telegram-auth";
import type { User, NewUser } from "@/db/schemas/users";
import type { Organization } from "@/db/schemas/organizations";

const ELIZA_APP_INITIAL_CREDITS = 1.0;

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Error) {
    // PostgreSQL unique violation error code
    return error.message.includes("unique constraint") ||
           error.message.includes("duplicate key") ||
           (error as { code?: string }).code === "23505";
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
  const prefix = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `email-${prefix}-${timestamp}${random}`;
}

async function ensureUniqueSlug(
  generateFn: () => string,
  maxAttempts = 10,
): Promise<string> {
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
}): Promise<FindOrCreateResult> {
  const { userData, organizationName, slugGenerator } = params;
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
    phoneNumber: string
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
    const existingPhoneUser = await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);

    if (existingPhoneUser && existingPhoneUser.organization) {
      // Re-check telegram_id to prevent race condition (TOCTOU)
      // Another request may have linked a different Telegram account between auth check and now
      if (existingPhoneUser.telegram_id && existingPhoneUser.telegram_id !== telegramId) {
        logger.warn("[ElizaAppUserService] Phone user already linked to different Telegram (race)", {
          phoneUserId: existingPhoneUser.id,
          existingTelegramId: existingPhoneUser.telegram_id,
          newTelegramId: telegramId,
        });
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
            ? (telegramData.last_name
                ? `${telegramData.first_name} ${telegramData.last_name}`
                : telegramData.first_name)
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
          return { user: userByTelegram, organization: userByTelegram.organization, isNew: false };
        }

        // Constraint may have been on phone_number (same phone, different Telegram ID)
        const userByPhone = await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);
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
      return { user: existingUser, organization: existingUser.organization, isNew: false };
    }

    const lastFour = normalizedPhone.slice(-4);
    const displayName = `User ***${lastFour}`;
    const organizationName = `User ***${lastFour}'s Workspace`;

    try {
      return await createUserWithOrganization({
        userData: {
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
      return { user: existingUser, organization: existingUser.organization, isNew: false };
    }

    // Create display name from email (mask middle part)
    const emailPrefix = normalizedEmail.split("@")[0];
    const maskedPrefix = emailPrefix.length > 4
      ? `${emailPrefix.slice(0, 2)}***${emailPrefix.slice(-2)}`
      : `${emailPrefix.slice(0, 1)}***`;
    const displayName = `User ${maskedPrefix}`;
    const organizationName = `${maskedPrefix}'s Workspace`;

    try {
      return await createUserWithOrganization({
        userData: {
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
    phoneNumber: string
  ): Promise<{ success: boolean; error?: string }> {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const existingPhoneUser = await usersRepository.findByPhoneNumberWithOrganization(normalizedPhone);

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
    email: string
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
    telegramData: TelegramAuthData
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
}

export const elizaAppUserService = new ElizaAppUserService();
