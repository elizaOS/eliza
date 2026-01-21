/**
 * Admin Authorization Utilities
 *
 * @description Server-side utilities for checking admin privileges.
 * Uses environment variable ADMIN_EMAIL_DOMAIN to automatically grant
 * admin privileges to users with emails from the specified domain.
 *
 * SECURITY: Auto-admin promotion requires email verification to prevent
 * attackers from creating unverified accounts with admin domain emails.
 */

/**
 * Get the admin email domain from environment variable.
 * Returns null if not configured.
 *
 * @example
 * // ADMIN_EMAIL_DOMAIN=elizalabs.ai in .env
 * getAdminEmailDomain() // Returns 'elizalabs.ai'
 */
export function getAdminEmailDomain(): string | null {
  const domain = process.env.ADMIN_EMAIL_DOMAIN;
  return domain?.trim() || null;
}

/**
 * Check if an email address matches the admin domain pattern.
 * This is a low-level check that only validates the email format.
 *
 * NOTE: For auto-admin promotion, use `checkForAdminEmail` from
 * `./privy-email-utils` instead, which checks all linked emails and
 * uses Privy's verification timestamps.
 *
 * @param email - The email address to check
 * @returns True if the email domain matches the admin domain
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;

  const adminDomain = getAdminEmailDomain();
  if (!adminDomain) return false;

  const emailLower = email.toLowerCase().trim();
  const domainLower = adminDomain.toLowerCase().trim();

  // Check if email ends with @domain
  return emailLower.endsWith(`@${domainLower}`);
}

/**
 * Check if a user should be auto-promoted to admin based on their email.
 *
 * @deprecated Use `checkForAdminEmail` from `./privy-email-utils` instead.
 * That function properly checks all linked emails and uses Privy's verification
 * timestamps rather than requiring a separate emailVerified boolean.
 *
 * SECURITY: Requires both:
 * 1. Email matches the admin domain (ADMIN_EMAIL_DOMAIN env var)
 * 2. Email is verified (prevents unverified email attacks)
 *
 * @param email - The email address to check
 * @param emailVerified - Whether the email has been verified
 * @returns True if the user should be auto-promoted to admin
 *
 * @example
 * // ADMIN_EMAIL_DOMAIN=elizalabs.ai
 * shouldAutoPromoteToAdmin('user@elizalabs.ai', true) // true
 * shouldAutoPromoteToAdmin('user@elizalabs.ai', false) // false (unverified)
 * shouldAutoPromoteToAdmin('user@gmail.com', true) // false (wrong domain)
 * shouldAutoPromoteToAdmin(null, true) // false
 */
export function shouldAutoPromoteToAdmin(
  email: string | null | undefined,
  emailVerified: boolean,
): boolean {
  // SECURITY: Require email verification to prevent unverified email attacks
  if (!emailVerified) return false;

  return isAdminEmail(email);
}
