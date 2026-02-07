import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const nextcloudTalkEnvSchema = z.object({
  NEXTCLOUD_URL: z.string().min(1, "Nextcloud URL is required"),
  NEXTCLOUD_BOT_SECRET: z.string().min(1, "Bot secret is required"),
  NEXTCLOUD_ENABLED: z.coerce.boolean().optional().default(true),
  NEXTCLOUD_WEBHOOK_PORT: z.coerce.number().optional().default(8788),
  NEXTCLOUD_WEBHOOK_HOST: z.string().optional().default("0.0.0.0"),
  NEXTCLOUD_WEBHOOK_PATH: z.string().optional().default("/nextcloud-talk-webhook"),
  NEXTCLOUD_WEBHOOK_PUBLIC_URL: z.string().optional(),
  NEXTCLOUD_ALLOWED_ROOMS: z.string().optional(),
});

export type NextcloudTalkConfig = z.infer<typeof nextcloudTalkEnvSchema>;

/**
 * Extended configuration with parsed values.
 */
export interface NextcloudTalkSettings {
  baseUrl: string;
  botSecret: string;
  enabled: boolean;
  webhookPort: number;
  webhookHost: string;
  webhookPath: string;
  webhookPublicUrl?: string;
  allowedRooms: string[];
}

/**
 * Parse allowed rooms from JSON string or comma-separated list.
 */
function parseAllowedRooms(value: string | undefined): string[] {
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

  // Otherwise parse as comma-separated
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function validateNextcloudTalkConfig(
  runtime: IAgentRuntime
): Promise<NextcloudTalkConfig | null> {
  try {
    const config = {
      NEXTCLOUD_URL: runtime.getSetting("NEXTCLOUD_URL") || process.env.NEXTCLOUD_URL,
      NEXTCLOUD_BOT_SECRET:
        runtime.getSetting("NEXTCLOUD_BOT_SECRET") || process.env.NEXTCLOUD_BOT_SECRET,
      NEXTCLOUD_ENABLED: runtime.getSetting("NEXTCLOUD_ENABLED") || process.env.NEXTCLOUD_ENABLED,
      NEXTCLOUD_WEBHOOK_PORT:
        runtime.getSetting("NEXTCLOUD_WEBHOOK_PORT") || process.env.NEXTCLOUD_WEBHOOK_PORT,
      NEXTCLOUD_WEBHOOK_HOST:
        runtime.getSetting("NEXTCLOUD_WEBHOOK_HOST") || process.env.NEXTCLOUD_WEBHOOK_HOST,
      NEXTCLOUD_WEBHOOK_PATH:
        runtime.getSetting("NEXTCLOUD_WEBHOOK_PATH") || process.env.NEXTCLOUD_WEBHOOK_PATH,
      NEXTCLOUD_WEBHOOK_PUBLIC_URL:
        runtime.getSetting("NEXTCLOUD_WEBHOOK_PUBLIC_URL") ||
        process.env.NEXTCLOUD_WEBHOOK_PUBLIC_URL,
      NEXTCLOUD_ALLOWED_ROOMS:
        runtime.getSetting("NEXTCLOUD_ALLOWED_ROOMS") || process.env.NEXTCLOUD_ALLOWED_ROOMS,
    };

    return nextcloudTalkEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      console.warn(`Nextcloud Talk configuration validation failed:\n${errorMessages}`);
    }
    return null;
  }
}

/**
 * Build NextcloudTalkSettings from validated config.
 */
export function buildNextcloudTalkSettings(config: NextcloudTalkConfig): NextcloudTalkSettings {
  return {
    baseUrl: config.NEXTCLOUD_URL,
    botSecret: config.NEXTCLOUD_BOT_SECRET,
    enabled: config.NEXTCLOUD_ENABLED ?? true,
    webhookPort: config.NEXTCLOUD_WEBHOOK_PORT ?? 8788,
    webhookHost: config.NEXTCLOUD_WEBHOOK_HOST ?? "0.0.0.0",
    webhookPath: config.NEXTCLOUD_WEBHOOK_PATH ?? "/nextcloud-talk-webhook",
    webhookPublicUrl: config.NEXTCLOUD_WEBHOOK_PUBLIC_URL,
    allowedRooms: parseAllowedRooms(config.NEXTCLOUD_ALLOWED_ROOMS),
  };
}
