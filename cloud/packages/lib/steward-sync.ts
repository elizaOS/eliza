/**
 * Steward User Synchronization
 *
 * Resolves a Steward JWT to an eliza-cloud user.
 *
 * 1. Steward JWTs contain email/userId/walletAddress directly (no third-party API call)
 * 2. No anonymous user upgrade path (Steward doesn't have anonymous users)
 * 3. Uses steward_user_id as the canonical external auth identity
 */

import { organizationInvitesRepository } from "@/db/repositories/organization-invites";
import { usersRepository } from "@/db/repositories/users";
import { apiKeysService } from "@/lib/services/api-keys";
import { charactersService } from "@/lib/services/characters/characters";
import { creditsService } from "@/lib/services/credits";
import { discordService } from "@/lib/services/discord";
import { emailService } from "@/lib/services/email";
import { invitesService } from "@/lib/services/invites";
import { organizationsService } from "@/lib/services/organizations";
import { usersService } from "@/lib/services/users";
import type { UserWithOrganization } from "@/lib/types";
import { getDefaultElizaCharacterData } from "@/lib/utils/default-eliza-character";
import { getRandomUserAvatar } from "@/lib/utils/default-user-avatar";
import { logger } from "@/lib/utils/logger";

const DEFAULT_INITIAL_CREDITS = 5.0;
const getInitialCredits = (): number => {
  const envValue = process.env.INITIAL_FREE_CREDITS;
  if (envValue) {
    const parsed = parseFloat(envValue);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_INITIAL_CREDITS;
};

const STEWARD_IDENTITY_UNIQUE_CONSTRAINT = "user_identities_steward_user_id_unique";

function extractErrorMetadata(candidate: unknown): {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
} {
  if (!candidate || typeof candidate !== "object") {
    return { message: String(candidate ?? "") };
  }

  const typedCandidate = candidate as {
    code?: unknown;
    constraint?: unknown;
    detail?: unknown;
    message?: unknown;
  };

  return {
    code: typeof typedCandidate.code === "string" ? typedCandidate.code : undefined,
    constraint:
      typeof typedCandidate.constraint === "string" ? typedCandidate.constraint : undefined,
    detail: typeof typedCandidate.detail === "string" ? typedCandidate.detail : undefined,
    message:
      typeof typedCandidate.message === "string" ? typedCandidate.message : String(candidate),
  };
}

function isRecoverableStewardProjectionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const errorMetadata = extractErrorMetadata(error);
  const causeMetadata = "cause" in error ? extractErrorMetadata(error.cause) : { message: "" };
  const isUniqueViolation = errorMetadata.code === "23505" || causeMetadata.code === "23505";
  const hasExactStewardConstraint =
    errorMetadata.constraint === STEWARD_IDENTITY_UNIQUE_CONSTRAINT ||
    causeMetadata.constraint === STEWARD_IDENTITY_UNIQUE_CONSTRAINT;

  return isUniqueViolation && hasExactStewardConstraint;
}

async function recoverCanonicalStewardUser(
  expectedUserId: string,
  stewardUserId: string,
  context: "invite" | "signup",
  error: unknown,
): Promise<boolean> {
  if (!isRecoverableStewardProjectionConflict(error)) {
    return false;
  }

  const projection = await usersService.getStewardIdentityForWrite(stewardUserId);
  if (!projection || projection.user_id !== expectedUserId) {
    return false;
  }

  const user = await usersService.getByStewardIdForWrite(stewardUserId);
  if (!user || user.id !== expectedUserId) {
    return false;
  }

  logger.warn("[StewardSync] Recovered from stale Steward identity projection conflict", {
    context,
    expectedUserId,
    stewardUserId,
    error: error instanceof Error ? error.message : String(error),
  });

  return true;
}

async function rollbackCreatedUserSafely(
  userId: string,
  context: "invite" | "signup",
  originalError: unknown,
): Promise<void> {
  try {
    await usersRepository.delete(userId);
  } catch (rollbackError) {
    logger.error("[StewardSync] Failed to roll back newly created user", {
      context,
      userId,
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    });
  }
}

async function restorePreviousStewardUserIdSafely(
  userId: string,
  previousStewardUserId: string,
  originalError: unknown,
): Promise<void> {
  try {
    await usersService.update(userId, {
      steward_user_id: previousStewardUserId,
      updated_at: new Date(),
    });
  } catch (rollbackError) {
    logger.error("[StewardSync] Failed to restore previous Steward user ID", {
      userId,
      previousStewardUserId,
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    });
  }
}

/**
 * Generates a unique organization slug from an email address.
 */
function generateSlugFromEmail(email: string): string {
  const username = email.split("@")[0];
  const sanitized = username.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `${sanitized}-${timestamp}${random}`;
}

/**
 * Generates a unique organization slug from a wallet address.
 */
function generateSlugFromWallet(walletAddress: string): string {
  const shortAddress = walletAddress.substring(0, 8);
  const sanitized = shortAddress.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `wallet-${sanitized}-${timestamp}${random}`;
}

export interface StewardSyncParams {
  stewardUserId: string;
  email?: string;
  walletAddress?: string;
  walletChainType?: "ethereum" | "solana";
  name?: string;
}

/**
 * Sync a Steward user to the local database.
 * Creates user and organization if they don't exist.
 * Updates user data if it has changed.
 *
 * Flow:
 * 1. Check if user exists by steward_user_id -> return existing (update if needed)
 * 2. Check for pending invite by email -> accept invite, create user in that org
 * 3. Check if email already taken -> link steward_user_id to existing account
 * 4. Check for wallet-only Steward session -> link to existing wallet user if possible
 * 5. Create new user + organization
 */
export async function syncUserFromSteward(
  params: StewardSyncParams,
): Promise<UserWithOrganization> {
  const { stewardUserId, walletChainType } = params;
  const email = params.email?.toLowerCase().trim();
  const walletAddress = params.walletAddress?.toLowerCase();
  const resolvedWalletChainType = walletAddress ? (walletChainType ?? "ethereum") : walletChainType;

  // Resolve display name with fallbacks
  let name = params.name;
  if (!name && email) {
    name = email.split("@")[0];
  } else if (!name && walletAddress) {
    name = `${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}`;
  } else if (!name) {
    name = `user-${stewardUserId.substring(0, 8)}`;
  }

  // ── 1. Existing user by steward_user_id ──────────────────────────────
  let user = await usersService.getByStewardId(stewardUserId);

  if (user) {
    // Ensure identity projection is current
    try {
      await usersService.upsertStewardIdentity(user.id, stewardUserId);
    } catch (error) {
      logger.warn("[StewardSync] Failed to repair Steward identity projection for existing user", {
        userId: user.id,
        stewardUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Update user fields if anything changed
    const shouldUpdate =
      user.name !== name ||
      user.email !== email ||
      user.wallet_address !== walletAddress ||
      (email && !user.email_verified) ||
      (walletAddress && !user.wallet_verified);

    if (shouldUpdate) {
      await usersService.update(user.id, {
        name,
        email: email || user.email,
        email_verified: !!email || user.email_verified,
        wallet_address: walletAddress || user.wallet_address,
        wallet_chain_type: resolvedWalletChainType || user.wallet_chain_type,
        wallet_verified: walletAddress ? true : user.wallet_verified,
        updated_at: new Date(),
      });

      // Re-read from primary to avoid replica lag
      user = (await usersService.getByStewardIdForWrite(stewardUserId))!;
    }

    return user;
  }

  // ── 2. Pending invite by email ───────────────────────────────────────
  if (email) {
    const pendingInvite = await invitesService.findPendingInviteByEmail(email);

    if (pendingInvite) {
      let newUser: Awaited<ReturnType<typeof usersService.create>> | undefined;

      try {
        newUser = await usersService.create({
          steward_user_id: stewardUserId,
          email: email || null,
          email_verified: !!email,
          wallet_address: walletAddress || null,
          wallet_chain_type: resolvedWalletChainType || null,
          wallet_verified: Boolean(walletAddress),
          name,
          avatar: getRandomUserAvatar(),
          organization_id: pendingInvite.organization_id,
          role: pendingInvite.invited_role,
          is_active: true,
        });
        await usersService.upsertStewardIdentity(newUser.id, stewardUserId);
      } catch (error) {
        const recovered =
          newUser &&
          (await recoverCanonicalStewardUser(newUser.id, stewardUserId, "invite", error));

        if (newUser && !recovered) {
          await rollbackCreatedUserSafely(newUser.id, "invite", error);
        }
        if (!recovered) {
          throw error;
        }
      }

      const userWithOrg = await usersService.getByStewardIdForWrite(stewardUserId);

      if (!userWithOrg) {
        throw new Error(
          `Failed to fetch newly created user (steward: ${stewardUserId}) after accepting invite`,
        );
      }

      await organizationInvitesRepository.markAsAccepted(pendingInvite.id, userWithOrg.id);

      // Log to Discord (fire-and-forget)
      discordService
        .logUserSignup({
          userId: userWithOrg.id,
          stewardUserId: userWithOrg.steward_user_id || "",
          email: userWithOrg.email || null,
          name: userWithOrg.name || null,
          walletAddress: userWithOrg.wallet_address || null,
          organizationId: userWithOrg.organization?.id || "",
          organizationName: userWithOrg.organization?.name || "",
          role: userWithOrg.role,
          isNewOrganization: false,
        })
        .catch((error) => {
          logger.error("[StewardSync] Discord log failed:", { error });
        });

      return userWithOrg;
    }
  }

  // ── 3. Email already taken (account linking) ─────────────────────────
  if (email) {
    const existingByEmail = await usersService.getByEmailWithOrganization(email);

    if (existingByEmail && existingByEmail.steward_user_id !== stewardUserId) {
      logger.info(
        `[StewardSync] Linking Steward account for ${email}: ${existingByEmail.steward_user_id} → ${stewardUserId}`,
      );
      const previousStewardUserId = existingByEmail.steward_user_id;

      await usersService.update(existingByEmail.id, {
        steward_user_id: stewardUserId,
        updated_at: new Date(),
      });

      try {
        await usersService.upsertStewardIdentity(existingByEmail.id, stewardUserId);
      } catch (error) {
        await restorePreviousStewardUserIdSafely(existingByEmail.id, previousStewardUserId, error);
        throw error;
      }

      const linkedUser = await usersService.getByStewardIdForWrite(stewardUserId);
      if (!linkedUser) {
        throw new Error(`Failed to fetch user after Steward account linking for ${email}`);
      }
      return linkedUser;
    }
  }

  // ── 4. Wallet-only Steward session (SIWE or SIWS) ────────────────────
  if (walletAddress && !email) {
    const existingByWallet = await usersService.getByWalletAddress(walletAddress);

    if (existingByWallet && existingByWallet.steward_user_id !== stewardUserId) {
      logger.info(
        `[StewardSync] Linking Steward wallet account for ${walletAddress}: ${existingByWallet.steward_user_id} → ${stewardUserId}`,
      );

      await usersService.linkStewardId(existingByWallet.id, stewardUserId);

      if (
        !existingByWallet.wallet_verified ||
        existingByWallet.wallet_chain_type !== resolvedWalletChainType
      ) {
        await usersService.update(existingByWallet.id, {
          wallet_verified: true,
          wallet_chain_type: resolvedWalletChainType || existingByWallet.wallet_chain_type,
        });
      }

      try {
        await usersService.upsertStewardIdentity(existingByWallet.id, stewardUserId);
      } catch (error) {
        await restorePreviousStewardUserIdSafely(
          existingByWallet.id,
          existingByWallet.steward_user_id,
          error,
        );
        throw error;
      }

      const linkedUser = await usersService.getByStewardIdForWrite(stewardUserId);
      if (!linkedUser) {
        throw new Error(
          `Failed to fetch user after Steward wallet account linking for ${walletAddress}`,
        );
      }
      return linkedUser;
    }
  }

  // ── 5. Create new user + organization ────────────────────────────────

  // Generate organization slug
  let orgSlug: string;
  if (email) {
    orgSlug = generateSlugFromEmail(email);
  } else if (walletAddress) {
    orgSlug = generateSlugFromWallet(walletAddress);
  } else if (name) {
    const sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const random = Math.random().toString(36).substring(2, 8);
    const timestamp = Date.now().toString(36).slice(-4);
    orgSlug = `${sanitized}-${timestamp}${random}`;
  } else {
    throw new Error(`Cannot generate organization slug for Steward user ${stewardUserId}`);
  }

  // Ensure slug uniqueness
  let attempts = 0;
  while (await organizationsService.getBySlug(orgSlug)) {
    attempts++;
    if (attempts > 10) {
      throw new Error(
        `Failed to generate unique organization slug for Steward user ${stewardUserId}`,
      );
    }
    orgSlug = email ? generateSlugFromEmail(email) : generateSlugFromWallet(walletAddress!);
  }

  // Create organization with zero balance initially
  const organization = await organizationsService.create({
    name: `${name}'s Organization`,
    slug: orgSlug,
    credit_balance: "0.00",
  });

  // Add initial free credits
  const initialCredits = getInitialCredits();

  if (initialCredits > 0) {
    try {
      await creditsService.addCredits({
        organizationId: organization.id,
        amount: initialCredits,
        description: "Initial free credits - Welcome bonus",
        metadata: {
          type: "initial_free_credits",
          source: "signup",
        },
      });
    } catch (_error) {
      await organizationsService.update(organization.id, {
        credit_balance: String(initialCredits),
      });
    }
  }

  // Create user, handle race conditions
  let createdUser: Awaited<ReturnType<typeof usersService.create>> | undefined;

  try {
    createdUser = await usersService.create({
      steward_user_id: stewardUserId,
      email: email || null,
      email_verified: !!email,
      wallet_address: walletAddress || null,
      wallet_chain_type: resolvedWalletChainType || null,
      wallet_verified: Boolean(walletAddress),
      name,
      avatar: getRandomUserAvatar(),
      organization_id: organization.id,
      role: "owner",
      is_active: true,
    });
  } catch (error) {
    const isDuplicateError =
      error &&
      typeof error === "object" &&
      (("code" in error && error.code === "23505") ||
        ("cause" in error &&
          error.cause &&
          typeof error.cause === "object" &&
          "code" in error.cause &&
          error.cause.code === "23505"));

    if (isDuplicateError) {
      let existingUser: UserWithOrganization | undefined;
      const maxRetries = 3;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
        }

        existingUser = await usersService.getByStewardIdForWrite(stewardUserId);
        if (existingUser) break;

        if (email) {
          existingUser = await usersService.getByEmailWithOrganization(email);
        }

        if (!existingUser && walletAddress) {
          existingUser = await usersService.getByWalletAddressWithOrganization(walletAddress);
        }

        if (existingUser) {
          if (existingUser.steward_user_id !== stewardUserId) {
            // NOTE: This is the link path that the Steward identity-link DB
            // migration drafts depend on (see
            // packages/db/migrations/_drafts_steward_link/README.md, Phase 2).
            // The match-by-email or match-by-wallet branches above find the
            // existing auth row, and this block writes the
            // steward_user_id link onto both `users` and `user_identities`.
            // The drafted Phase 3 migration will not run until the
            // unlinked-active-user count hits zero, which depends on this
            // path executing for every active user.
            logger.info(
              `[StewardSync] Linking Steward account for ${email}: ${existingUser.steward_user_id} → ${stewardUserId}`,
            );
            const previousStewardUserId = existingUser.steward_user_id;
            await usersService.update(existingUser.id, {
              steward_user_id: stewardUserId,
              updated_at: new Date(),
            });
            try {
              await usersService.upsertStewardIdentity(existingUser.id, stewardUserId);
            } catch (upsertError) {
              await usersService.update(existingUser.id, {
                steward_user_id: previousStewardUserId,
                updated_at: new Date(),
              });
              throw upsertError;
            }
            await organizationsService.delete(organization.id);
            const linkedUser = await usersService.getByStewardIdForWrite(stewardUserId);
            if (!linkedUser) {
              throw new Error(`Failed to fetch user after Steward account linking for ${email}`);
            }
            return linkedUser;
          }
          break;
        }
      }

      if (existingUser) {
        await organizationsService.delete(organization.id);
        return existingUser;
      }

      logger.error(
        `[StewardSync] Duplicate key error but user (steward: ${stewardUserId}) not found after ${maxRetries} retries`,
      );
      await organizationsService.delete(organization.id);
    }

    logger.error("[StewardSync] Failed to create user", {
      stewardUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (!createdUser) {
    throw new Error(`Failed to create user for Steward user ${stewardUserId}`);
  }

  // Upsert identity projection
  try {
    await usersService.upsertStewardIdentity(createdUser.id, stewardUserId);
  } catch (error) {
    const recovered = await recoverCanonicalStewardUser(
      createdUser.id,
      stewardUserId,
      "signup",
      error,
    );

    if (!recovered) {
      await rollbackCreatedUserSafely(createdUser.id, "signup", error);
      await organizationsService.delete(organization.id);
      throw error;
    }
  }

  // Fetch final user with organization
  const userWithOrg = await usersService.getByStewardIdForWrite(stewardUserId);

  if (!userWithOrg) {
    throw new Error(`Failed to fetch newly created Steward user ${stewardUserId}`);
  }

  // Send welcome email (fire-and-forget)
  const recipientEmail = email || userWithOrg.organization?.billing_email;
  if (recipientEmail) {
    queueWelcomeEmail({
      email: recipientEmail,
      userName: name || "there",
      organizationName: userWithOrg.organization?.name || "",
      creditBalance: initialCredits,
    }).catch((error) => {
      logger.error("[StewardSync] Failed to send welcome email:", { error });
    });
  } else {
    logger.warn("[StewardSync] No email available for welcome email", {
      userId: userWithOrg.id,
      stewardUserId,
      walletAddress,
    });
  }

  // Log to Discord (fire-and-forget)
  discordService
    .logUserSignup({
      userId: userWithOrg.id,
      stewardUserId: userWithOrg.steward_user_id || "",
      email: userWithOrg.email || null,
      name: userWithOrg.name || null,
      walletAddress: userWithOrg.wallet_address || null,
      organizationId: userWithOrg.organization?.id || "",
      organizationName: userWithOrg.organization?.name || "",
      role: userWithOrg.role,
      isNewOrganization: true,
    })
    .catch((error) => {
      logger.error("[StewardSync] Discord signup log failed:", { error });
    });

  // Auto-generate default API key (fire-and-forget)
  void ensureUserHasApiKey(userWithOrg.id, userWithOrg.organization?.id || "");

  // Auto-create default Eliza character (fire-and-forget)
  void ensureDefaultCharacter(userWithOrg.id, userWithOrg.organization?.id || "");

  return userWithOrg;
}

/**
 * Ensures a user has a default API key for programmatic access.
 */
async function ensureUserHasApiKey(userId: string, organizationId: string): Promise<void> {
  if (!userId?.trim() || !organizationId?.trim()) {
    logger.warn("[StewardSync] Invalid userId or organizationId, skipping API key creation");
    return;
  }

  try {
    const existingKeys = await apiKeysService.listByOrganization(organizationId);
    if (existingKeys.some((key) => key.user_id === userId)) {
      return;
    }

    await apiKeysService.create({
      user_id: userId,
      organization_id: organizationId,
      name: "Default API Key",
      is_active: true,
    });
  } catch (error) {
    logger.error("[StewardSync] Error creating API key", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Ensures a new account starts with a default Eliza character.
 */
async function ensureDefaultCharacter(userId: string, organizationId: string): Promise<void> {
  if (!userId?.trim() || !organizationId?.trim()) {
    logger.warn("[StewardSync] Invalid userId or organizationId, skipping default character");
    return;
  }

  try {
    const existing = await charactersService.listByOrganization(organizationId);
    if (existing.length > 0) {
      return;
    }

    const defaultData = getDefaultElizaCharacterData();
    await charactersService.create({
      ...defaultData,
      user_id: userId,
      organization_id: organizationId,
    });

    logger.info(`[StewardSync] Created default Eliza character for user ${userId}`);
  } catch (error) {
    logger.error("[StewardSync] Error creating default character", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Queues a welcome email for a new Steward user.
 */
async function queueWelcomeEmail(data: {
  email: string;
  userName: string;
  organizationName: string;
  creditBalance: number;
}): Promise<void> {
  await emailService.sendWelcomeEmail({
    ...data,
    dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
  });
}
