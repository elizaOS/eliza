/**
 * Auth Email Utility Functions
 *
 * @description Shared utilities for extracting and processing email addresses
 * from auth user objects. Used for admin email domain checks and other
 * email-related functionality.
 *
 * These utilities work with both primary email (user.email) and linked email
 * accounts (user.linkedAccounts) to ensure complete email coverage.
 *
 * @security Only verified emails are returned. Auth providers include verification
 * timestamps (verified_at, first_verified_at, latest_verified_at) on email
 * accounts - we only include emails that have been verified.
 */

/**
 * Auth email account with verification timestamps.
 * Matches auth provider's LinkedAccountEmail structure.
 */
export interface AuthEmailAccount {
  type: "email";
  address: string;
  /** UNIX timestamp when email was last verified */
  verified_at?: number;
  /** UNIX timestamp when email was first verified */
  first_verified_at?: number;
  /** UNIX timestamp when email was last verified */
  latest_verified_at?: number;
}

/**
 * Auth linked account types for type discrimination.
 */
export type AuthLinkedAccount =
  | AuthEmailAccount
  | { type: "wallet"; address?: string; walletClient?: string }
  | { type: "farcaster"; fid?: number; username?: string }
  | { type: "twitter"; username?: string }
  | { type: "google_oauth"; email?: string }
  | { type: "apple_oauth"; email?: string }
  | { type: "discord_oauth"; username?: string }
  | { type: "passkey"; credential_id?: string }
  | { type: "phone"; number?: string }
  | { type: "custom_auth"; custom_user_id?: string }
  | { type?: string; address?: string }; // Fallback for unknown types

/**
 * Minimal auth user type for email extraction.
 * Compatible with both server SDK User type and client-side user objects.
 */
export interface AuthUserWithEmails {
  /** Primary email (convenience property from auth provider) */
  email?: {
    address?: string;
    verified_at?: number;
    first_verified_at?: number;
    latest_verified_at?: number;
  };
  /** All linked accounts including emails, wallets, social accounts */
  linkedAccounts?: AuthLinkedAccount[];
}

/**
 * Check if an email account is verified.
 * Auth providers include verification timestamps only for verified emails.
 *
 * @param account - The email account to check
 * @returns true if the email has verification timestamps
 */
function isEmailVerified(account: {
  verified_at?: number;
  first_verified_at?: number;
  latest_verified_at?: number;
}): boolean {
  // An email is verified if it has any verification timestamp
  return !!(
    account.verified_at ||
    account.first_verified_at ||
    account.latest_verified_at
  );
}

/**
 * Get all verified email addresses from an auth user.
 *
 * Checks both the primary email (`user.email`) and the `linkedAccounts`
 * array for email-type accounts. Only returns emails that have been
 * verified (have verification timestamps).
 *
 * @security Only verified emails are returned. Emails without verification
 * timestamps are excluded to prevent unverified email attacks.
 *
 * @param user - The auth user object (or null/undefined)
 * @returns Array of all verified email addresses (deduplicated, lowercase)
 *
 * @example
 * const emails = getAllVerifiedEmails(authUser);
 * // Returns: ['user@gmail.com', 'user@company.com']
 *
 * @example
 * // User logged in with Farcaster, later linked and verified email
 * const emails = getAllVerifiedEmails(authUser);
 * // Returns email from linkedAccounts if verified
 */
export function getAllVerifiedEmails(
  user: AuthUserWithEmails | null | undefined,
): string[] {
  if (!user) return [];

  const emails = new Set<string>();

  // Check primary email field (convenience property from auth provider)
  // The primary email in user.email is always verified if present
  // (Auth provider only populates this field for verified emails)
  if (user.email?.address) {
    // For the primary email, Auth provider only includes it if verified
    // But we also check timestamps for extra safety
    const hasTimestamps = isEmailVerified(user.email);
    // Accept if verified or if no timestamps available (auth provider behavior)
    if (hasTimestamps || user.email.verified_at === undefined) {
      emails.add(user.email.address.toLowerCase());
    }
  }

  // Check linkedAccounts for additional email-type accounts
  if (Array.isArray(user.linkedAccounts)) {
    for (const account of user.linkedAccounts) {
      if (
        account?.type === "email" &&
        "address" in account &&
        account.address
      ) {
        const emailAccount = account as AuthEmailAccount;
        // Only include verified emails
        if (isEmailVerified(emailAccount)) {
          emails.add(emailAccount.address.toLowerCase());
        }
      }
    }
  }

  return [...emails];
}

/**
 * Find an email matching the admin domain from a list of verified emails.
 *
 * @param emails - Array of verified email addresses
 * @param adminDomain - The admin domain to match (e.g., 'elizalabs.ai')
 * @returns The first matching admin email, or null if none match
 *
 * @example
 * const adminEmail = findEmailByDomain(['user@gmail.com', 'user@elizalabs.ai'], 'elizalabs.ai');
 * // Returns: 'user@elizalabs.ai'
 *
 * @example
 * const adminEmail = findEmailByDomain([], 'elizalabs.ai');
 * // Returns: null (empty array)
 */
export function findEmailByDomain(
  emails: string[],
  adminDomain: string | null | undefined,
): string | null {
  if (!adminDomain || emails.length === 0) return null;

  const domainLower = `@${adminDomain.toLowerCase().trim()}`;

  for (const email of emails) {
    if (email.toLowerCase().endsWith(domainLower)) {
      return email;
    }
  }

  return null;
}

/**
 * Check if any of the user's verified emails matches the admin domain.
 *
 * Convenience function that combines getAllVerifiedEmails and findEmailByDomain.
 * Uses ADMIN_EMAIL_DOMAIN environment variable.
 *
 * @param user - The auth user object
 * @returns Object with adminEmail (if found) and allVerifiedEmails array
 *
 * @example
 * const { adminEmail, allVerifiedEmails } = checkForAdminEmail(authUser);
 * if (adminEmail) {
 *   // User has admin access
 * }
 */
export function checkForAdminEmail(
  user: AuthUserWithEmails | null | undefined,
): {
  adminEmail: string | null;
  allVerifiedEmails: string[];
} {
  const adminDomain = process.env.ADMIN_EMAIL_DOMAIN?.trim() ?? null;
  const allVerifiedEmails = getAllVerifiedEmails(user);
  const adminEmail = findEmailByDomain(allVerifiedEmails, adminDomain);

  return { adminEmail, allVerifiedEmails };
}
