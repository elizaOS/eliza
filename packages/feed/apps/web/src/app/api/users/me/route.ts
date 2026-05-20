/**
 * Current User Profile API
 *
 * @route GET /api/users/me
 * @access Authenticated
 *
 * @description
 * Returns the authenticated user's complete profile information including
 * profile status, social connections, reputation, and onboarding state.
 * Central endpoint for user session management and profile data.
 *
 * **Automatic User Creation:**
 * Creates a minimal user record in the database on first authentication if
 * one doesn't exist. This allows tracking of users through the onboarding
 * funnel and ensures a user record is always available for authenticated requests.
 *
 * @openapi
 * /api/users/me:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get current user profile
 *     description: Returns the authenticated user complete profile including onboarding status, social connections, and reputation.
 *     security:
 *       - StewardAuth: []
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 authenticated:
 *                   type: boolean
 *                 needsOnboarding:
 *                   type: boolean
 *                 user:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id:
 *                       type: string
 *                     username:
 *                       type: string
 *                     displayName:
 *                       type: string
 *                     bio:
 *                       type: string
 *                     profileImageUrl:
 *                       type: string
 *                     reputationPoints:
 *                       type: number
 *                     isAdmin:
 *                       type: boolean
 *                     stats:
 *                       type: object
 *       401:
 *         description: Unauthorized
 *
 * **Profile Data Includes:**
 * - **Identity:** username, display name, bio, avatar, cover image
 * - **Onboarding Status:** profile completion
 * - **Social Links:** Farcaster, Twitter connections and visibility settings
 * - **Reputation:** reputation points, referral code, referral source
 * - **Stats:** cached profile statistics (posts, followers, following)
 * - **Permissions:** admin status, actor/agent flag
 *
 * **Onboarding States:**
 * - `needsOnboarding: true` - User exists in DB but hasn't completed profile setup
 * - `needsOnboarding: false` - Fully onboarded user
 *
 * **Profile Completeness:**
 * A profile is considered complete when user has:
 * - Set a username
 * - Added a bio
 * - Uploaded a profile image
 *
 * **Caching:**
 * Profile stats (posts, followers, etc.) are cached for performance.
 * Cache is invalidated on relevant user actions.
 *
 * @returns {object} User profile response
 * @property {boolean} authenticated - Always true (auth required)
 * @property {boolean} needsOnboarding - Whether user needs profile setup
 * @property {object} user - User profile object (minimal record until profile completed)
 * @property {object} user.stats - Cached profile statistics
 *
 * **User Object Fields:**
 * @property {string} user.id - User ID
 * @property {string} user.privyId - Legacy Privy ID (deprecated, kept for migration compatibility)
 * @property {string} user.username - Unique username
 * @property {string} user.displayName - Display name
 * @property {string} user.bio - User biography
 * @property {string} user.profileImageUrl - Profile image URL
 * @property {string} user.coverImageUrl - Cover image URL
 * @property {string} user.referralCode - User's referral code
 * @property {string} user.referredBy - Referrer's code (if referred)
 * @property {number} user.reputationPoints - Reputation score
 * @property {boolean} user.hasFarcaster - Farcaster connected
 * @property {boolean} user.hasTwitter - Twitter connected
 * @property {boolean} user.isAdmin - Admin privileges
 * @property {boolean} user.isActor - Agent/actor flag
 *
 * @throws {401} Unauthorized - authentication required
 * @throws {500} Internal server error
 *
 * @example
 * ```typescript
 * // Get current user profile
 * const response = await fetch('/api/users/me', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * const { user, needsOnboarding } = await response.json();
 *
 * if (needsOnboarding) {
 *   // Redirect to onboarding flow
 *   router.push('/onboarding');
 * } else {
 *   // User fully onboarded
 *   console.log(`Welcome, ${user.displayName}!`);
 * }
 * ```
 *
 * @see {@link /lib/cached-database-service} Profile stats caching
 * @see {@link /lib/api/auth-middleware} Authentication
 * @see {@link /src/app/onboarding/page.tsx} Onboarding flow
 * @see {@link /src/contexts/AuthContext.tsx} Auth context consumer
 */

import {
  authenticate,
  authenticateWithDbUser,
  ConflictError,
  cachedDb,
  InternalServerError,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { db, eq, or, sql, users } from "@feed/db";
import { logger, toISO, toISOOrNull } from "@feed/shared";
import type { NextRequest } from "next/server";
import { getOptionalProfileStats } from "@/lib/users/profile-stats";
import { POST as updateProfilePOST } from "../[userId]/update-profile/route";

const userSelectFields = {
  id: users.id,
  privyId: users.privyId,
  username: users.username,
  displayName: users.displayName,
  bio: users.bio,
  profileImageUrl: users.profileImageUrl,
  coverImageUrl: users.coverImageUrl,
  email: users.email, // For displaying pending referrals
  emailVerified: users.emailVerified,
  emailNotificationsEnabled: users.emailNotificationsEnabled,
  emailNotificationsRealtime: users.emailNotificationsRealtime,
  emailNotificationsDailySummary: users.emailNotificationsDailySummary,
  emailNotificationsWeeklySummary: users.emailNotificationsWeeklySummary,
  emailNotificationsMonthlySummary: users.emailNotificationsMonthlySummary,
  profileComplete: users.profileComplete,
  hasUsername: users.hasUsername,
  hasBio: users.hasBio,
  hasProfileImage: users.hasProfileImage,
  referralCode: users.referralCode,
  referredBy: users.referredBy,
  reputationPoints: users.reputationPoints,
  virtualBalance: users.virtualBalance,
  pointsAwardedForProfile: users.pointsAwardedForProfile,
  pointsAwardedForFarcasterFollow: users.pointsAwardedForFarcasterFollow,
  pointsAwardedForTwitterFollow: users.pointsAwardedForTwitterFollow,
  pointsAwardedForDiscordJoin: users.pointsAwardedForDiscordJoin,
  pointsAwardedForEmail: users.pointsAwardedForEmail,
  hasFarcaster: users.hasFarcaster,
  hasTwitter: users.hasTwitter,
  hasDiscord: users.hasDiscord,
  farcasterUsername: users.farcasterUsername,
  farcasterFid: users.farcasterFid,
  twitterUsername: users.twitterUsername,
  twitterId: users.twitterId,
  discordUsername: users.discordUsername,
  hasTelegram: users.hasTelegram,
  telegramId: users.telegramId,
  telegramUsername: users.telegramUsername,
  showTwitterPublic: users.showTwitterPublic,
  showFarcasterPublic: users.showFarcasterPublic,
  showWalletPublic: users.showWalletPublic,
  isAdmin: users.isAdmin,
  isActor: users.isActor,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  gameGuideCompletedAt: users.gameGuideCompletedAt,
} as const;

type UserSelectResult = {
  id: string;
  privyId: string | null;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  profileImageUrl: string | null;
  coverImageUrl: string | null;
  email: string | null;
  emailVerified: boolean;
  emailNotificationsEnabled: boolean;
  emailNotificationsRealtime: boolean;
  emailNotificationsDailySummary: boolean;
  emailNotificationsWeeklySummary: boolean;
  emailNotificationsMonthlySummary: boolean;
  profileComplete: boolean;
  hasUsername: boolean;
  hasBio: boolean;
  hasProfileImage: boolean;
  referralCode: string | null;
  referredBy: string | null;
  reputationPoints: number;
  virtualBalance: string;
  pointsAwardedForProfile: boolean;
  pointsAwardedForFarcasterFollow: boolean;
  pointsAwardedForTwitterFollow: boolean;
  pointsAwardedForDiscordJoin: boolean;
  pointsAwardedForEmail: boolean;
  hasFarcaster: boolean;
  hasTwitter: boolean;
  hasDiscord: boolean;
  hasTelegram: boolean;
  telegramId: string | null;
  telegramUsername: string | null;
  farcasterUsername: string | null;
  farcasterFid: string | null;
  twitterUsername: string | null;
  twitterId: string | null;
  discordUsername: string | null;
  showTwitterPublic: boolean;
  showFarcasterPublic: boolean;
  showWalletPublic: boolean;
  isAdmin: boolean;
  isActor: boolean;
  createdAt: Date;
  updatedAt: Date;
  gameGuideCompletedAt: Date | null;
};

function buildUserResponse(
  dbUser: UserSelectResult,
  stats: Awaited<ReturnType<typeof getOptionalProfileStats>>,
) {
  return {
    id: dbUser.id,
    privyId: dbUser.privyId,
    username: dbUser.username,
    displayName: dbUser.displayName,
    bio: dbUser.bio,
    profileImageUrl: dbUser.profileImageUrl,
    coverImageUrl: dbUser.coverImageUrl,
    email: dbUser.email,
    emailVerified: dbUser.emailVerified,
    emailNotificationsEnabled: dbUser.emailNotificationsEnabled,
    emailNotificationsRealtime: dbUser.emailNotificationsRealtime,
    emailNotificationsDailySummary: dbUser.emailNotificationsDailySummary,
    emailNotificationsWeeklySummary: dbUser.emailNotificationsWeeklySummary,
    emailNotificationsMonthlySummary: dbUser.emailNotificationsMonthlySummary,
    profileComplete: dbUser.profileComplete,
    hasUsername: dbUser.hasUsername,
    hasBio: dbUser.hasBio,
    hasProfileImage: dbUser.hasProfileImage,
    referralCode: dbUser.referralCode,
    referredBy: dbUser.referredBy,
    reputationPoints: dbUser.reputationPoints,
    virtualBalance: Number(dbUser.virtualBalance ?? 0),
    pointsAwardedForProfile: dbUser.pointsAwardedForProfile,
    pointsAwardedForFarcasterFollow: dbUser.pointsAwardedForFarcasterFollow,
    pointsAwardedForTwitterFollow: dbUser.pointsAwardedForTwitterFollow,
    pointsAwardedForDiscordJoin: dbUser.pointsAwardedForDiscordJoin,
    pointsAwardedForEmail: dbUser.pointsAwardedForEmail,
    hasFarcaster: dbUser.hasFarcaster,
    hasTwitter: dbUser.hasTwitter,
    hasDiscord: dbUser.hasDiscord,
    hasTelegram: dbUser.hasTelegram,
    farcasterUsername: dbUser.farcasterUsername,
    twitterUsername: dbUser.twitterUsername,
    discordUsername: dbUser.discordUsername,
    telegramUsername: dbUser.telegramUsername,
    showTwitterPublic: dbUser.showTwitterPublic,
    showFarcasterPublic: dbUser.showFarcasterPublic,
    showWalletPublic: dbUser.showWalletPublic,
    isAdmin: dbUser.isAdmin,
    isActor: dbUser.isActor,
    createdAt: toISO(dbUser.createdAt),
    updatedAt: toISO(dbUser.updatedAt),
    gameGuideCompletedAt: toISOOrNull(dbUser.gameGuideCompletedAt),
    stats,
  };
}

async function updateReferrerForIncompleteUser(
  dbUser: UserSelectResult,
  referralCode: string,
): Promise<UserSelectResult> {
  const normalizedCode = referralCode.trim();

  // First, try to find referrer by username (legacy system, case-insensitive)
  let [referrer] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${normalizedCode})`)
    .limit(1);

  // If not found by username, try by referralCode
  if (!referrer) {
    [referrer] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.referralCode, normalizedCode))
      .limit(1);
  }

  if (referrer && referrer.id !== dbUser.id) {
    const previousReferrer = dbUser.referredBy;

    const [updatedUser] = await db
      .update(users)
      .set({ referredBy: referrer.id })
      .where(eq(users.id, dbUser.id))
      .returning(userSelectFields);

    if (!updatedUser) {
      throw new InternalServerError("Failed to update user record");
    }

    if (previousReferrer && previousReferrer !== referrer.id) {
      logger.info(
        "Updated user with NEW referrer (latest referral wins)",
        {
          userId: updatedUser.id,
          previousReferrer,
          newReferrer: referrer.id,
          referrerUsername: referrer.username,
          referralCode,
        },
        "GET /api/users/me",
      );
    } else if (!previousReferrer) {
      logger.info(
        "Updated existing user with referrer",
        {
          userId: updatedUser.id,
          referrerId: referrer.id,
          referrerUsername: referrer.username,
          referralCode,
        },
        "GET /api/users/me",
      );
    }

    return updatedUser;
  }

  if (referrer?.id === dbUser.id) {
    logger.warn(
      "Self-referral attempt blocked for existing user",
      { userId: dbUser.id, referralCode },
      "GET /api/users/me",
    );
  }

  return dbUser;
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const privyId = authUser.privyId ?? authUser.userId;
  const canonicalUserId = authUser.dbUserId ?? authUser.userId;

  // Extract referralCode from query params (passed from frontend)
  const { searchParams } = new URL(request.url);
  const referralCode = searchParams.get("ref") || null;

  logger.info(
    "Fetching user profile",
    { privyId, dbUserId: authUser.dbUserId, hasReferralCode: !!referralCode },
    "GET /api/users/me",
  );

  // Phase 2: Look up by primary key (fastest, works for both Steward and legacy Privy users).
  // auth-middleware already resolved the correct Feed user ID into authUser.dbUserId
  // via ensureUserFromSteward / email-bridge / fast-path, so we trust it directly.
  let [dbUser] = await db
    .select(userSelectFields)
    .from(users)
    .where(eq(users.id, canonicalUserId))
    .limit(1);

  // Fallback: legacy Privy users whose row predates the stewardId column —
  // find them by privyId in case canonicalUserId resolved to the Steward UUID
  // rather than the Feed snowflake on an older session.
  if (!dbUser) {
    [dbUser] = await db
      .select(userSelectFields)
      .from(users)
      .where(eq(users.privyId, privyId))
      .limit(1);
  }

  // Create minimal user record on first authentication
  // Phase 2: auth-middleware creates the user via ensureUserFromSteward before
  // this route runs, so this block should rarely be hit for Steward users.
  if (!dbUser) {
    // Use only data available from the authenticated session — no Privy call
    const email: string | null = authUser.email ?? null;
    const farcasterUsername: string | null = null;
    const farcasterFid: string | null = null;
    const twitterUsername: string | null = null;
    const twitterId: string | null = null;
    const telegramUserId: string | null = null;
    const telegramUsername: string | null = null;

    logger.info(
      "Creating minimal user for new Steward user",
      { privyId, email },
      "GET /api/users/me",
    );

    // Check if Farcaster or Twitter account is already linked to an existing user
    // If found, auto-link the new Privy session to the existing account
    // This allows users to login with their social account and access their existing Feed account
    if (farcasterFid || twitterId) {
      const conditions = [];
      if (farcasterFid) {
        conditions.push(eq(users.farcasterFid, farcasterFid));
      }
      if (twitterId) {
        conditions.push(eq(users.twitterId, twitterId));
      }

      const existingUsersWithSocial = await db
        .select(userSelectFields)
        .from(users)
        .where(or(...conditions))
        .limit(2);

      // If multiple users found, it means Farcaster and Twitter belong to different accounts
      // Skip auto-linking to prevent linking the wrong account
      if (existingUsersWithSocial.length > 1) {
        logger.warn(
          "Multiple users found with conflicting social accounts - skipping auto-link",
          {
            newPrivyId: privyId,
            farcasterFid,
            twitterId,
            foundUserIds: existingUsersWithSocial.map((u) => u.id),
          },
          "GET /api/users/me",
        );

        // Return error to prevent insert failure due to unique constraint violation
        throw new ConflictError(
          "Your social accounts are linked to different existing users. Please contact support.",
          "User.socialAccounts",
        );
      } else if (existingUsersWithSocial.length === 1) {
        const existingUserWithSocial = existingUsersWithSocial[0]!;
        const matchedByFarcaster =
          !!farcasterFid &&
          existingUserWithSocial.farcasterFid === farcasterFid;
        const matchedByTwitter =
          !!twitterId && existingUserWithSocial.twitterId === twitterId;

        const linkedAccount =
          matchedByFarcaster && matchedByTwitter
            ? "Farcaster+Twitter"
            : matchedByFarcaster
              ? "Farcaster"
              : matchedByTwitter
                ? "Twitter"
                : "Unknown";

        logger.info(
          "Found existing user by social account - auto-linking new Privy session",
          {
            newPrivyId: privyId,
            oldPrivyId: existingUserWithSocial.privyId,
            existingUserId: existingUserWithSocial.id,
            existingUsername: existingUserWithSocial.username,
            linkedAccount,
            farcasterFid,
            twitterId,
          },
          "GET /api/users/me",
        );

        // Check if the new privyId is already linked to a different user
        const [existingUserWithPrivyId] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.privyId, privyId))
          .limit(1);

        if (
          existingUserWithPrivyId &&
          existingUserWithPrivyId.id !== existingUserWithSocial.id
        ) {
          logger.warn(
            "New privyId already linked to a different user - skipping auto-link to prevent account conflict",
            {
              newPrivyId: privyId,
              existingPrivyUserId: existingUserWithPrivyId.id,
              socialMatchUserId: existingUserWithSocial.id,
            },
            "GET /api/users/me",
          );
          // Skip auto-linking, let normal flow continue
        } else {
          // Update the existing user's privyId to the new one
          const oldPrivyId = existingUserWithSocial.privyId;
          const [updatedUser] = await db
            .update(users)
            .set({
              privyId,
              updatedAt: new Date(),
            })
            .where(eq(users.id, existingUserWithSocial.id))
            .returning(userSelectFields);

          if (updatedUser) {
            dbUser = updatedUser;

            // Invalidate identifier caches for privyId change
            await cachedDb.invalidateUserIdentifierCaches(
              {
                id: updatedUser.id,
                privyId: updatedUser.privyId,
                username: updatedUser.username,
              },
              {
                privyId: oldPrivyId,
              },
            );

            logger.info(
              "Successfully linked new Privy session to existing user",
              {
                userId: updatedUser.id,
                username: updatedUser.username,
                newPrivyId: privyId,
              },
              "GET /api/users/me",
            );
          }
        }
      }
    }

    // If we found and linked to an existing user, skip the new user creation
    if (dbUser) {
      let linkedUser = dbUser;

      if (referralCode && !linkedUser.profileComplete) {
        linkedUser = await updateReferrerForIncompleteUser(
          linkedUser,
          referralCode,
        );
      } else if (referralCode && linkedUser.profileComplete) {
        logger.warn(
          "Referral change blocked - profile already complete",
          {
            userId: linkedUser.id,
            referralCode,
            existingReferrer: linkedUser.referredBy,
          },
          "GET /api/users/me",
        );
      }

      // Get cached profile stats for the linked user
      const stats = await getOptionalProfileStats(
        linkedUser.id,
        "GET /api/users/me",
      );

      const responseUser = buildUserResponse(linkedUser, stats);

      const needsOnboarding = !linkedUser.profileComplete;
      logger.info(
        "Returning linked existing user profile",
        {
          userId: linkedUser.id,
          username: linkedUser.username,
          profileComplete: linkedUser.profileComplete,
          needsOnboarding,
        },
        "GET /api/users/me",
      );

      return successResponse({
        authenticated: true,
        needsOnboarding,
        user: responseUser,
      });
    }

    // Resolve referrer if referralCode provided
    let resolvedReferrerId: string | null = null;
    if (referralCode) {
      const normalizedCode = referralCode.trim();

      // First, try to find referrer by username (legacy system, case-insensitive)
      const [referrerByUsername] = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(sql`lower(${users.username}) = lower(${normalizedCode})`)
        .limit(1);

      if (referrerByUsername && referrerByUsername.id !== canonicalUserId) {
        resolvedReferrerId = referrerByUsername.id;

        logger.info(
          "Found valid referrer by username for new user",
          {
            referrerId: referrerByUsername.id,
            referrerUsername: referrerByUsername.username,
            referredUserId: canonicalUserId,
            referralCode: normalizedCode,
          },
          "GET /api/users/me",
        );
      } else if (referrerByUsername?.id === canonicalUserId) {
        logger.warn(
          "Self-referral attempt blocked (username lookup)",
          { userId: canonicalUserId, referralCode: normalizedCode },
          "GET /api/users/me",
        );
      } else {
        // If not found by username, try by referralCode
        const [referrerByCode] = await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(eq(users.referralCode, normalizedCode))
          .limit(1);

        if (referrerByCode && referrerByCode.id !== canonicalUserId) {
          resolvedReferrerId = referrerByCode.id;

          logger.info(
            "Found valid referrer by referralCode for new user",
            {
              referrerId: referrerByCode.id,
              referrerUsername: referrerByCode.username,
              referredUserId: canonicalUserId,
              referralCode: normalizedCode,
            },
            "GET /api/users/me",
          );
        } else if (referrerByCode?.id === canonicalUserId) {
          logger.warn(
            "Self-referral attempt blocked (referralCode lookup)",
            { userId: canonicalUserId, referralCode: normalizedCode },
            "GET /api/users/me",
          );
        } else {
          logger.warn(
            "Invalid referral code provided (not found by username or referralCode)",
            { referralCode: normalizedCode, userId: canonicalUserId },
            "GET /api/users/me",
          );
        }
      }
    }

    logger.info(
      "Creating minimal user record on first authentication",
      {
        privyId,
        userId: canonicalUserId,
        referredBy: resolvedReferrerId,
        email,
        emailVerified: !!email,
        farcasterUsername,
        twitterUsername,
      },
      "GET /api/users/me",
    );

    // Phase 2: Admin check uses the email from auth session (Steward verifies email ownership)
    const adminDomain = process.env.ADMIN_EMAIL_DOMAIN?.trim();
    const adminEmail: string | null =
      email && adminDomain && email.endsWith(`@${adminDomain}`) ? email : null;
    const shouldBeAdmin = adminEmail !== null;

    if (shouldBeAdmin) {
      logger.info(
        "Auto-promoting user to admin based on verified email domain",
        { privyId, emailDomain: adminEmail?.split("@")[1] ?? null },
        "GET /api/users/me",
      );
    }

    const [newUser] = await db
      .insert(users)
      .values({
        id: canonicalUserId,
        privyId,
        referredBy: resolvedReferrerId,
        email,
        farcasterUsername,
        farcasterFid,
        twitterUsername,
        twitterId,
        hasFarcaster: !!farcasterUsername,
        hasTwitter: !!twitterUsername,
        hasTelegram: !!telegramUserId,
        telegramId: telegramUserId,
        telegramUsername,
        telegramVerifiedAt: telegramUserId ? new Date() : null,
        profileComplete: false,
        hasUsername: false,
        hasBio: false,
        hasProfileImage: false,
        isAdmin: shouldBeAdmin,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning(userSelectFields);

    if (!newUser) {
      const [concurrentUser] = await db
        .select(userSelectFields)
        .from(users)
        .where(or(eq(users.privyId, privyId), eq(users.id, canonicalUserId)))
        .limit(1);

      if (!concurrentUser) {
        throw new InternalServerError("Failed to create or find user record");
      }

      dbUser = concurrentUser;
    } else {
      dbUser = newUser;

      logger.info(
        "Minimal user record created",
        {
          userId: dbUser.id,
          privyId,
          referredBy: dbUser.referredBy,
          email: dbUser.email,
        },
        "GET /api/users/me",
      );

      // Invalidate identifier caches for the new user (clears negative cache)
      await cachedDb.invalidateUserIdentifierCaches({
        id: dbUser.id,
        privyId: dbUser.privyId,
        username: dbUser.username,
      });
    }
  } else if (referralCode && dbUser && !dbUser.profileComplete) {
    // User exists BUT profile not complete - update referredBy with latest referral code (latest wins!)
    // ⚠️ IMPORTANT: Only allow referral changes BEFORE profile completion to prevent gaming
    dbUser = await updateReferrerForIncompleteUser(dbUser, referralCode);
  } else if (referralCode && dbUser?.profileComplete) {
    // User has completed profile - don't allow referral changes anymore
    logger.warn(
      "Referral change blocked - profile already complete",
      { userId: dbUser.id, referralCode, existingReferrer: dbUser.referredBy },
      "GET /api/users/me",
    );
  }

  // At this point dbUser should always be defined (either fetched or created)
  if (!dbUser) {
    throw new InternalServerError("Failed to create or find user record");
  }

  // Phase 2: Privy identity sync removed. Social identities are synced at login time.
  const needsAdminPromotionCheck = !dbUser.isAdmin;

  if (needsAdminPromotionCheck) {
    const adminDomain = process.env.ADMIN_EMAIL_DOMAIN?.trim();
    if (adminDomain && dbUser.email?.endsWith(`@${adminDomain}`)) {
      logger.info(
        "Auto-promoting existing user to admin based on verified email domain",
        { userId: dbUser.id, emailDomain: adminDomain },
        "GET /api/users/me",
      );
      const [updatedUser] = await db
        .update(users)
        .set({ isAdmin: true, updatedAt: new Date() })
        .where(eq(users.id, dbUser.id))
        .returning(userSelectFields);
      if (updatedUser) dbUser = updatedUser;
    }
  }

  // Get cached profile stats
  const stats = await getOptionalProfileStats(dbUser.id, "GET /api/users/me");

  const responseUser = buildUserResponse(dbUser, stats);

  const needsOnboarding = !dbUser.profileComplete;
  logger.info(
    "Authenticated user profile fetched",
    {
      userId: dbUser.id,
      username: dbUser.username,
      profileComplete: dbUser.profileComplete,
      needsOnboarding,
    },
    "GET /api/users/me",
  );

  return successResponse({
    authenticated: true,
    needsOnboarding,
    user: responseUser,
  });
});

const updateCurrentUserProfile = withErrorHandling(
  async (request: NextRequest) => {
    const authUser = await authenticateWithDbUser(request);

    return updateProfilePOST(request, {
      params: Promise.resolve({ userId: authUser.dbUserId }),
    });
  },
);

export const POST = withErrorHandling(async (request: NextRequest) => {
  return updateCurrentUserProfile(request);
});

export const PUT = withErrorHandling(async (request: NextRequest) => {
  return updateCurrentUserProfile(request);
});

export const PATCH = withErrorHandling(async (request: NextRequest) => {
  return updateCurrentUserProfile(request);
});
