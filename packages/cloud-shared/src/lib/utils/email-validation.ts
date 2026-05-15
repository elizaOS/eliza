/**
 * Email Validation Utilities
 *
 * Basic email format validation for auto-provisioning flows.
 * Not overly strict - accepts most valid email formats.
 */

/**
 * Basic email format validation.
 * Checks for: local@domain.tld pattern with reasonable constraints.
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;

  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;

  // Basic format: something@something.something
  // Not overly strict to avoid rejecting valid but unusual emails
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed);
}

/**
 * Normalize email to lowercase and trim whitespace.
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Mask email for logging (e.g., "be***in@gmail.com").
 * Handles short prefixes gracefully.
 */
export function maskEmailForLogging(email: string): string {
  const normalized = normalizeEmail(email);
  const [prefix, domain] = normalized.split("@");

  if (!prefix || !domain) return "***@***";

  let maskedPrefix: string;
  if (prefix.length <= 2) {
    maskedPrefix = "***";
  } else if (prefix.length <= 4) {
    maskedPrefix = `${prefix[0]}***`;
  } else {
    maskedPrefix = `${prefix.slice(0, 2)}***${prefix.slice(-2)}`;
  }

  return `${maskedPrefix}@${domain}`;
}
