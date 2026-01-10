import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getSetting } from "./utils/settings";
import { z } from "zod";

/**
 * Simplified Twitter environment schema
 * All time intervals are in minutes for consistency
 */
export const twitterEnvSchema = z.object({
  // Auth mode (backward compatible default)
  TWITTER_AUTH_MODE: z.enum(["env", "oauth", "broker"]).default("env"),

  // Required API credentials
  TWITTER_API_KEY: z.string().default(""),
  TWITTER_API_SECRET_KEY: z.string().default(""),
  TWITTER_ACCESS_TOKEN: z.string().default(""),
  TWITTER_ACCESS_TOKEN_SECRET: z.string().default(""),

  // OAuth2 PKCE (3-legged) configuration
  TWITTER_CLIENT_ID: z.string().default(""),
  TWITTER_REDIRECT_URI: z.string().default(""),
  TWITTER_SCOPES: z
    .string()
    .default("tweet.read tweet.write users.read offline.access"),

  // Broker scaffolding (stub)
  TWITTER_BROKER_URL: z.string().default(""),

  // Core configuration
  TWITTER_DRY_RUN: z.string().default("false"),
  TWITTER_TARGET_USERS: z.string().default(""), // comma-separated list, empty = all

  // Feature toggles
  TWITTER_ENABLE_POST: z.string().default("false"),
  TWITTER_ENABLE_REPLIES: z.string().default("true"),
  TWITTER_ENABLE_ACTIONS: z.string().default("false"), // likes, retweets, quotes

  // Timing configuration (all in minutes)
  TWITTER_POST_INTERVAL: z.string().default("120"), // minutes between posts (deprecated, kept for backwards compatibility)
  TWITTER_POST_INTERVAL_MIN: z.string().default("90"), // minimum minutes between posts
  TWITTER_POST_INTERVAL_MAX: z.string().default("180"), // maximum minutes between posts
  TWITTER_ENGAGEMENT_INTERVAL: z.string().default("30"), // minutes between all interactions (deprecated, kept for backwards compatibility)
  TWITTER_ENGAGEMENT_INTERVAL_MIN: z.string().default("20"), // minimum minutes between engagements
  TWITTER_ENGAGEMENT_INTERVAL_MAX: z.string().default("40"), // maximum minutes between engagements
  TWITTER_DISCOVERY_INTERVAL_MIN: z.string().default("15"), // minimum minutes between discovery cycles
  TWITTER_DISCOVERY_INTERVAL_MAX: z.string().default("30"), // maximum minutes between discovery cycles

  // Limits
  TWITTER_MAX_ENGAGEMENTS_PER_RUN: z.string().default("5"), // Reduced from 10 to be less aggressive
  TWITTER_MAX_TWEET_LENGTH: z.string().default("280"), // standard tweet length

  // Advanced
  TWITTER_RETRY_LIMIT: z.string().default("5"),
});

export type TwitterConfig = z.infer<typeof twitterEnvSchema>;

/**
 * Parse safe integer with fallback
 */
function safeParseInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Helper to parse a comma-separated list of Twitter usernames
 */
function parseTargetUsers(targetUsersStr?: string | null): string[] {
  if (!targetUsersStr?.trim()) {
    return [];
  }
  return targetUsersStr
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean);
}

/**
 * Check if a user should be targeted for interactions
 * Empty list means target everyone
 * "*" wildcard means target everyone explicitly
 */
export function shouldTargetUser(
  username: string,
  targetUsersConfig: string,
): boolean {
  if (!targetUsersConfig?.trim()) {
    return true; // Empty = interact with everyone
  }

  const targetUsers = parseTargetUsers(targetUsersConfig);

  if (targetUsers.includes("*")) {
    return true; // Wildcard = everyone
  }

  // Check if the username (without @) is in the target list
  const normalizedUsername = username.toLowerCase().replace(/^@/, "");
  return targetUsers.some(
    (target) => target.toLowerCase().replace(/^@/, "") === normalizedUsername,
  );
}

/**
 * Get parsed target users list
 */
export function getTargetUsers(targetUsersConfig: string): string[] {
  const users = parseTargetUsers(targetUsersConfig);
  // Filter out wildcard since it's a special case
  return users.filter((u) => u !== "*");
}

/**
 * Validates Twitter configuration using simplified schema
 */
export async function validateTwitterConfig(
  runtime: IAgentRuntime,
  config: Partial<TwitterConfig> = {},
): Promise<TwitterConfig> {
  try {
    const rawMode =
      (config as any).TWITTER_AUTH_MODE ??
      (getSetting(runtime, "TWITTER_AUTH_MODE") as any) ??
      "env";
    const normalizedMode =
      typeof rawMode === "string" && rawMode.trim() ? rawMode.trim() : "env";

    const validatedConfig: TwitterConfig = {
      TWITTER_AUTH_MODE: normalizedMode as any,
      TWITTER_API_KEY:
        config.TWITTER_API_KEY ?? getSetting(runtime, "TWITTER_API_KEY") ?? "",
      TWITTER_API_SECRET_KEY:
        config.TWITTER_API_SECRET_KEY ??
        getSetting(runtime, "TWITTER_API_SECRET_KEY") ??
        "",
      TWITTER_ACCESS_TOKEN:
        config.TWITTER_ACCESS_TOKEN ??
        getSetting(runtime, "TWITTER_ACCESS_TOKEN") ??
        "",
      TWITTER_ACCESS_TOKEN_SECRET:
        config.TWITTER_ACCESS_TOKEN_SECRET ??
        getSetting(runtime, "TWITTER_ACCESS_TOKEN_SECRET") ??
        "",
      TWITTER_CLIENT_ID:
        (config as any).TWITTER_CLIENT_ID ??
        getSetting(runtime, "TWITTER_CLIENT_ID") ??
        "",
      TWITTER_REDIRECT_URI:
        (config as any).TWITTER_REDIRECT_URI ??
        getSetting(runtime, "TWITTER_REDIRECT_URI") ??
        "",
      TWITTER_SCOPES:
        (config as any).TWITTER_SCOPES ??
        getSetting(runtime, "TWITTER_SCOPES") ??
        "tweet.read tweet.write users.read offline.access",
      TWITTER_BROKER_URL:
        (config as any).TWITTER_BROKER_URL ??
        getSetting(runtime, "TWITTER_BROKER_URL") ??
        "",
      TWITTER_DRY_RUN: String(
        (
          config.TWITTER_DRY_RUN ??
          getSetting(runtime, "TWITTER_DRY_RUN") ??
          "false"
        ).toLowerCase() === "true",
      ),
      TWITTER_TARGET_USERS:
        config.TWITTER_TARGET_USERS ??
        getSetting(runtime, "TWITTER_TARGET_USERS") ??
        "",
      TWITTER_ENABLE_POST: String(
        (
          config.TWITTER_ENABLE_POST ??
          getSetting(runtime, "TWITTER_ENABLE_POST") ??
          "false"
        ).toLowerCase() === "true",
      ),
      TWITTER_ENABLE_REPLIES: String(
        config.TWITTER_ENABLE_REPLIES !== undefined
          ? config.TWITTER_ENABLE_REPLIES.toLowerCase() === "true"
          : (
              getSetting(runtime, "TWITTER_ENABLE_REPLIES") ?? "true"
            ).toLowerCase() === "true",
      ),
      TWITTER_ENABLE_ACTIONS: String(
        (
          config.TWITTER_ENABLE_ACTIONS ??
          getSetting(runtime, "TWITTER_ENABLE_ACTIONS") ??
          "false"
        ).toLowerCase() === "true",
      ),
      TWITTER_POST_INTERVAL: String(
        safeParseInt(
          config.TWITTER_POST_INTERVAL ??
            getSetting(runtime, "TWITTER_POST_INTERVAL"),
          120,
        ),
      ),
      TWITTER_POST_INTERVAL_MIN: String(
        safeParseInt(
          config.TWITTER_POST_INTERVAL_MIN ??
            getSetting(runtime, "TWITTER_POST_INTERVAL_MIN"),
          90,
        ),
      ),
      TWITTER_POST_INTERVAL_MAX: String(
        safeParseInt(
          config.TWITTER_POST_INTERVAL_MAX ??
            getSetting(runtime, "TWITTER_POST_INTERVAL_MAX"),
          180,
        ),
      ),
      TWITTER_ENGAGEMENT_INTERVAL: String(
        safeParseInt(
          config.TWITTER_ENGAGEMENT_INTERVAL ??
            getSetting(runtime, "TWITTER_ENGAGEMENT_INTERVAL"),
          30,
        ),
      ),
      TWITTER_ENGAGEMENT_INTERVAL_MIN: String(
        safeParseInt(
          config.TWITTER_ENGAGEMENT_INTERVAL_MIN ??
            getSetting(runtime, "TWITTER_ENGAGEMENT_INTERVAL_MIN"),
          20,
        ),
      ),
      TWITTER_ENGAGEMENT_INTERVAL_MAX: String(
        safeParseInt(
          config.TWITTER_ENGAGEMENT_INTERVAL_MAX ??
            getSetting(runtime, "TWITTER_ENGAGEMENT_INTERVAL_MAX"),
          40,
        ),
      ),
      TWITTER_DISCOVERY_INTERVAL_MIN: String(
        safeParseInt(
          config.TWITTER_DISCOVERY_INTERVAL_MIN ??
            getSetting(runtime, "TWITTER_DISCOVERY_INTERVAL_MIN"),
          15,
        ),
      ),
      TWITTER_DISCOVERY_INTERVAL_MAX: String(
        safeParseInt(
          config.TWITTER_DISCOVERY_INTERVAL_MAX ??
            getSetting(runtime, "TWITTER_DISCOVERY_INTERVAL_MAX"),
          30,
        ),
      ),
      TWITTER_MAX_ENGAGEMENTS_PER_RUN: String(
        safeParseInt(
          config.TWITTER_MAX_ENGAGEMENTS_PER_RUN ??
            getSetting(runtime, "TWITTER_MAX_ENGAGEMENTS_PER_RUN"),
          5,
        ),
      ),
      TWITTER_MAX_TWEET_LENGTH: String(
        safeParseInt(
          config.TWITTER_MAX_TWEET_LENGTH ??
            getSetting(runtime, "TWITTER_MAX_TWEET_LENGTH"),
          280,
        ),
      ),
      TWITTER_RETRY_LIMIT: String(
        safeParseInt(
          config.TWITTER_RETRY_LIMIT ??
            getSetting(runtime, "TWITTER_RETRY_LIMIT"),
          5,
        ),
      ),
    };

    // Validate required credentials
    const mode = (validatedConfig.TWITTER_AUTH_MODE || "env").toLowerCase();
    if (mode === "env") {
      if (
        !validatedConfig.TWITTER_API_KEY ||
        !validatedConfig.TWITTER_API_SECRET_KEY ||
        !validatedConfig.TWITTER_ACCESS_TOKEN ||
        !validatedConfig.TWITTER_ACCESS_TOKEN_SECRET
      ) {
        throw new Error(
          "Twitter env auth is selected (TWITTER_AUTH_MODE=env). Please set TWITTER_API_KEY, TWITTER_API_SECRET_KEY, TWITTER_ACCESS_TOKEN, and TWITTER_ACCESS_TOKEN_SECRET",
        );
      }
    } else if (mode === "oauth") {
      if (!validatedConfig.TWITTER_CLIENT_ID || !validatedConfig.TWITTER_REDIRECT_URI) {
        throw new Error(
          "Twitter OAuth is selected (TWITTER_AUTH_MODE=oauth). Please set TWITTER_CLIENT_ID and TWITTER_REDIRECT_URI",
        );
      }
    } else if (mode === "broker") {
      if (!validatedConfig.TWITTER_BROKER_URL) {
        throw new Error(
          "Twitter broker auth is selected (TWITTER_AUTH_MODE=broker). Please set TWITTER_BROKER_URL",
        );
      }
    } else {
      throw new Error(
        `Invalid TWITTER_AUTH_MODE=${validatedConfig.TWITTER_AUTH_MODE}. Expected env|oauth|broker.`,
      );
    }

    return twitterEnvSchema.parse(validatedConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues: Array<{ path: (string | number)[]; message: string }> =
        // zod v3 uses `issues`; some builds also expose `errors`
        ((error as any).issues ?? (error as any).errors ?? []) as any;
      const errorMessages = issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join(", ");
      throw new Error(
        `Twitter configuration validation failed: ${errorMessages}`,
      );
    }
    throw error;
  }
}

/**
 * Get configuration from environment variables
 * @returns Partial<TwitterConfig>
 */
function getEnvConfig(): Partial<TwitterConfig> {
  const config: Partial<TwitterConfig> = {};

  const getConfig = (key: keyof TwitterConfig): string | undefined => {
    if (typeof process !== "undefined" && process.env) {
      return process.env[key];
    }
    return undefined;
  };

  // Map all environment variables
  Object.keys(twitterEnvSchema.shape).forEach((key) => {
    const value = getConfig(key as keyof TwitterConfig);
    if (value !== undefined) {
      config[key as keyof TwitterConfig] = value;
    }
  });

  return config;
}

/**
 * Get default configuration
 * @returns TwitterConfig with default values
 */
function getDefaultConfig(): TwitterConfig {
  const getConfig = (key: keyof TwitterConfig): string | undefined => {
    if (typeof process !== "undefined" && process.env) {
      return process.env[key];
    }
    return undefined;
  };

  return {
    TWITTER_AUTH_MODE: (getConfig("TWITTER_AUTH_MODE") as any) || "env",
    TWITTER_API_KEY: getConfig("TWITTER_API_KEY") || "",
    TWITTER_API_SECRET_KEY: getConfig("TWITTER_API_SECRET_KEY") || "",
    TWITTER_ACCESS_TOKEN: getConfig("TWITTER_ACCESS_TOKEN") || "",
    TWITTER_ACCESS_TOKEN_SECRET: getConfig("TWITTER_ACCESS_TOKEN_SECRET") || "",
    TWITTER_CLIENT_ID: getConfig("TWITTER_CLIENT_ID") || "",
    TWITTER_REDIRECT_URI: getConfig("TWITTER_REDIRECT_URI") || "",
    TWITTER_SCOPES:
      getConfig("TWITTER_SCOPES") ||
      "tweet.read tweet.write users.read offline.access",
    TWITTER_BROKER_URL: getConfig("TWITTER_BROKER_URL") || "",
    TWITTER_DRY_RUN: getConfig("TWITTER_DRY_RUN") || "false",
    TWITTER_TARGET_USERS: getConfig("TWITTER_TARGET_USERS") || "",
    TWITTER_ENABLE_POST: getConfig("TWITTER_ENABLE_POST") || "false",
    TWITTER_ENABLE_REPLIES: getConfig("TWITTER_ENABLE_REPLIES") || "true",
    TWITTER_ENABLE_ACTIONS: getConfig("TWITTER_ENABLE_ACTIONS") || "false",
    TWITTER_POST_INTERVAL: getConfig("TWITTER_POST_INTERVAL") || "120",
    TWITTER_POST_INTERVAL_MIN: getConfig("TWITTER_POST_INTERVAL_MIN") || "90",
    TWITTER_POST_INTERVAL_MAX: getConfig("TWITTER_POST_INTERVAL_MAX") || "180",
    TWITTER_ENGAGEMENT_INTERVAL:
      getConfig("TWITTER_ENGAGEMENT_INTERVAL") || "30",
    TWITTER_ENGAGEMENT_INTERVAL_MIN: getConfig("TWITTER_ENGAGEMENT_INTERVAL_MIN") || "20",
    TWITTER_ENGAGEMENT_INTERVAL_MAX: getConfig("TWITTER_ENGAGEMENT_INTERVAL_MAX") || "40",
    TWITTER_DISCOVERY_INTERVAL_MIN: getConfig("TWITTER_DISCOVERY_INTERVAL_MIN") || "15",
    TWITTER_DISCOVERY_INTERVAL_MAX: getConfig("TWITTER_DISCOVERY_INTERVAL_MAX") || "30",
    TWITTER_MAX_ENGAGEMENTS_PER_RUN:
      getConfig("TWITTER_MAX_ENGAGEMENTS_PER_RUN") || "5",
    TWITTER_MAX_TWEET_LENGTH: getConfig("TWITTER_MAX_TWEET_LENGTH") || "280",
    TWITTER_RETRY_LIMIT: getConfig("TWITTER_RETRY_LIMIT") || "5",
  };
}

/**
 * Load configuration from file (stub for future implementation)
 * @param configPath - Path to the configuration file (optional)
 * @returns Partial TwitterConfig object
 */
export function loadConfigFromFile(
  configPath?: string,
): Partial<TwitterConfig> {
  // For now, return empty config as file loading is not implemented
  return {};
}

/**
 * Load merged configuration from all sources
 * @param configPath - Path to the configuration file (optional)
 * @returns Complete TwitterConfig object
 */
export function loadConfig(configPath?: string): TwitterConfig {
  const fileConfig = loadConfigFromFile(configPath);

  return {
    ...getDefaultConfig(),
    ...fileConfig,
    ...getEnvConfig(),
  };
}

/**
 * Validate configuration
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateConfig(config: unknown): TwitterConfig {
  return twitterEnvSchema.parse(config);
}

/**
 * Get a random interval between min and max values
 * If min/max are not configured, falls back to the fixed interval
 * 
 * @param runtime - The agent runtime
 * @param type - The type of interval ('post', 'engagement', 'discovery')
 * @returns Random interval in minutes
 */
export function getRandomInterval(
  runtime: IAgentRuntime,
  type: 'post' | 'engagement' | 'discovery',
): number {
  let minInterval: number | undefined;
  let maxInterval: number | undefined;
  let fallbackInterval: number;

  switch (type) {
    case 'post':
      const postMin = getSetting(runtime, "TWITTER_POST_INTERVAL_MIN") as string;
      const postMax = getSetting(runtime, "TWITTER_POST_INTERVAL_MAX") as string;
      minInterval = postMin ? safeParseInt(postMin, 0) : undefined;
      maxInterval = postMax ? safeParseInt(postMax, 0) : undefined;
      fallbackInterval = safeParseInt(
        getSetting(runtime, "TWITTER_POST_INTERVAL") as string,
        120
      );
      break;
    case 'engagement':
      const engagementMin = getSetting(runtime, "TWITTER_ENGAGEMENT_INTERVAL_MIN") as string;
      const engagementMax = getSetting(runtime, "TWITTER_ENGAGEMENT_INTERVAL_MAX") as string;
      minInterval = engagementMin ? safeParseInt(engagementMin, 0) : undefined;
      maxInterval = engagementMax ? safeParseInt(engagementMax, 0) : undefined;
      fallbackInterval = safeParseInt(
        getSetting(runtime, "TWITTER_ENGAGEMENT_INTERVAL") as string,
        30
      );
      break;
    case 'discovery':
      const discoveryMin = getSetting(runtime, "TWITTER_DISCOVERY_INTERVAL_MIN") as string;
      const discoveryMax = getSetting(runtime, "TWITTER_DISCOVERY_INTERVAL_MAX") as string;
      minInterval = discoveryMin ? safeParseInt(discoveryMin, 0) : undefined;
      maxInterval = discoveryMax ? safeParseInt(discoveryMax, 0) : undefined;
      fallbackInterval = 20; // Default discovery interval
      break;
    default:
      throw new Error(`Unknown interval type: ${type}`);
  }

  // If MIN/MAX are properly configured, use random value between them
  if (minInterval !== undefined && maxInterval !== undefined && minInterval < maxInterval) {
    const randomInterval = Math.random() * (maxInterval - minInterval) + minInterval;
    logger.debug(`Random ${type} interval: ${randomInterval.toFixed(1)} minutes (between ${minInterval}-${maxInterval})`);
    return randomInterval;
  }

  // Otherwise, fall back to fixed interval
  logger.debug(`Using fixed ${type} interval: ${fallbackInterval} minutes`);
  return fallbackInterval;
}
