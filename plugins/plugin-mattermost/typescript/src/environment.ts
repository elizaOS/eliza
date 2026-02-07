import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import type { DmPolicy, GroupPolicy } from "./types";

/**
 * Zod schema for Mattermost environment configuration.
 */
export const mattermostEnvSchema = z.object({
  MATTERMOST_SERVER_URL: z.string().min(1, "Mattermost server URL is required"),
  MATTERMOST_BOT_TOKEN: z.string().min(1, "Mattermost bot token is required"),
  MATTERMOST_TEAM_ID: z.string().optional(),
  MATTERMOST_ENABLED: z.coerce.boolean().optional().default(true),
  MATTERMOST_DM_POLICY: z
    .enum(["pairing", "allowlist", "open", "disabled"])
    .optional()
    .default("pairing"),
  MATTERMOST_GROUP_POLICY: z
    .enum(["allowlist", "open", "disabled"])
    .optional()
    .default("allowlist"),
  MATTERMOST_ALLOWED_USERS: z.string().optional(),
  MATTERMOST_ALLOWED_CHANNELS: z.string().optional(),
  MATTERMOST_REQUIRE_MENTION: z.coerce.boolean().optional().default(true),
  MATTERMOST_IGNORE_BOT_MESSAGES: z.coerce.boolean().optional().default(true),
});

export type MattermostEnvConfig = z.infer<typeof mattermostEnvSchema>;

/**
 * Extended configuration with parsed values.
 */
export interface MattermostSettings {
  serverUrl: string;
  botToken: string;
  teamId?: string;
  enabled: boolean;
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  allowedUsers: string[];
  allowedChannels: string[];
  requireMention: boolean;
  ignoreBotMessages: boolean;
}

/**
 * Parse allowed users from JSON string or comma-separated list.
 */
function parseAllowedList(value: string | undefined): string[] {
  if (!value) return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  // Try parsing as JSON array first
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((id) => String(id).trim()).filter((id) => id.length > 0);
      }
    } catch {
      // Fall through to comma-separated parsing
    }
  }

  // Parse as comma-separated
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Validate and parse Mattermost configuration from runtime settings.
 */
export async function validateMattermostConfig(
  runtime: IAgentRuntime
): Promise<MattermostEnvConfig | null> {
  try {
    const config = {
      MATTERMOST_SERVER_URL:
        runtime.getSetting("MATTERMOST_SERVER_URL") || process.env.MATTERMOST_SERVER_URL,
      MATTERMOST_BOT_TOKEN:
        runtime.getSetting("MATTERMOST_BOT_TOKEN") || process.env.MATTERMOST_BOT_TOKEN,
      MATTERMOST_TEAM_ID:
        runtime.getSetting("MATTERMOST_TEAM_ID") || process.env.MATTERMOST_TEAM_ID,
      MATTERMOST_ENABLED:
        runtime.getSetting("MATTERMOST_ENABLED") || process.env.MATTERMOST_ENABLED,
      MATTERMOST_DM_POLICY:
        runtime.getSetting("MATTERMOST_DM_POLICY") || process.env.MATTERMOST_DM_POLICY,
      MATTERMOST_GROUP_POLICY:
        runtime.getSetting("MATTERMOST_GROUP_POLICY") || process.env.MATTERMOST_GROUP_POLICY,
      MATTERMOST_ALLOWED_USERS:
        runtime.getSetting("MATTERMOST_ALLOWED_USERS") || process.env.MATTERMOST_ALLOWED_USERS,
      MATTERMOST_ALLOWED_CHANNELS:
        runtime.getSetting("MATTERMOST_ALLOWED_CHANNELS") ||
        process.env.MATTERMOST_ALLOWED_CHANNELS,
      MATTERMOST_REQUIRE_MENTION:
        runtime.getSetting("MATTERMOST_REQUIRE_MENTION") || process.env.MATTERMOST_REQUIRE_MENTION,
      MATTERMOST_IGNORE_BOT_MESSAGES:
        runtime.getSetting("MATTERMOST_IGNORE_BOT_MESSAGES") ||
        process.env.MATTERMOST_IGNORE_BOT_MESSAGES,
    };

    return mattermostEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      console.warn(`Mattermost configuration validation failed:\n${errorMessages}`);
    }
    return null;
  }
}

/**
 * Build MattermostSettings from validated config.
 */
export function buildMattermostSettings(config: MattermostEnvConfig): MattermostSettings {
  return {
    serverUrl: normalizeServerUrl(config.MATTERMOST_SERVER_URL),
    botToken: config.MATTERMOST_BOT_TOKEN,
    teamId: config.MATTERMOST_TEAM_ID,
    enabled: config.MATTERMOST_ENABLED ?? true,
    dmPolicy: (config.MATTERMOST_DM_POLICY as DmPolicy) || "pairing",
    groupPolicy: (config.MATTERMOST_GROUP_POLICY as GroupPolicy) || "allowlist",
    allowedUsers: parseAllowedList(config.MATTERMOST_ALLOWED_USERS),
    allowedChannels: parseAllowedList(config.MATTERMOST_ALLOWED_CHANNELS),
    requireMention: config.MATTERMOST_REQUIRE_MENTION ?? true,
    ignoreBotMessages: config.MATTERMOST_IGNORE_BOT_MESSAGES ?? true,
  };
}

/**
 * Normalize the server URL by removing trailing slashes and /api/v4 suffix.
 */
export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  // Remove trailing slashes
  let normalized = trimmed.replace(/\/+$/, "");
  // Remove /api/v4 suffix if present
  normalized = normalized.replace(/\/api\/v4$/i, "");
  return normalized;
}
