/** Resolves shared and per-agent webhook configuration for connector fan-in. */
import type { Platform, WebhookConfig } from "./adapters/types";
import { reacquireAuthHeader } from "./auth";
import { logger } from "./logger";
import { getProjectEnv } from "./project-config";
import type { GatewayRedis } from "./redis";

const CONFIG_CACHE_TTL_SECONDS = 300;
// An agent id that resolves to no config is cached too, briefly. Without it
// every request naming an unknown agent pays a fresh authenticated round trip
// to the cloud API, on a route reachable without a signature since Meta's
// verification handshake became exempt — an amplifier with caller-chosen cache
// keys. The TTL stays short so a config created seconds later is picked up,
// matching the transient identity cache in `server-router.ts`.
const CONFIG_MISS_CACHE_TTL_SECONDS = 15;

type CachedWebhookConfig = WebhookConfig | { notFound: true };

/** Resolves a project connector from the gateway's protected local configuration. */
export function resolveSharedWebhookConfig(
  platform: Platform,
  project: string,
): WebhookConfig {
  const base: WebhookConfig = {};

  switch (platform) {
    case "telegram":
      base.botToken = getProjectEnv(project, "TELEGRAM_BOT_TOKEN");
      base.botUsername = getProjectEnv(project, "TELEGRAM_BOT_USERNAME");
      base.webhookSecret = getProjectEnv(project, "TELEGRAM_WEBHOOK_SECRET");
      break;
    case "blooio":
      base.apiKey = getProjectEnv(project, "BLOOIO_API_KEY");
      base.blooioWebhookSecret = getProjectEnv(
        project,
        "BLOOIO_WEBHOOK_SECRET",
      );
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
  reauth: () => Promise<Record<string, string>> = reacquireAuthHeader,
): Promise<WebhookConfig | null> {
  if (!agentId) {
    return resolveSharedWebhookConfig(platform, project);
  }

  const cacheKey = `webhook-config:${platform}:agent:${agentId}`;
  const cached = await redis.get<CachedWebhookConfig>(cacheKey);
  if (cached) return "notFound" in cached ? null : cached;

  try {
    const url = `${cloudBaseUrl}/api/internal/webhook/config?agentId=${encodeURIComponent(agentId)}&platform=${encodeURIComponent(platform)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    try {
      let res = await fetch(url, {
        headers: authHeader,
        signal: controller.signal,
      });
      // Same 401 shape as resolveIdentity: a Worker redeploy strands the
      // cached token until the scheduled refresh. One re-bootstrapped retry.
      if (res.status === 401) {
        res = await fetch(url, {
          headers: await reauth(),
          signal: controller.signal,
        });
      }

      if (res.status === 404) {
        await redis.set(cacheKey, JSON.stringify({ notFound: true }), {
          ex: CONFIG_MISS_CACHE_TTL_SECONDS,
        });
        return null;
      }
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
