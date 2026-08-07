/**
 * Resolution of an Eliza Cloud user into everything the OIDC claim builder
 * needs, plus the eligibility rules that decide whether that user may become an
 * identity at a relying party at all.
 *
 * Reads go through `usersRepository` (not the cached service) because both
 * `/token` and `/userinfo` must observe a deactivation that happened after the
 * code was issued. `assertOidcSubjectEligible` is the gate: it refuses
 * anonymous, inactive, and soft-deleted rows, and — for a client that requires
 * it — a row without a verified email address.
 *
 * That last check is deliberately "verified AND present". The field-level
 * encryption rollout leaves `users.email` nullable while ciphertext columns
 * fill in, and a relying party configured for automatic account creation would
 * otherwise silently start creating accounts with no address. Failing the
 * authorization loudly is the safe direction.
 */

import { oidcRepository } from "../../db/repositories/oidc";
import { type UserWithOrganization, usersRepository } from "../../db/repositories/users";
import type { OidcUserProfile } from "../../db/schemas/oidc";
import { adminService, isElizaLabsAdminEmail } from "../services/admin";
import type { OidcAdminStatus } from "./claims";
import type { OidcClient } from "./clients";

export interface OidcSubject {
  user: UserWithOrganization;
  profile: OidcUserProfile | null;
  adminStatus: OidcAdminStatus;
}

export type OidcIneligibleReason =
  | "user_inactive"
  | "user_anonymous"
  | "email_unverified"
  | "organization_inactive";

/** Live read of the user, org, OIDC profile, and platform-admin grant. */
export async function loadOidcSubject(userId: string): Promise<OidcSubject | null> {
  const user = await usersRepository.findWithOrganization(userId);
  if (!user) return null;

  const [profile, adminStatus] = await Promise.all([
    oidcRepository.findProfile(user.id),
    adminService.getAdminStatusForUser(user),
  ]);

  return {
    user,
    profile: profile ?? null,
    adminStatus: {
      isAdmin: adminStatus.isAdmin,
      role: adminStatus.role,
      // The @elizalabs.ai rule grants super_admin with no `admin_users` row.
      // Distinguishing it lets a relying party allowlist the wallet-backed
      // grant without inheriting the email-domain one.
      implicit:
        adminStatus.role === "super_admin" &&
        isElizaLabsAdminEmail(user.email) &&
        user.email_verified === true &&
        !user.wallet_address,
    },
  };
}

/** `null` when the subject may authorize; otherwise the refusal reason. */
export function assertOidcSubjectEligible(
  subject: OidcSubject,
  client: OidcClient,
): OidcIneligibleReason | null {
  const { user } = subject;
  if (user.is_anonymous) return "user_anonymous";
  if (!user.is_active || user.deleted_at) return "user_inactive";
  if (user.organization && !user.organization.is_active) return "organization_inactive";
  if (client.require_verified_email && !(user.email_verified === true && user.email)) {
    return "email_unverified";
  }
  return null;
}
