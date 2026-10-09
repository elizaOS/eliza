/**
 * Phone verification parity between canonical users and their identity
 * projection. Migration 0051 projected NULL phone_verified for phoneless
 * identities while users stayed false; that tuple is coherent, not a conflict.
 */

import type { UserIdentity } from "../schemas/user-identities";
import type { User } from "../schemas/users";

export function phoneVerifiedProjectionMatches(
  user: Pick<User, "phone_number" | "phone_verified">,
  identity: Pick<UserIdentity, "phone_number" | "phone_verified">,
): boolean {
  if (identity.phone_number !== user.phone_number) return false;
  if (identity.phone_verified === user.phone_verified) return true;
  // Phoneless legacy drift: false/NULL (either side) means "not verified".
  return user.phone_number === null && !user.phone_verified && !identity.phone_verified;
}
