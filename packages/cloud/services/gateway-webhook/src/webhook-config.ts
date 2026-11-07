/** Resolves shared and per-agent webhook configuration for connector fan-in. */
import { blooioSenderIsolationViolation } from "@elizaos/cloud-services-common/blooio-environment";
import { gatewayBlooioEnvironment } from "./adapters/blooio";
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

/**
 * The config read did not produce an answer: the cloud API was unreachable,
 * answered non-2xx, or returned a body that is not a config. Callers must treat
 * this as retryable — it is never evidence that the agent has no connector.
 */
export class WebhookConfigUnavailableError extends Error {
  readonly code = "WEBHOOK_CONFIG_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebhookConfigUnavailableError";
  }
}

/** Cache writes are an optimisation; a failed write must not fail the read. */
async function remember(
  redis: GatewayRedis,
  key: string,
  value: CachedWebhookConfig,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
  } catch (err) {
    logger.warn("Webhook config cache write failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Resolves a project connector from the gateway's protected local configuration. */
export function resolveSharedWebhookConfig(
  platform: Platform,
  project: string,
): WebhookConfig {
  const base: WebhookConfig = {};

  switch (platform) {
    case "telegram":
      base.botToken = getProjectEnv(project, "TELEGRAM_BOT_TOKEN").trim();
      base.botId = getProjectEnv(project, "TELEGRAM_BOT_ID").trim();
      base.botUsername = getProjectEnv(project, "TELEGRAM_BOT_USERNAME").trim();
      base.webhookSecret = getProjectEnv(
        project,
        "TELEGRAM_WEBHOOK_SECRET",
      ).trim();
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
    const shared = resolveSharedWebhookConfig(platform, project);
    const violation =
      platform === "blooio"
        ? blooioSenderIsolationViolation({
            environment: gatewayBlooioEnvironment(),
            senderNumber: shared.fromNumber,
          })
        : null;
    if (violation) {
      // Fail closed for this connector only: a non-production gateway never
      // receives or sends as a production Blooio line (#22787).
      logger.error("Blooio connector is not environment-isolated; disabled", {
        project,
        violation,
      });
      return null;
    }
    return shared;
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

      // The cloud answered: this agent genuinely has no such connector.
      if (res.status === 404) {
        await remember(
          redis,
          cacheKey,
          { notFound: true },
          CONFIG_MISS_CACHE_TTL_SECONDS,
        );
        return null;
      }
      if (!res.ok) {
        throw new WebhookConfigUnavailableError(
          `config API answered ${res.status}`,
        );
      }

      const config = (await res.json()) as WebhookConfig;
      await remember(redis, cacheKey, config, CONFIG_CACHE_TTL_SECONDS);
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
    // A read failure is not the cloud saying "no config": the platform is told
    // to retry (5xx) instead of receiving a final 404 that drops the update.
    throw err instanceof WebhookConfigUnavailableError
      ? err
      : new WebhookConfigUnavailableError("config API unreachable", {
          cause: err,
        });
  }
}

export function getSharedWhatsAppVerifyToken(project: string): string | null {
  return getProjectEnv(project, "WHATSAPP_VERIFY_TOKEN") || null;
}
