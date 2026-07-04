/**
 * Profile-name validation for the CLI's `--profile` / `--dev` state
 * namespacing: `isValidProfileName` enforces a path- and shell-safe charset,
 * and `normalizeProfileName` trims and folds the reserved "default" name (and
 * anything invalid) to null so callers fall back to the base state dir.
 */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isValidProfileName(value: string): boolean {
  if (!value) {
    return false;
  }
  // Keep it path-safe + shell-friendly.
  return PROFILE_NAME_RE.test(value);
}

export function normalizeProfileName(raw?: string | null): string | null {
  const profile = raw?.trim();
  if (!profile) {
    return null;
  }
  if (profile.toLowerCase() === "default") {
    return null;
  }
  if (!isValidProfileName(profile)) {
    return null;
  }
  return profile;
}
