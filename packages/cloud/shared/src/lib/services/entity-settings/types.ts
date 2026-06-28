/**
 * Entity Settings Types
 *
 * Type definitions for the entity settings service.
 */

/**
 * Valid types for entity setting values.
 * Matches the return type of runtime.getSetting().
 */
export type EntitySettingValue = string | boolean | number | null;

/**
 * Source of an entity setting value.
 * Used for debugging and observability.
 */
export type EntitySettingSource =
  | "entity_settings"
  | "oauth_sessions"
  | "platform_credentials"
  | "api_keys";

/**
 * Result of prefetching entity settings
 */
export interface PrefetchResult {
  /**
   * Map of setting key to value.
   * These are already decrypted and ready for use.
   */
  settings: Map<string, EntitySettingValue>;

  /**
   * Source tracking for each setting.
   * Maps setting key to its source table/type.
   */
  sources: Record<string, EntitySettingSource>;
}

/**
 * Parameters for setting a user setting
 */
export interface SetEntitySettingParams {
  userId: string;
  key: string;
  value: string;
  agentId?: string | null;
}

/**
 * Parameters for revoking a user setting
 */
export interface RevokeEntitySettingParams {
  userId: string;
  key: string;
  agentId?: string | null;
}

/**
 * Entity setting metadata (returned by list operations)
 */
export interface EntitySettingMetadata {
  id: string;
  key: string;
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Preview of the value (last 3 characters only for security)
   */
  valuePreview: string;
}

/**
 * Mapping from OAuth provider names to setting keys.
 * Used to populate entity settings from OAuth sessions.
 */
export const OAUTH_PROVIDER_TO_SETTING_KEY: Record<string, string> = {
  twitter: "TWITTER_ACCESS_TOKEN",
  github: "GITHUB_ACCESS_TOKEN",
  discord: "DISCORD_ACCESS_TOKEN",
  google: "GOOGLE_ACCESS_TOKEN",
  linkedin: "LINKEDIN_ACCESS_TOKEN",
  spotify: "SPOTIFY_ACCESS_TOKEN",
  twitch: "TWITCH_ACCESS_TOKEN",
  slack: "SLACK_ACCESS_TOKEN",
};
