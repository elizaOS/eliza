/**
 * Agent Username Utilities
 *
 * Handles validation, slugification, and generation of unique agent usernames.
 * Usernames are used for URL routing (/chat/@username) and display.
 *
 * Rules:
 * - 3-30 characters
 * - Alphanumeric and hyphens only
 * - No consecutive hyphens (--)
 * - No leading or trailing hyphens
 * - Globally unique across all agents
 */

/**
 * Username validation result.
 */
export interface UsernameValidationResult {
  valid: boolean;
  error?: string;
  normalized?: string;
}

/**
 * Minimum username length.
 */
export const USERNAME_MIN_LENGTH = 3;

/**
 * Maximum username length.
 */
export const USERNAME_MAX_LENGTH = 30;

/**
 * Regex pattern for valid usernames.
 * - Alphanumeric and hyphens only
 * - No leading/trailing hyphens
 * - No consecutive hyphens
 */
export const USERNAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Reserved usernames that cannot be used.
 */
export const RESERVED_USERNAMES = new Set([
  "admin",
  "api",
  "app",
  "chat",
  "dashboard",
  "eliza",
  "elizaos",
  "help",
  "login",
  "logout",
  "me",
  "new",
  "null",
  "profile",
  "settings",
  "signup",
  "support",
  "system",
  "undefined",
  "user",
  "www",
]);

/**
 * Validates a username against all rules.
 *
 * @param username - The username to validate
 * @returns Validation result with error message if invalid
 */
export function validateUsername(username: string): UsernameValidationResult {
  // Normalize to lowercase
  const normalized = username.toLowerCase().trim();

  // Check length
  if (normalized.length < USERNAME_MIN_LENGTH) {
    return {
      valid: false,
      error: `Username must be at least ${USERNAME_MIN_LENGTH} characters`,
    };
  }

  if (normalized.length > USERNAME_MAX_LENGTH) {
    return {
      valid: false,
      error: `Username must be at most ${USERNAME_MAX_LENGTH} characters`,
    };
  }

  // Check pattern (alphanumeric + hyphens, no consecutive/leading/trailing hyphens)
  if (!USERNAME_PATTERN.test(normalized)) {
    // Provide specific error message
    if (normalized.startsWith("-") || normalized.endsWith("-")) {
      return {
        valid: false,
        error: "Username cannot start or end with a hyphen",
      };
    }
    if (normalized.includes("--")) {
      return {
        valid: false,
        error: "Username cannot contain consecutive hyphens",
      };
    }
    return {
      valid: false,
      error: "Username can only contain lowercase letters, numbers, and hyphens",
    };
  }

  // Check reserved usernames
  if (RESERVED_USERNAMES.has(normalized)) {
    return {
      valid: false,
      error: "This username is reserved",
    };
  }

  return {
    valid: true,
    normalized,
  };
}

/**
 * Converts a name to a URL-safe slug.
 *
 * @param name - The name to slugify
 * @returns A URL-safe slug
 *
 * @example
 * slugify("My Cool Agent") // "my-cool-agent"
 * slugify("Agent #1 (Test)") // "agent-1-test"
 * slugify("___Test---Agent___") // "test-agent"
 */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      // Replace spaces and underscores with hyphens
      .replace(/[\s_]+/g, "-")
      // Remove all non-alphanumeric characters except hyphens
      .replace(/[^a-z0-9-]/g, "")
      // Replace multiple consecutive hyphens with single hyphen
      .replace(/-+/g, "-")
      // Remove leading and trailing hyphens
      .replace(/^-+|-+$/g, "")
  );
}

/**
 * Pads a string to meet the minimum username length with random alphanumeric characters.
 *
 * @param str - The string to pad
 * @returns The padded string meeting minimum length requirements
 */
function padToMinLength(str: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  while (str.length < USERNAME_MIN_LENGTH) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}

/**
 * Generates a username from a name, ensuring it meets validation rules.
 *
 * @param name - The name to generate a username from
 * @returns A valid username (may need uniqueness check)
 */
export function generateUsernameFromName(name: string): string {
  let slug = slugify(name);

  // Ensure minimum length
  if (slug.length < USERNAME_MIN_LENGTH) {
    slug = padToMinLength(slug);
  }

  // Truncate if too long
  if (slug.length > USERNAME_MAX_LENGTH) {
    slug = slug.substring(0, USERNAME_MAX_LENGTH);
    // Remove trailing hyphen if truncation created one
    slug = slug.replace(/-+$/, "");
  }

  // If still too short after removing trailing hyphen, pad again
  // (e.g., name was "a-----------------------------------------")
  if (slug.length < USERNAME_MIN_LENGTH) {
    slug = padToMinLength(slug);
  }

  return slug;
}

/**
 * Generates a unique username by appending a numeric suffix if needed.
 *
 * @param baseUsername - The base username to make unique
 * @param existingUsernames - Set of existing usernames to check against
 * @returns A unique username
 *
 * @example
 * generateUniqueUsername("cool-agent", new Set(["cool-agent", "cool-agent-2"]))
 * // Returns "cool-agent-3"
 */
export function generateUniqueUsername(
  baseUsername: string,
  existingUsernames: Set<string>,
): string {
  // If base doesn't exist, use it
  if (!existingUsernames.has(baseUsername)) {
    return baseUsername;
  }

  // Ensure we don't exceed max length when adding suffix
  // Reserve space for "-999" (4 chars) to handle up to 999 collisions
  // Truncate BEFORE creating first candidate to prevent over-length usernames
  const maxBaseLength = USERNAME_MAX_LENGTH - 4;
  let truncatedBase = baseUsername;
  if (baseUsername.length > maxBaseLength) {
    truncatedBase = baseUsername.substring(0, maxBaseLength).replace(/-+$/, "");
  }

  // Try with numeric suffix (use truncatedBase from the start)
  let suffix = 2;
  let candidate = `${truncatedBase}-${suffix}`;

  while (existingUsernames.has(candidate) && suffix < 10000) {
    suffix++;
    candidate = `${truncatedBase}-${suffix}`;
  }

  // If we exhausted all attempts, throw an error instead of returning a duplicate
  if (existingUsernames.has(candidate)) {
    throw new Error("Unable to generate unique username after maximum attempts");
  }

  return candidate;
}

/**
 * Extracts username from a URL path like /chat/@username
 *
 * @param path - The URL path
 * @returns The username or null if not found
 */
export function extractUsernameFromPath(path: string): string | null {
  const match = path.match(/\/@([a-z0-9]+(?:-[a-z0-9]+)*)/);
  return match ? match[1] : null;
}
