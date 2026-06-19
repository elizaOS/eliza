/**
 * Referral Service
 *
 * @description Centralized service for managing user referral codes. Handles
 * referral code generation, uniqueness validation, and database updates. Ensures
 * each user has a unique referral code for tracking referrals.
 */

import { and, dbWrite, eq, ne, users } from "@feed/db";
import { logger } from "@feed/shared";
import { BadRequestError, ConflictError, NotFoundError } from "../errors";

export async function isReferralCodeAvailableForUser(
  userId: string,
  referralCode: string,
): Promise<boolean> {
  const existingUserWithCode = await dbWrite
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.referralCode, referralCode), ne(users.id, userId)))
    .limit(1);

  return existingUserWithCode.length === 0;
}

/**
 * Get or create a referral code for a user
 *
 * @description Gets existing referral code or sets it to the user's username.
 * Since username is required during signup, we always use username as the referral code.
 * Ensures uniqueness by checking database and throwing error if username is taken as referral code.
 *
 * @param {string} userId - The user ID
 * @returns {Promise<string>} The user's referral code (their username)
 * @throws {Error} If user not found or username is missing
 *
 * @example
 * ```typescript
 * const code = await getOrCreateReferralCode(userId);
 * // Returns: "cidsociety"
 * ```
 */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  // Use the primary connection for this flow. The common call pattern is
  // "create user, then immediately derive referral code", which is a classic
  // read-after-write path and should not be served from a replica.
  const result = await dbWrite
    .select({
      id: users.id,
      username: users.username,
      referralCode: users.referralCode,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = result[0];

  if (!user) {
    throw new NotFoundError(`User not found: ${userId}`);
  }

  // Username is required during signup, so it should always exist
  if (!user.username) {
    throw new BadRequestError(
      `User ${userId} does not have a username. Username is required for referral codes.`,
    );
  }

  // Check if username is already used as a referral code by another user
  const isReferralCodeAvailable = await isReferralCodeAvailableForUser(
    userId,
    user.username,
  );

  if (!isReferralCodeAvailable) {
    throw new ConflictError(
      `Username "${user.username}" is already used as a referral code by another user`,
    );
  }

  // Update referral code to username if it's different
  if (user.referralCode !== user.username) {
    await dbWrite
      .update(users)
      .set({ referralCode: user.username })
      .where(eq(users.id, userId));

    logger.info(
      `Updated referral code to username for user ${userId}: ${user.username}`,
      { userId, code: user.username },
      "ReferralService",
    );
  }

  return user.username;
}
