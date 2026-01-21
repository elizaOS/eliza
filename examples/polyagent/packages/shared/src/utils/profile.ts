/**
 * Profile URL Utility Functions
 *
 * @description Utility functions for generating profile URLs and identifying
 * usernames vs user IDs. Handles username preference and identifier parsing.
 */

/**
 * Generate a profile URL for a user
 *
 * @description Creates a profile URL preferring username if available, falling
 * back to user ID. Automatically strips @ prefix from usernames.
 *
 * @param {string} userId - User ID to use as fallback
 * @param {string | null | undefined} username - Optional username (preferred)
 * @returns {string} Profile URL path (e.g., "/profile/username" or "/profile/userId")
 *
 * @example
 * ```typescript
 * getProfileUrl('user_123', 'alice') // Returns "/profile/alice"
 * getProfileUrl('user_123', null) // Returns "/profile/user_123"
 * getProfileUrl('user_123', '@alice') // Returns "/profile/alice"
 * ```
 */
export function getProfileUrl(
  userId: string,
  username?: string | null,
): string {
  if (username) {
    // Strip @ if present and use clean username
    const cleanUsername = username.startsWith("@")
      ? username.slice(1)
      : username;
    return `/profile/${cleanUsername}`;
  }
  return `/profile/${userId}`;
}

/**
 * Check if a profile identifier is a username (not a user ID)
 *
 * @description Determines if an identifier string is a username rather than
 * a user ID. User IDs are typically DIDs (did:privy:...), UUIDs, or contain
 * dashes. Usernames are shorter strings without special patterns.
 *
 * @param {string} identifier - The identifier to check
 * @returns {boolean} True if the identifier appears to be a username
 *
 * @example
 * ```typescript
 * isUsername('alice') // Returns true
 * isUsername('did:privy:abc123') // Returns false
 * isUsername('@alice') // Returns true
 * isUsername('550e8400-e29b-41d4-a716-446655440000') // Returns false (UUID)
 * ```
 */
export function isUsername(identifier: string): boolean {
  // If it starts with @, it's definitely a username
  if (identifier.startsWith("@")) {
    return true;
  }

  // If it contains "privy" anywhere, it's definitely a user ID, not a username
  if (identifier.toLowerCase().includes("privy")) {
    return false;
  }

  // If it starts with "did:", it's a DID (user ID)
  if (identifier.startsWith("did:")) {
    return false;
  }

  // If it's a UUID format (contains dashes in UUID pattern), it's a user ID
  // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(identifier)) {
    return false;
  }

  // If it's a short string without dashes and not a DID, it's likely a username
  // User IDs are typically: "did:privy:..." (long) or UUIDs (contain dashes)
  return identifier.length <= 42 && !identifier.includes("-");
}

/**
 * Extract username from identifier (removes @ prefix if present)
 *
 * @description Extracts a clean username from an identifier string, removing
 * the @ prefix if present. Useful for normalizing username inputs.
 *
 * @param {string} identifier - The identifier to extract username from
 * @returns {string} Clean username without @ prefix
 *
 * @example
 * ```typescript
 * extractUsername('@alice') // Returns "alice"
 * extractUsername('alice') // Returns "alice"
 * ```
 */
export function extractUsername(identifier: string): string {
  return identifier.startsWith("@") ? identifier.slice(1) : identifier;
}
