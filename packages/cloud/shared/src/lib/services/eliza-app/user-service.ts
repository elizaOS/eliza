/**
 * Eliza App User Service
 *
 * Manages user accounts for Eliza App authentication.
 * Primary auth: Telegram OAuth + phone number (entered by user in frontend).
 * Auto-creates $0 organizations for new users. Shared access is independent of
 * paid credits; explicit promotion codes and purchased top-ups remain separate.
 *
 * Cross-platform support:
 * - Telegram bot: lookup by telegram_id
 * - iMessage: lookup by phone_number (same phone entered during Telegram OAuth)
 */

import { organizationsRepository } from "../../../db/repositories/organizations";
import { type UserWithOrganization, usersRepository } from "../../../db/repositories/users";
import type { Organization } from "../../../db/schemas/organizations";
import type { NewUser, User } from "../../../db/schemas/users";
import { SIGNUP_CREDIT_POLICY } from "../../signup-credits";
import { isUniqueConstraintError } from "../../utils/db-errors";
import { isValidEmail, maskEmailForLogging } from "../../utils/email-validation";
import { logger } from "../../utils/logger";
import { isValidE164, normalizePhoneNumber } from "../../utils/phone-normalization";
import { apiKeysService } from "../api-keys";
import { redeemSignupCode } from "../signup-code";
import type { TelegramAuthData } from "./telegram-auth";

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
    credit_balance: SIGNUP_CREDIT_POLICY.openingBalanceUsd,
  });

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
   * Resolves Telegram's verified sender directly into the rowless personal
   * service. This path starts at $0 and never creates an API key or sandbox;
   * a later phone/Steward sign-in promotes this same user and organization.
   */
  async findOrCreateByTelegram(params: {
    telegramId: string;
    username?: string;
    firstName?: string;
    displayName?: string;
  }): Promise<FindOrCreateResult> {
    const telegramId = params.telegramId.trim();
    if (!/^\d{1,20}$/.test(telegramId)) {
      throw new Error("Trusted Telegram transport supplied an invalid sender id");
    }
    const displayName =
      params.displayName?.trim() ||
      params.firstName?.trim() ||
      params.username?.trim() ||
      "Eliza user";
    const result = await usersRepository.findOrCreateTelegramPersonalAccount({
      telegramId,
      telegramUsername: params.username?.trim() || undefined,
      telegramFirstName: params.firstName?.trim() || undefined,
      displayName,
      organizationName: `${displayName}'s Workspace`,
      organizationSlug: generateSlugFromTelegram(params.username, telegramId),
    });
    logger.info(
      result.isNew
        ? "[ElizaAppUserService] Created Telegram personal account"
        : "[ElizaAppUserService] Reused Telegram personal account",
      {
        userId: result.user.id,
        organizationId: result.organization.id,
        telegramId,
      },
    );
    return result;
  }

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
      const linked = await usersRepository.linkTelegramAndPhoneIdentity(existingTelegramUser.id, {
        telegram_id: telegramId,
        telegram_username: telegramData.username,
        telegram_first_name: telegramData.first_name,
        telegram_photo_url: telegramData.photo_url,
        phone_number: normalizedPhone,
      });
      if (linked.status === "phone_mismatch") throw new Error("PHONE_MISMATCH");
      if (linked.status !== "linked") throw new Error("TELEGRAM_USER_NOT_FOUND");

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

      try {
        const linked = await usersRepository.linkTelegramAndPhoneIdentity(existingPhoneUser.id, {
          telegram_id: telegramId,
          telegram_username: telegramData.username,
          telegram_first_name: telegramData.first_name,
          telegram_photo_url: telegramData.photo_url,
          phone_number: normalizedPhone,
        });
        if (linked.status !== "linked") throw new Error("PHONE_ALREADY_LINKED");
        if (existingPhoneUser.name?.startsWith("User ***")) {
          await usersRepository.update(existingPhoneUser.id, {
            name: telegramData.last_name
              ? `${telegramData.first_name} ${telegramData.last_name}`
              : telegramData.first_name,
          });
        }
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
    if (!isValidE164(normalizedPhone)) {
      throw new Error("Trusted phone transport supplied an invalid phone number");
    }

    const lastFour = normalizedPhone.slice(-4);
    const displayName = `User ***${lastFour}`;
    const organizationName = `User ***${lastFour}'s Workspace`;
    const result = await usersRepository.findOrCreatePhonePersonalAccount({
      phoneNumber: normalizedPhone,
      displayName,
      organizationName,
      organizationSlug: generateSlugFromPhone(normalizedPhone),
    });
    logger.info(
      result.isNew
        ? "[ElizaAppUserService] Created phone-first personal account"
        : "[ElizaAppUserService] Reused phone-first personal account",
      {
        userId: result.user.id,
        organizationId: result.organization.id,
        phone: `***${normalizedPhone.slice(-4)}`,
      },
    );
    return result;
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

  async getByIdForWrite(userId: string): Promise<UserWithOrganization | undefined> {
    return usersRepository.findWithOrganizationForWrite(userId);
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
          // A phone link is a tenant-identity write, not a cosmetic refresh. When this
          // update is adding a phone, a unique constraint means another account owns it
          // (surface the conflict) and any other failure must propagate — swallowing it
          // would return success while the refetch below reads back as "no phone".
          const linkingPhone = !!normalizedPhone && !existingUser.phone_number;
          if (linkingPhone) {
            if (isUniqueConstraintError(error)) {
              throw new Error("PHONE_ALREADY_LINKED");
            }
            throw error;
          }
          // error-policy:J4 cosmetic Discord profile refresh (username/global name/avatar)
          // is best-effort; a stale display field degrades gracefully rather than block login.
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

    // A canonical-only Discord link (users.discord_id written before the
    // projection refresh existed) is invisible to the projection-based lookup
    // above AND to inbound Discord routing. Converge it before treating the
    // Discord id as new: without this, a legacy Discord user gets a second
    // account instead of their existing one.
    const canonicalOnlyUser =
      await usersRepository.findByCanonicalDiscordIdWithOrganization(discordId);
    if (canonicalOnlyUser && canonicalOnlyUser.organization) {
      await usersRepository.refreshDiscordProjectionForWrite(canonicalOnlyUser.id);
      return {
        user: canonicalOnlyUser,
        organization: canonicalOnlyUser.organization,
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

        // Project the canonical link into user_identities for Discord routing.
        await usersRepository.refreshDiscordProjectionForWrite(existingPhoneUser.id);

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
      const created = await createUserWithOrganization({
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
      // Project the new canonical Discord identity into user_identities — the
      // row inbound Discord routing resolves DM senders by. Without it a fresh
      // Discord-OAuth signup can never receive DM replies from their agent.
      await usersRepository.refreshDiscordProjectionForWrite(created.user.id);
      return created;
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
      const linked = await usersRepository.linkVerifiedPhone(userId, normalizedPhone);
      if (!linked) {
        throw new Error(`User ${userId} was not found while linking a phone`);
      }
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
   * Links the Telegram and phone identities through one repository transaction
   * so a uniqueness race cannot split the canonical row from its projection.
   * Refuses to overwrite a different already-verified phone number.
   */
  async linkTelegramAndPhoneToUser(
    userId: string,
    telegramData: TelegramAuthData,
    phoneNumber: string,
  ): Promise<{ success: boolean; error?: string }> {
    const telegramId = String(telegramData.id);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    try {
      const result = await usersRepository.linkTelegramAndPhoneIdentity(userId, {
        telegram_id: telegramId,
        telegram_username: telegramData.username,
        telegram_first_name: telegramData.first_name,
        telegram_photo_url: telegramData.photo_url,
        phone_number: normalizedPhone,
      });
      if (result.status === "user_not_found") {
        return { success: false, error: "The account no longer exists" };
      }
      if (result.status === "phone_mismatch") {
        logger.warn("[ElizaAppUserService] Refused to overwrite a different verified phone", {
          userId,
          telegramId,
          existingPhone: `***${result.existingPhone.slice(-2)}`,
          requestedPhone: `***${normalizedPhone.slice(-2)}`,
        });
        return {
          success: false,
          error: "This account already has a different verified phone number linked",
        };
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        logger.warn("[ElizaAppUserService] Telegram or phone linking race condition", {
          userId,
          telegramId,
          phone: `***${normalizedPhone.slice(-2)}`,
        });
        return {
          success: false,
          error: "This Telegram account or phone number is already linked to another account",
        };
      }
      throw error;
    }

    logger.info("[ElizaAppUserService] Linked Telegram and phone to user", {
      userId,
      telegramId,
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
    telegramData: {
      id: string | number;
      username?: string;
      first_name?: string;
      photo_url?: string;
    },
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
      // Atomic canonical + userIdentities projection write: the Telegram
      // gateway resolves inbound DMs through the projection
      // (findByTelegramIdWithOrganization), so a canonical-only update would
      // report success while DM routing still cannot see the link.
      const linked = await usersRepository.linkTelegramIdentity(userId, {
        telegram_id: telegramId,
        telegram_username: telegramData.username,
        telegram_first_name: telegramData.first_name,
        telegram_photo_url: telegramData.photo_url,
      });
      if (!linked) return { success: false, error: "User account was not found" };
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

    try {
      const linked = await usersRepository.linkDiscordIdentity(userId, {
        discord_id: discordId,
        discord_username: username,
        discord_global_name: globalName ?? null,
        discord_avatar_url: avatarUrl ?? null,
      });
      if (!linked) return { success: false, error: "User account was not found" };
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
          // error-policy:J4 cosmetic WhatsApp display-name refresh is best-effort; a
          // stale name degrades gracefully rather than block message handling.
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
