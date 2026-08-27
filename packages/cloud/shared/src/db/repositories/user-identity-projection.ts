/**
 * Distinguishes matching Steward session authority from full users ↔
 * user_identities projection parity, including the phoneless legacy
 * phone_verified false/NULL tuple created by migration 0051.
 */

import type { UserIdentity } from "../schemas/user-identities";
import type { User } from "../schemas/users";

export type PhonelessPhoneVerifiedNormalization = "repaired" | "healthy" | "skipped";

function sameOptionalTimestamp(left: Date | null, right: Date | null): boolean {
  return left === null || right === null ? left === right : left.getTime() === right.getTime();
}

/**
 * New rows never store NULL phone_verified. TRUE is only valid when a phone
 * number is present; phoneless accounts are false.
 */
export function phoneVerifiedForNewRow(
  phoneNumber: string | null | undefined,
  phoneVerified: boolean | null | undefined,
): boolean {
  if (phoneNumber == null || phoneNumber === "") {
    return false;
  }
  return phoneVerified === true;
}

/**
 * Steward session authority: the projection row belongs to this canonical user
 * and carries the same Steward subject. This is not full field parity.
 */
export function stewardAuthorityMatches(user: User, identity: UserIdentity): boolean {
  return identity.user_id === user.id && identity.steward_user_id === user.steward_user_id;
}

/**
 * Migration 0051 projected NULL phone_verified when phone_number was absent.
 * Canonical users.phone_verified stayed false, so otherwise coherent phoneless
 * accounts disagree under strict equality.
 */
export function hasPhonelessLegacyPhoneVerifiedDrift(
  user: Pick<User, "phone_number" | "phone_verified">,
  identity: Pick<UserIdentity, "phone_number" | "phone_verified">,
): boolean {
  return (
    user.phone_number === null &&
    identity.phone_number === null &&
    user.phone_verified === false &&
    identity.phone_verified === null
  );
}

function phoneVerifiedProjectionMatches(
  user: Pick<User, "phone_number" | "phone_verified">,
  identity: Pick<UserIdentity, "phone_number" | "phone_verified">,
): boolean {
  if (identity.phone_number !== user.phone_number) {
    return false;
  }
  if (identity.phone_verified === user.phone_verified) {
    return true;
  }
  return hasPhonelessLegacyPhoneVerifiedDrift(user, identity);
}

/** Full canonical ↔ projection field parity used by merge/convergence guards. */
export function projectionMatchesUser(user: User, identity: UserIdentity): boolean {
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
    phoneVerifiedProjectionMatches(user, identity) &&
    identity.discord_id === user.discord_id &&
    identity.discord_username === user.discord_username &&
    identity.discord_global_name === user.discord_global_name &&
    identity.discord_avatar_url === user.discord_avatar_url &&
    identity.whatsapp_id === user.whatsapp_id &&
    identity.whatsapp_name === user.whatsapp_name
  );
}
