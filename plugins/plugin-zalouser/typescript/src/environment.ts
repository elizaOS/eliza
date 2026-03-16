import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

/**
 * Environment configuration schema for Zalo User plugin.
 */
export const zaloUserEnvSchema = z.object({
  ZALOUSER_COOKIE_PATH: z.string().optional(),
  ZALOUSER_IMEI: z.string().optional(),
  ZALOUSER_USER_AGENT: z.string().optional(),
  ZALOUSER_PROFILES: z.string().optional(),
  ZALOUSER_ENABLED: z.coerce.boolean().optional().default(true),
  ZALOUSER_DEFAULT_PROFILE: z.string().optional().default("default"),
  ZALOUSER_LISTEN_TIMEOUT: z.coerce.number().optional().default(30000),
  ZALOUSER_ALLOWED_THREADS: z.string().optional(),
  ZALOUSER_DM_POLICY: z
    .enum(["open", "allowlist", "pairing", "disabled"])
    .optional()
    .default("pairing"),
  ZALOUSER_GROUP_POLICY: z
    .enum(["open", "allowlist", "disabled"])
    .optional()
    .default("disabled"),
});

export type ZaloUserEnvConfig = z.infer<typeof zaloUserEnvSchema>;

/**
 * Extended settings for the Zalo User plugin.
 */
export interface ZaloUserSettings {
  /** Path to cookie file for authentication persistence */
  cookiePath?: string;
  /** IMEI identifier for authentication */
  imei?: string;
  /** User agent for API requests */
  userAgent?: string;
  /** JSON string of profile configurations */
  profilesJson?: string;
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** Default profile to use */
  defaultProfile: string;
  /** Listen timeout in milliseconds */
  listenTimeout: number;
  /** Allowed thread IDs (JSON array or comma-separated) */
  allowedThreads: string[];
  /** DM policy */
  dmPolicy: "open" | "allowlist" | "pairing" | "disabled";
  /** Group policy */
  groupPolicy: "open" | "allowlist" | "disabled";
}

/**
 * Parse allowed threads from string.
 */
function parseAllowedThreads(value: string | undefined): string[] {
  if (!value) return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  // Try parsing as JSON array first
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((id) => String(id)).filter(Boolean);
      }
    } catch {
      // Fall through to comma-separated parsing
    }
  }

  // Parse as comma-separated
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate Zalo User configuration from runtime settings.
 */
export async function validateZaloUserConfig(
  runtime: IAgentRuntime,
): Promise<ZaloUserEnvConfig | null> {
  try {
    const config = {
      ZALOUSER_COOKIE_PATH:
        runtime.getSetting("ZALOUSER_COOKIE_PATH") ||
        process.env.ZALOUSER_COOKIE_PATH,
      ZALOUSER_IMEI:
        runtime.getSetting("ZALOUSER_IMEI") || process.env.ZALOUSER_IMEI,
      ZALOUSER_USER_AGENT:
        runtime.getSetting("ZALOUSER_USER_AGENT") ||
        process.env.ZALOUSER_USER_AGENT,
      ZALOUSER_PROFILES:
        runtime.getSetting("ZALOUSER_PROFILES") ||
        process.env.ZALOUSER_PROFILES,
      ZALOUSER_ENABLED:
        runtime.getSetting("ZALOUSER_ENABLED") || process.env.ZALOUSER_ENABLED,
      ZALOUSER_DEFAULT_PROFILE:
        runtime.getSetting("ZALOUSER_DEFAULT_PROFILE") ||
        process.env.ZALOUSER_DEFAULT_PROFILE,
      ZALOUSER_LISTEN_TIMEOUT:
        runtime.getSetting("ZALOUSER_LISTEN_TIMEOUT") ||
        process.env.ZALOUSER_LISTEN_TIMEOUT,
      ZALOUSER_ALLOWED_THREADS:
        runtime.getSetting("ZALOUSER_ALLOWED_THREADS") ||
        process.env.ZALOUSER_ALLOWED_THREADS,
      ZALOUSER_DM_POLICY:
        runtime.getSetting("ZALOUSER_DM_POLICY") ||
        process.env.ZALOUSER_DM_POLICY,
      ZALOUSER_GROUP_POLICY:
        runtime.getSetting("ZALOUSER_GROUP_POLICY") ||
        process.env.ZALOUSER_GROUP_POLICY,
    };

    return zaloUserEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      console.warn(
        `Zalo User configuration validation failed:\n${errorMessages}`,
      );
    }
    return null;
  }
}

/**
 * Build ZaloUserSettings from validated config.
 */
export function buildZaloUserSettings(
  config: ZaloUserEnvConfig,
): ZaloUserSettings {
  return {
    cookiePath: config.ZALOUSER_COOKIE_PATH,
    imei: config.ZALOUSER_IMEI,
    userAgent: config.ZALOUSER_USER_AGENT,
    profilesJson: config.ZALOUSER_PROFILES,
    enabled: config.ZALOUSER_ENABLED ?? true,
    defaultProfile: config.ZALOUSER_DEFAULT_PROFILE || "default",
    listenTimeout: config.ZALOUSER_LISTEN_TIMEOUT || 30000,
    allowedThreads: parseAllowedThreads(config.ZALOUSER_ALLOWED_THREADS),
    dmPolicy: config.ZALOUSER_DM_POLICY || "pairing",
    groupPolicy: config.ZALOUSER_GROUP_POLICY || "disabled",
  };
}
