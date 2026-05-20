/**
 * Shared constants for the web app
 */

/**
 * Maximum reply count to display before showing "X+"
 * Used for efficient BFS counting in deeply nested comment threads
 */
export const MAX_REPLY_COUNT = 99;

/**
 * Number of messages to load per page in chat
 * Used for initial load and infinite scroll pagination
 */
export const CHAT_PAGE_SIZE = 50;

/**
 * Points cost per message for each model tier
 * Used in agent chat API and settings UI
 */
export const MODEL_TIER_POINTS_COST = {
  free: 0,
  pro: 1,
} as const;

/**
 * External links used across marketing/waitlist surfaces.
 * Keep these centralized to avoid diverging URLs between states/pages.
 */
export const EXTERNAL_LINKS = {
  docs: 'https://docs.feed.market',
  blog:
    process.env.NEXT_PUBLIC_BLOG_URL?.trim() || 'https://blog.feed.market',
  github: 'https://github.com/FeedSocial/feed',
  website: 'https://feed.market',
  xProfile: 'https://x.com/PlayFeed',
  xFollowIntent: 'https://x.com/intent/follow?screen_name=PlayFeed',
  discordInvite:
    process.env.NEXT_PUBLIC_DISCORD_INVITE_URL?.trim() ||
    'https://discord.gg/ukKRJtYQ7q',
  farcasterProfile: 'https://warpcast.com/playfeed',
  farcaster: 'https://farcaster.xyz',
  privacyPolicy: 'https://docs.feed.market/legal/privacy-policy/',
  termsOfService: 'https://docs.feed.market/legal/terms-of-service/',
} as const;
