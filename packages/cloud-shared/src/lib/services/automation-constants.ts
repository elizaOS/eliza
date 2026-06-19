/**
 * Shared constants for automation services (Discord, Telegram, Twitter)
 *
 * Centralizes default configuration values to avoid duplication
 * and ensure consistency across services.
 */

// Announcement interval defaults (in minutes)
export const AUTOMATION_INTERVALS = {
  /** Minimum interval between announcements (minutes) */
  DEFAULT_MIN: 120, // 2 hours
  /** Maximum interval between announcements (minutes) */
  DEFAULT_MAX: 240, // 4 hours
  /** Absolute minimum allowed interval (minutes) */
  MIN_ALLOWED: 30,
  /** Absolute maximum allowed interval (minutes) */
  MAX_ALLOWED: 1440, // 24 hours
} as const;

// Discord automation defaults
export const DISCORD_AUTOMATION_DEFAULTS = {
  enabled: false,
  autoAnnounce: false,
  announceIntervalMin: AUTOMATION_INTERVALS.DEFAULT_MIN,
  announceIntervalMax: AUTOMATION_INTERVALS.DEFAULT_MAX,
} as const;

// Telegram automation defaults
export const TELEGRAM_AUTOMATION_DEFAULTS = {
  enabled: false,
  autoReply: true,
  autoAnnounce: false,
  announceIntervalMin: AUTOMATION_INTERVALS.DEFAULT_MIN,
  announceIntervalMax: AUTOMATION_INTERVALS.DEFAULT_MAX,
} as const;

// Twitter automation defaults
export const TWITTER_AUTOMATION_DEFAULTS = {
  enabled: false,
  autoPost: false,
  autoReply: false,
  autoEngage: false,
  discovery: false,
  postIntervalMin: AUTOMATION_INTERVALS.DEFAULT_MIN,
  postIntervalMax: AUTOMATION_INTERVALS.DEFAULT_MAX,
} as const;

/**
 * Helper to get Discord config with defaults applied
 */
export function getDiscordConfigWithDefaults(config: Record<string, unknown> | null | undefined) {
  return {
    ...DISCORD_AUTOMATION_DEFAULTS,
    ...config,
  };
}

/**
 * Helper to get Telegram config with defaults applied
 */
export function getTelegramConfigWithDefaults(config: Record<string, unknown> | null | undefined) {
  return {
    ...TELEGRAM_AUTOMATION_DEFAULTS,
    ...config,
  };
}

/**
 * Helper to get Twitter config with defaults applied
 */
export function getTwitterConfigWithDefaults(config: Record<string, unknown> | null | undefined) {
  return {
    ...TWITTER_AUTOMATION_DEFAULTS,
    ...config,
  };
}
