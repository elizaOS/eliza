import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

/**
 * Schema for validating Tlon environment configuration
 */
export const tlonEnvSchema = z.object({
  TLON_SHIP: z.string().min(1, "Tlon ship name is required"),
  TLON_URL: z.string().url("Tlon URL must be a valid URL"),
  TLON_CODE: z.string().min(1, "Tlon authentication code is required"),
  TLON_ENABLED: z.coerce.boolean().optional().default(true),
  TLON_GROUP_CHANNELS: z.string().optional(),
  TLON_DM_ALLOWLIST: z.string().optional(),
  TLON_AUTO_DISCOVER_CHANNELS: z.coerce.boolean().optional().default(true),
});

export type TlonEnvConfig = z.infer<typeof tlonEnvSchema>;

/**
 * Parsed and validated Tlon settings
 */
export interface TlonSettings {
  /** Ship name (normalized without ~) */
  ship: string;
  /** Urbit HTTP API URL */
  url: string;
  /** Authentication code */
  code: string;
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** Group channels to monitor */
  groupChannels: string[];
  /** Ships allowed to send DMs */
  dmAllowlist: string[];
  /** Auto-discover channels */
  autoDiscoverChannels: boolean;
}

/**
 * Normalizes a ship name by removing the ~ prefix if present
 */
export function normalizeShip(ship: string): string {
  return ship.startsWith("~") ? ship.slice(1) : ship;
}

/**
 * Formats a ship name with the ~ prefix
 */
export function formatShip(ship: string): string {
  const normalized = normalizeShip(ship);
  return `~${normalized}`;
}

/**
 * Parses a JSON array string, returning empty array on failure
 */
function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Validates and returns Tlon configuration from runtime settings
 */
export async function validateTlonConfig(
  runtime: IAgentRuntime,
): Promise<TlonEnvConfig | null> {
  try {
    const config = {
      TLON_SHIP: runtime.getSetting("TLON_SHIP") || process.env.TLON_SHIP,
      TLON_URL: runtime.getSetting("TLON_URL") || process.env.TLON_URL,
      TLON_CODE: runtime.getSetting("TLON_CODE") || process.env.TLON_CODE,
      TLON_ENABLED:
        runtime.getSetting("TLON_ENABLED") || process.env.TLON_ENABLED,
      TLON_GROUP_CHANNELS:
        runtime.getSetting("TLON_GROUP_CHANNELS") ||
        process.env.TLON_GROUP_CHANNELS,
      TLON_DM_ALLOWLIST:
        runtime.getSetting("TLON_DM_ALLOWLIST") ||
        process.env.TLON_DM_ALLOWLIST,
      TLON_AUTO_DISCOVER_CHANNELS:
        runtime.getSetting("TLON_AUTO_DISCOVER_CHANNELS") ||
        process.env.TLON_AUTO_DISCOVER_CHANNELS,
    };

    return tlonEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      console.warn(`Tlon configuration validation failed:\n${errorMessages}`);
    }
    return null;
  }
}

/**
 * Builds TlonSettings from validated config
 */
export function buildTlonSettings(config: TlonEnvConfig): TlonSettings {
  return {
    ship: normalizeShip(config.TLON_SHIP),
    url: config.TLON_URL.replace(/\/$/, ""), // Remove trailing slash
    code: config.TLON_CODE,
    enabled: config.TLON_ENABLED ?? true,
    groupChannels: parseJsonArray(config.TLON_GROUP_CHANNELS),
    dmAllowlist: parseJsonArray(config.TLON_DM_ALLOWLIST).map(normalizeShip),
    autoDiscoverChannels: config.TLON_AUTO_DISCOVER_CHANNELS ?? true,
  };
}

/**
 * Parses a channel nest string (e.g., "chat/~host/channel-name")
 */
export function parseChannelNest(nest: string): {
  kind: string;
  hostShip: string;
  channelName: string;
} | null {
  const parts = nest.split("/");
  if (parts.length !== 3) return null;

  const [kind, hostShip, channelName] = parts;
  if (!kind || !hostShip || !channelName) return null;

  return {
    kind,
    hostShip: normalizeShip(hostShip),
    channelName,
  };
}

/**
 * Builds a channel nest string from components
 */
export function buildChannelNest(
  kind: string,
  hostShip: string,
  channelName: string,
): string {
  return `${kind}/${formatShip(hostShip)}/${channelName}`;
}
