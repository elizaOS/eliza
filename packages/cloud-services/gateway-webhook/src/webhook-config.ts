import type { Platform, WebhookConfig } from "./adapters/types";
import { logger } from "./logger";
import { getProjectEnv } from "./project-config";
import type { GatewayRedis } from "./redis";

const CONFIG_CACHE_TTL_SECONDS = 300;

function buildSharedWebhookConfig(platform: Platform, project: string): WebhookConfig {
  const base: WebhookConfig = {
    agentId: getProjectEnv(project, "DEFAULT_AGENT_ID"),
  };

  switch (platform) {
    case "telegram":
      base.botToken = getProjectEnv(project, "TELEGRAM_BOT_TOKEN");
      base.webhookSecret = getProjectEnv(project, "TELEGRAM_WEBHOOK_SECRET");
      break;
    case "blooio":
      base.apiKey = getProjectEnv(project, "BLOOIO_API_KEY");
      base.blooioWebhookSecret = getProjectEnv(project, "BLOOIO_WEBHOOK_SECRET");
      base.fromNumber = getProjectEnv(project, "BLOOIO_PHONE_NUMBER");
      break;
    case "twilio":
      base.accountSid = getProjectEnv(project, "TWILIO_ACCOUNT_SID");
      base.authToken = getProjectEnv(project, "TWILIO_AUTH_TOKEN");
      base.phoneNumber = getProjectEnv(project, "TWILIO_PHONE_NUMBER");
      break;
    case "whatsapp":
      base.accessToken = getProjectEnv(project, "WHATSAPP_ACCESS_TOKEN");
      base.phoneNumberId = getProjectEnv(project, "WHATSAPP_PHONE_NUMBER_ID");
      base.appSecret = getProjectEnv(project, "WHATSAPP_APP_SECRET");
      base.verifyToken = getProjectEnv(project, "WHATSAPP_VERIFY_TOKEN");
      base.businessPhone = getProjectEnv(project, "WHATSAPP_PHONE_NUMBER");
      break;
  }
  return base;
}

export async function resolveWebhookConfig(
  redis: GatewayRedis,
  cloudBaseUrl: string,
  authHeader: Record<string, string>,
  platform: Platform,
  project: string,
  agentId?: string,
): Promise<WebhookConfig | null> {
  if (!agentId) {
    return buildSharedWebhookConfig(platform, project);
  }

  const cacheKey = `webhook-config:${platform}:agent:${agentId}`;
  const cached = await redis.get<WebhookConfig>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${cloudBaseUrl}/api/internal/webhook/config?agentId=${encodeURIComponent(agentId)}&platform=${encodeURIComponent(platform)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(url, {
        headers: authHeader,
        signal: controller.signal,
      });

      if (res.status === 404) return null;
      if (!res.ok) {
        logger.error("Webhook config fetch failed", {
          status: res.status,
          agentId,
          platform,
        });
        return null;
      }

      const config = (await res.json()) as WebhookConfig;
      await redis.set(cacheKey, JSON.stringify(config), {
        ex: CONFIG_CACHE_TTL_SECONDS,
      });
      return config;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    logger.error("Webhook config fetch error", {
      error: err instanceof Error ? err.message : String(err),
      agentId,
      platform,
    });
    return null;
  }
}

export function getSharedWhatsAppVerifyToken(project: string): string | null {
  return getProjectEnv(project, "WHATSAPP_VERIFY_TOKEN") || null;
}
