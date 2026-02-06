import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import { DEFAULT_WEBHOOK_PATH, DEFAULT_WEBHOOK_PORT } from "./constants";
import type { ZaloSettings } from "./types";
export type { ZaloSettings };

/**
 * Zalo environment configuration schema
 */
export const zaloEnvSchema = z.object({
  ZALO_APP_ID: z.string().min(1, "Zalo App ID is required"),
  ZALO_SECRET_KEY: z.string().min(1, "Zalo Secret Key is required"),
  ZALO_ACCESS_TOKEN: z.string().min(1, "Zalo Access Token is required"),
  ZALO_REFRESH_TOKEN: z.string().optional(),
  ZALO_WEBHOOK_URL: z.string().url().optional(),
  ZALO_WEBHOOK_PATH: z.string().optional(),
  ZALO_WEBHOOK_PORT: z.coerce.number().optional(),
  ZALO_USE_POLLING: z.coerce.boolean().optional().default(false),
  ZALO_ENABLED: z.coerce.boolean().optional().default(true),
  ZALO_PROXY_URL: z.string().url().optional(),
});

export type ZaloConfig = z.infer<typeof zaloEnvSchema>;

/**
 * Validate Zalo configuration from runtime settings
 */
export async function validateZaloConfig(
  runtime: IAgentRuntime,
): Promise<ZaloConfig | null> {
  try {
    const config = {
      ZALO_APP_ID: runtime.getSetting("ZALO_APP_ID") || process.env.ZALO_APP_ID,
      ZALO_SECRET_KEY:
        runtime.getSetting("ZALO_SECRET_KEY") || process.env.ZALO_SECRET_KEY,
      ZALO_ACCESS_TOKEN:
        runtime.getSetting("ZALO_ACCESS_TOKEN") ||
        process.env.ZALO_ACCESS_TOKEN,
      ZALO_REFRESH_TOKEN:
        runtime.getSetting("ZALO_REFRESH_TOKEN") ||
        process.env.ZALO_REFRESH_TOKEN,
      ZALO_WEBHOOK_URL:
        runtime.getSetting("ZALO_WEBHOOK_URL") || process.env.ZALO_WEBHOOK_URL,
      ZALO_WEBHOOK_PATH:
        runtime.getSetting("ZALO_WEBHOOK_PATH") ||
        process.env.ZALO_WEBHOOK_PATH,
      ZALO_WEBHOOK_PORT:
        runtime.getSetting("ZALO_WEBHOOK_PORT") ||
        process.env.ZALO_WEBHOOK_PORT,
      ZALO_USE_POLLING:
        runtime.getSetting("ZALO_USE_POLLING") || process.env.ZALO_USE_POLLING,
      ZALO_ENABLED:
        runtime.getSetting("ZALO_ENABLED") || process.env.ZALO_ENABLED,
      ZALO_PROXY_URL:
        runtime.getSetting("ZALO_PROXY_URL") || process.env.ZALO_PROXY_URL,
    };

    return zaloEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      console.warn(`Zalo configuration validation failed:\n${errorMessages}`);
    }
    return null;
  }
}

/**
 * Build ZaloSettings from validated config
 */
export function buildZaloSettings(config: ZaloConfig): ZaloSettings {
  const usePolling = config.ZALO_USE_POLLING ?? false;

  return {
    appId: config.ZALO_APP_ID,
    secretKey: config.ZALO_SECRET_KEY,
    accessToken: config.ZALO_ACCESS_TOKEN,
    refreshToken: config.ZALO_REFRESH_TOKEN,
    updateMode: usePolling ? "polling" : "webhook",
    webhookUrl: config.ZALO_WEBHOOK_URL,
    webhookPath: config.ZALO_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH,
    webhookPort: config.ZALO_WEBHOOK_PORT || DEFAULT_WEBHOOK_PORT,
    enabled: config.ZALO_ENABLED ?? true,
    proxyUrl: config.ZALO_PROXY_URL,
  };
}
