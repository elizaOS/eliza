import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

/**
 * Environment configuration schema for MS Teams plugin
 */
export const msTeamsEnvSchema = z.object({
  MSTEAMS_APP_ID: z.string().min(1, "MS Teams App ID is required"),
  MSTEAMS_APP_PASSWORD: z.string().min(1, "MS Teams App Password is required"),
  MSTEAMS_TENANT_ID: z.string().min(1, "MS Teams Tenant ID is required"),
  MSTEAMS_ENABLED: z.coerce.boolean().optional().default(true),
  MSTEAMS_WEBHOOK_PORT: z.coerce.number().optional().default(3978),
  MSTEAMS_WEBHOOK_PATH: z.string().optional().default("/api/messages"),
  MSTEAMS_ALLOWED_TENANTS: z.string().optional(),
  MSTEAMS_SHAREPOINT_SITE_ID: z.string().optional(),
  MSTEAMS_MEDIA_MAX_MB: z.coerce.number().optional().default(100),
});

export type MSTeamsEnvConfig = z.infer<typeof msTeamsEnvSchema>;

/**
 * MS Teams credentials for authentication
 */
export interface MSTeamsCredentials {
  appId: string;
  appPassword: string;
  tenantId: string;
}

/**
 * MS Teams plugin settings
 */
export interface MSTeamsSettings {
  /** Bot App ID */
  appId: string;
  /** Bot App Password */
  appPassword: string;
  /** Azure AD Tenant ID */
  tenantId: string;
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** Webhook server port */
  webhookPort: number;
  /** Webhook path */
  webhookPath: string;
  /** Allowed tenant IDs for multi-tenant bots */
  allowedTenants: string[];
  /** SharePoint site ID for file uploads */
  sharePointSiteId?: string;
  /** Maximum media file size in MB */
  mediaMaxMb: number;
}

/**
 * Parse allowed tenants from JSON string or comma-separated list
 */
function parseAllowedTenants(value: string | undefined): string[] {
  if (!value) return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  // Try parsing as JSON array first
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((id) => (typeof id === "string" ? id.trim() : String(id)))
          .filter((id) => id.length > 0);
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
 * Validate MS Teams configuration from runtime
 */
export async function validateMSTeamsConfig(
  runtime: IAgentRuntime,
): Promise<MSTeamsEnvConfig | null> {
  try {
    const config = {
      MSTEAMS_APP_ID:
        runtime.getSetting("MSTEAMS_APP_ID") || process.env.MSTEAMS_APP_ID,
      MSTEAMS_APP_PASSWORD:
        runtime.getSetting("MSTEAMS_APP_PASSWORD") ||
        process.env.MSTEAMS_APP_PASSWORD,
      MSTEAMS_TENANT_ID:
        runtime.getSetting("MSTEAMS_TENANT_ID") ||
        process.env.MSTEAMS_TENANT_ID,
      MSTEAMS_ENABLED:
        runtime.getSetting("MSTEAMS_ENABLED") || process.env.MSTEAMS_ENABLED,
      MSTEAMS_WEBHOOK_PORT:
        runtime.getSetting("MSTEAMS_WEBHOOK_PORT") ||
        process.env.MSTEAMS_WEBHOOK_PORT,
      MSTEAMS_WEBHOOK_PATH:
        runtime.getSetting("MSTEAMS_WEBHOOK_PATH") ||
        process.env.MSTEAMS_WEBHOOK_PATH,
      MSTEAMS_ALLOWED_TENANTS:
        runtime.getSetting("MSTEAMS_ALLOWED_TENANTS") ||
        process.env.MSTEAMS_ALLOWED_TENANTS,
      MSTEAMS_SHAREPOINT_SITE_ID:
        runtime.getSetting("MSTEAMS_SHAREPOINT_SITE_ID") ||
        process.env.MSTEAMS_SHAREPOINT_SITE_ID,
      MSTEAMS_MEDIA_MAX_MB:
        runtime.getSetting("MSTEAMS_MEDIA_MAX_MB") ||
        process.env.MSTEAMS_MEDIA_MAX_MB,
    };

    return msTeamsEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      console.warn(
        `MS Teams configuration validation failed:\n${errorMessages}`,
      );
    }
    return null;
  }
}

/**
 * Build MS Teams settings from validated config
 */
export function buildMSTeamsSettings(
  config: MSTeamsEnvConfig,
): MSTeamsSettings {
  return {
    appId: config.MSTEAMS_APP_ID,
    appPassword: config.MSTEAMS_APP_PASSWORD,
    tenantId: config.MSTEAMS_TENANT_ID,
    enabled: config.MSTEAMS_ENABLED ?? true,
    webhookPort: config.MSTEAMS_WEBHOOK_PORT ?? 3978,
    webhookPath: config.MSTEAMS_WEBHOOK_PATH ?? "/api/messages",
    allowedTenants: parseAllowedTenants(config.MSTEAMS_ALLOWED_TENANTS),
    sharePointSiteId: config.MSTEAMS_SHAREPOINT_SITE_ID,
    mediaMaxMb: config.MSTEAMS_MEDIA_MAX_MB ?? 100,
  };
}

/**
 * Resolve MS Teams credentials from config
 */
export function resolveMSTeamsCredentials(
  settings: MSTeamsSettings,
): MSTeamsCredentials | null {
  if (!settings.appId || !settings.appPassword || !settings.tenantId) {
    return null;
  }

  return {
    appId: settings.appId,
    appPassword: settings.appPassword,
    tenantId: settings.tenantId,
  };
}
