const ONBOARDING_USERNAME_MIN_LENGTH = 3;

/**
 * Normalize a proposed Babylon onboarding username to the existing
 * onboarding/check-username format.
 */
export function sanitizeOnboardingUsername(username: string): string {
  return username
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toLowerCase()
    .slice(0, 20);
}

/**
 * Check whether a sanitized onboarding username is usable.
 * Returns false for empty strings, too-short values, or all-underscore results
 * (e.g. CJK-only or emoji-only inputs that collapsed to underscores).
 */
export function isValidOnboardingUsername(username: string): boolean {
  return (
    username.length >= ONBOARDING_USERNAME_MIN_LENGTH && !/^_+$/.test(username)
  );
}
