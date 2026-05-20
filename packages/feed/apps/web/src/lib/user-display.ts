/**
 * Centralized display name and handle resolution for user-like objects.
 * Keeps fallback order and default labels consistent across the app.
 */

export interface UserDisplayFields {
  displayName?: string | null;
  username?: string | null;
  email?: string | null;
  farcasterUsername?: string | null;
  twitterUsername?: string | null;
  walletAddress?: string | null;
}

/**
 * Resolve a display name from user-like object with consistent fallback order.
 * @param user - Object with displayName, username, email, etc.
 * @param fallback - Default when no name is available (default: 'User')
 */
export function getUserDisplayName(
  user: UserDisplayFields | null | undefined,
  fallback = 'User'
): string {
  if (!user) return fallback;
  const name =
    user.displayName ??
    user.username ??
    user.email ??
    user.farcasterUsername ??
    user.twitterUsername ??
    user.walletAddress ??
    '';
  return name.toString().trim() || fallback;
}

/**
 * Resolve a handle (username/handle) for mentions or secondary display.
 * @param fallback - Default when no handle is available (default: '')
 */
export function getUserHandle(
  user:
    | Pick<
        UserDisplayFields,
        'username' | 'farcasterUsername' | 'twitterUsername' | 'walletAddress'
      >
    | null
    | undefined,
  fallback = ''
): string {
  if (!user) return fallback;
  const handle =
    user.username ??
    user.farcasterUsername ??
    user.twitterUsername ??
    user.walletAddress ??
    '';
  const s = handle.toString().trim();
  return s || fallback;
}
