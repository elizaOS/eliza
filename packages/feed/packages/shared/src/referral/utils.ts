/**
 * Referral Utility Functions
 *
 * Centralized utilities for generating and handling referral URLs.
 */

/**
 * Get the base URL for the application
 * Uses window.location.origin in browser, falls back to env variable or default
 */
export function getReferralAppBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_APP_URL || 'https://babylon.market';
}

/**
 * Get the base URL for the waitlist (canonical referral destination).
 *
 * When you run the app on a separate subdomain (ex: app.babylon.market),
 * referrals should generally land on the waitlist domain (babylon.market).
 */
export function getWaitlistBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_WAITLIST_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname.toLowerCase();
    if (hostname.endsWith('staging.babylon.market')) {
      return 'https://staging.babylon.market';
    }
    if (hostname.endsWith('babylon.market')) {
      return 'https://babylon.market';
    }
    return window.location.origin;
  }

  return 'https://babylon.market';
}

/**
 * Generate a shareable referral URL for a user
 *
 * @param usernameOrCode - The user's username or referral code
 * @returns Full shareable referral URL (e.g., https://babylon.market?ref=babylon)
 *
 * @example
 * ```typescript
 * const url = getReferralUrl('babylon')
 * // Returns: "https://babylon.market?ref=babylon"
 * ```
 */
export function getReferralUrl(usernameOrCode: string): string {
  const baseUrl = getWaitlistBaseUrl();
  return `${baseUrl}?ref=${encodeURIComponent(usernameOrCode)}`;
}

/**
 * Format referral URL for display (truncated)
 *
 * @param usernameOrCode - The user's username or referral code
 * @returns Display-friendly referral URL
 *
 * @example
 * ```typescript
 * const display = getDisplayReferralUrl('babylon')
 * // Returns: "localhost:3000?ref=babylon"
 * ```
 */
export function getDisplayReferralUrl(usernameOrCode: string): string {
  const host =
    typeof window !== 'undefined' ? window.location.host : 'babylon.market';
  return `${host}?ref=${usernameOrCode}`;
}

/**
 * Generate referral share text for social media
 *
 * @param usernameOrCode - The user's username or referral code
 * @param customMessage - Optional custom message (default: "Join me on Babylon! 🎮")
 * @returns Formatted text with referral URL for sharing
 *
 * @example
 * ```typescript
 * const text = getReferralShareText('babylon')
 * // Returns: "Join me on Babylon! 🎮\n\nhttps://babylon.market?ref=babylon"
 * ```
 */
export function getReferralShareText(
  usernameOrCode: string,
  customMessage?: string
): string {
  const message =
    customMessage ||
    'Join me in Babylon, a real-time simulation where humans and AI agents battle across prediction markets, form alliances, and shape outcomes—together.';
  const url = getReferralUrl(usernameOrCode);
  return `${message}\n\n${url}`;
}
