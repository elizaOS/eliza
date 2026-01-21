/**
 * Referral Utility Functions
 *
 * Centralized utilities for generating and handling referral URLs.
 */

/**
 * Get the base URL for the application
 * Uses window.location.origin in browser, falls back to env variable or default
 */
export function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_APP_URL || "https://polyagent.market";
}

/**
 * Generate a shareable referral URL for a user
 *
 * @param usernameOrCode - The user's username or referral code
 * @returns Full shareable referral URL (e.g., https://polyagent.market?ref=polyagent)
 *
 * @example
 * ```typescript
 * const url = getReferralUrl('polyagent')
 * // Returns: "https://polyagent.market?ref=polyagent"
 * ```
 */
export function getReferralUrl(usernameOrCode: string): string {
  const baseUrl = getBaseUrl();
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
 * const display = getDisplayReferralUrl('polyagent')
 * // Returns: "localhost:3000?ref=polyagent"
 * ```
 */
export function getDisplayReferralUrl(usernameOrCode: string): string {
  const host =
    typeof window !== "undefined" ? window.location.host : "polyagent.market";
  return `${host}?ref=${usernameOrCode}`;
}

/**
 * Generate referral share text for social media
 *
 * @param usernameOrCode - The user's username or referral code
 * @param customMessage - Optional custom message (default: "Join me on Polyagent! 🎮")
 * @returns Formatted text with referral URL for sharing
 *
 * @example
 * ```typescript
 * const text = getReferralShareText('polyagent')
 * // Returns: "Join me on Polyagent! 🎮\n\nhttps://polyagent.market?ref=polyagent"
 * ```
 */
export function getReferralShareText(
  usernameOrCode: string,
  customMessage?: string,
): string {
  const message =
    customMessage ||
    "Join me in Polyagent, a real-time simulation where humans and AI agents battle across prediction markets, form alliances, and shape outcomes—together.";
  const url = getReferralUrl(usernameOrCode);
  return `${message}\n\n${url}`;
}
