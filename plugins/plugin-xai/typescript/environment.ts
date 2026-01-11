import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import { getSetting } from "./utils/settings";

/**
 * Get setting with X_ prefix, falling back to TWITTER_ for compatibility
 */
function getXSetting(runtime: IAgentRuntime, key: string): string {
  const xKey = key.replace(/^TWITTER_/, "X_").replace(/^X_API_SECRET_KEY$/, "X_API_SECRET");
  return getSetting(runtime, xKey) || getSetting(runtime, key) || "";
}

export const xEnvSchema = z.object({
  X_AUTH_MODE: z.enum(["env", "oauth", "bearer"]).default("env"),
  X_API_KEY: z.string().default(""),
  X_API_SECRET: z.string().default(""),
  X_ACCESS_TOKEN: z.string().default(""),
  X_ACCESS_TOKEN_SECRET: z.string().default(""),
  X_BEARER_TOKEN: z.string().default(""),
  X_CLIENT_ID: z.string().default(""),
  X_REDIRECT_URI: z.string().default(""),
  X_DRY_RUN: z.string().default("false"),
  X_TARGET_USERS: z.string().default(""),
  X_ENABLE_POST: z.string().default("false"),
  X_ENABLE_REPLIES: z.string().default("true"),
  X_ENABLE_ACTIONS: z.string().default("false"),
  X_ENABLE_DISCOVERY: z.string().default("false"),
  X_POST_INTERVAL_MIN: z.string().default("90"),
  X_POST_INTERVAL_MAX: z.string().default("180"),
  X_ENGAGEMENT_INTERVAL_MIN: z.string().default("20"),
  X_ENGAGEMENT_INTERVAL_MAX: z.string().default("40"),
  X_DISCOVERY_INTERVAL_MIN: z.string().default("15"),
  X_DISCOVERY_INTERVAL_MAX: z.string().default("30"),
  X_MAX_ENGAGEMENTS_PER_RUN: z.string().default("5"),
  X_MAX_POST_LENGTH: z.string().default("280"),
  X_RETRY_LIMIT: z.string().default("5"),
});

export type XConfig = z.infer<typeof xEnvSchema>;
export const twitterEnvSchema = xEnvSchema;
export type TwitterConfig = XConfig;

function parseTargetUsers(str: string): string[] {
  if (!str.trim()) return [];
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function shouldTargetUser(username: string, targetConfig: string): boolean {
  if (!targetConfig.trim()) return true;
  const targets = parseTargetUsers(targetConfig);
  if (targets.includes("*")) return true;
  const normalized = username.toLowerCase().replace(/^@/, "");
  return targets.some((t) => t.toLowerCase().replace(/^@/, "") === normalized);
}

export function getTargetUsers(targetConfig: string): string[] {
  return parseTargetUsers(targetConfig).filter((u) => u !== "*");
}

export async function validateXConfig(runtime: IAgentRuntime): Promise<XConfig> {
  const mode = (getXSetting(runtime, "X_AUTH_MODE") || "env").toLowerCase();

  const config: XConfig = {
    X_AUTH_MODE: mode as "env" | "oauth" | "bearer",
    X_API_KEY: getXSetting(runtime, "X_API_KEY"),
    X_API_SECRET: getXSetting(runtime, "X_API_SECRET") || getXSetting(runtime, "X_API_SECRET_KEY"),
    X_ACCESS_TOKEN: getXSetting(runtime, "X_ACCESS_TOKEN"),
    X_ACCESS_TOKEN_SECRET: getXSetting(runtime, "X_ACCESS_TOKEN_SECRET"),
    X_BEARER_TOKEN: getXSetting(runtime, "X_BEARER_TOKEN"),
    X_CLIENT_ID: getXSetting(runtime, "X_CLIENT_ID"),
    X_REDIRECT_URI: getXSetting(runtime, "X_REDIRECT_URI"),
    X_DRY_RUN: getXSetting(runtime, "X_DRY_RUN") || "false",
    X_TARGET_USERS: getXSetting(runtime, "X_TARGET_USERS"),
    X_ENABLE_POST: getXSetting(runtime, "X_ENABLE_POST") || "false",
    X_ENABLE_REPLIES: getXSetting(runtime, "X_ENABLE_REPLIES") || "true",
    X_ENABLE_ACTIONS: getXSetting(runtime, "X_ENABLE_ACTIONS") || "false",
    X_ENABLE_DISCOVERY: getXSetting(runtime, "X_ENABLE_DISCOVERY") || "false",
    X_POST_INTERVAL_MIN: getXSetting(runtime, "X_POST_INTERVAL_MIN") || "90",
    X_POST_INTERVAL_MAX: getXSetting(runtime, "X_POST_INTERVAL_MAX") || "180",
    X_ENGAGEMENT_INTERVAL_MIN: getXSetting(runtime, "X_ENGAGEMENT_INTERVAL_MIN") || "20",
    X_ENGAGEMENT_INTERVAL_MAX: getXSetting(runtime, "X_ENGAGEMENT_INTERVAL_MAX") || "40",
    X_DISCOVERY_INTERVAL_MIN: getXSetting(runtime, "X_DISCOVERY_INTERVAL_MIN") || "15",
    X_DISCOVERY_INTERVAL_MAX: getXSetting(runtime, "X_DISCOVERY_INTERVAL_MAX") || "30",
    X_MAX_ENGAGEMENTS_PER_RUN: getXSetting(runtime, "X_MAX_ENGAGEMENTS_PER_RUN") || "5",
    X_MAX_POST_LENGTH: getXSetting(runtime, "X_MAX_POST_LENGTH") || "280",
    X_RETRY_LIMIT: getXSetting(runtime, "X_RETRY_LIMIT") || "5",
  };

  if (mode === "env") {
    if (
      !config.X_API_KEY ||
      !config.X_API_SECRET ||
      !config.X_ACCESS_TOKEN ||
      !config.X_ACCESS_TOKEN_SECRET
    ) {
      throw new Error(
        "X env auth requires X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET"
      );
    }
  } else if (mode === "bearer") {
    if (!config.X_BEARER_TOKEN) {
      throw new Error("X bearer auth requires X_BEARER_TOKEN");
    }
  } else if (mode === "oauth") {
    if (!config.X_CLIENT_ID || !config.X_REDIRECT_URI) {
      throw new Error("X OAuth requires X_CLIENT_ID and X_REDIRECT_URI");
    }
  }

  return xEnvSchema.parse(config);
}

export const validateTwitterConfig = validateXConfig;

function parseInterval(value: string, fallback: number): number {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function getRandomInterval(
  runtime: IAgentRuntime,
  type: "post" | "engagement" | "discovery"
): number {
  const intervals = {
    post: {
      min: "X_POST_INTERVAL_MIN",
      max: "X_POST_INTERVAL_MAX",
      defMin: 90,
      defMax: 180,
    },
    engagement: {
      min: "X_ENGAGEMENT_INTERVAL_MIN",
      max: "X_ENGAGEMENT_INTERVAL_MAX",
      defMin: 20,
      defMax: 40,
    },
    discovery: {
      min: "X_DISCOVERY_INTERVAL_MIN",
      max: "X_DISCOVERY_INTERVAL_MAX",
      defMin: 15,
      defMax: 30,
    },
  };

  const { min, max, defMin, defMax } = intervals[type];
  const minVal = parseInterval(getXSetting(runtime, min), defMin);
  const maxVal = parseInterval(getXSetting(runtime, max), defMax);

  return minVal < maxVal ? Math.random() * (maxVal - minVal) + minVal : defMin;
}

export function loadConfig(): XConfig {
  const get = (x: string, t: string): string => process.env[x] || process.env[t] || "";
  return {
    X_AUTH_MODE: (get("X_AUTH_MODE", "TWITTER_AUTH_MODE") || "env") as "env" | "oauth" | "bearer",
    X_API_KEY: get("X_API_KEY", "TWITTER_API_KEY"),
    X_API_SECRET: get("X_API_SECRET", "TWITTER_API_SECRET_KEY"),
    X_ACCESS_TOKEN: get("X_ACCESS_TOKEN", "TWITTER_ACCESS_TOKEN"),
    X_ACCESS_TOKEN_SECRET: get("X_ACCESS_TOKEN_SECRET", "TWITTER_ACCESS_TOKEN_SECRET"),
    X_BEARER_TOKEN: get("X_BEARER_TOKEN", "TWITTER_BEARER_TOKEN"),
    X_CLIENT_ID: get("X_CLIENT_ID", "TWITTER_CLIENT_ID"),
    X_REDIRECT_URI: get("X_REDIRECT_URI", "TWITTER_REDIRECT_URI"),
    X_DRY_RUN: get("X_DRY_RUN", "TWITTER_DRY_RUN") || "false",
    X_TARGET_USERS: get("X_TARGET_USERS", "TWITTER_TARGET_USERS"),
    X_ENABLE_POST: get("X_ENABLE_POST", "TWITTER_ENABLE_POST") || "false",
    X_ENABLE_REPLIES: get("X_ENABLE_REPLIES", "TWITTER_ENABLE_REPLIES") || "true",
    X_ENABLE_ACTIONS: get("X_ENABLE_ACTIONS", "TWITTER_ENABLE_ACTIONS") || "false",
    X_ENABLE_DISCOVERY: get("X_ENABLE_DISCOVERY", "TWITTER_ENABLE_DISCOVERY") || "false",
    X_POST_INTERVAL_MIN: get("X_POST_INTERVAL_MIN", "TWITTER_POST_INTERVAL_MIN") || "90",
    X_POST_INTERVAL_MAX: get("X_POST_INTERVAL_MAX", "TWITTER_POST_INTERVAL_MAX") || "180",
    X_ENGAGEMENT_INTERVAL_MIN:
      get("X_ENGAGEMENT_INTERVAL_MIN", "TWITTER_ENGAGEMENT_INTERVAL_MIN") || "20",
    X_ENGAGEMENT_INTERVAL_MAX:
      get("X_ENGAGEMENT_INTERVAL_MAX", "TWITTER_ENGAGEMENT_INTERVAL_MAX") || "40",
    X_DISCOVERY_INTERVAL_MIN:
      get("X_DISCOVERY_INTERVAL_MIN", "TWITTER_DISCOVERY_INTERVAL_MIN") || "15",
    X_DISCOVERY_INTERVAL_MAX:
      get("X_DISCOVERY_INTERVAL_MAX", "TWITTER_DISCOVERY_INTERVAL_MAX") || "30",
    X_MAX_ENGAGEMENTS_PER_RUN:
      get("X_MAX_ENGAGEMENTS_PER_RUN", "TWITTER_MAX_ENGAGEMENTS_PER_RUN") || "5",
    X_MAX_POST_LENGTH: get("X_MAX_POST_LENGTH", "TWITTER_MAX_TWEET_LENGTH") || "280",
    X_RETRY_LIMIT: get("X_RETRY_LIMIT", "TWITTER_RETRY_LIMIT") || "5",
  };
}

export function validateConfig(config: unknown): XConfig {
  return xEnvSchema.parse(config);
}

export function loadConfigFromFile(): Partial<XConfig> {
  return {};
}
