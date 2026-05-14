import { logger } from "@/lib/utils/logger";
import type { AppContext } from "@/types/cloud-worker-env";

type GatewayPlatform = "telegram" | "blooio" | "whatsapp";

const WEBHOOK_GATEWAY_ENV_KEYS = [
  "ELIZA_APP_WEBHOOK_GATEWAY_URL",
  "WEBHOOK_GATEWAY_URL",
  "GATEWAY_WEBHOOK_URL",
] as const;

function readStringEnv(c: AppContext, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = c.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function requestSuffix(c: AppContext, platform: string): string {
  const pathname = new URL(c.req.url).pathname;
  const prefix = `/api/eliza-app/webhook/${platform}`;
  if (!pathname.startsWith(prefix)) return "";
  const suffix = pathname.slice(prefix.length);
  return suffix === "/" ? "" : suffix;
}

interface ForwardOptions {
  body?: BodyInit | null;
}

async function proxyRequest(
  c: AppContext,
  target: URL,
  serviceName: string,
  options: ForwardOptions = {},
): Promise<Response> {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", new URL(c.req.url).host);
  headers.set("x-forwarded-proto", new URL(c.req.url).protocol.replace(":", ""));

  try {
    const upstream = await fetch(target, {
      body:
        c.req.method === "GET" || c.req.method === "HEAD"
          ? undefined
          : (options.body ?? c.req.raw.body),
      headers,
      method: c.req.method,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      headers: upstream.headers,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch (error) {
    logger.error("[ElizaAppWebhook] Upstream request failed", {
      serviceName,
      target: target.origin,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      {
        success: false,
        code: "WEBHOOK_UPSTREAM_UNREACHABLE",
        error: `${serviceName} is unreachable`,
      },
      502,
    );
  }
}

export async function forwardToWebhookGateway(
  c: AppContext,
  platform: GatewayPlatform,
  options: ForwardOptions = {},
): Promise<Response> {
  const baseUrl = readStringEnv(c, WEBHOOK_GATEWAY_ENV_KEYS);
  if (!baseUrl) {
    return c.json(
      {
        success: false,
        code: "WEBHOOK_GATEWAY_NOT_CONFIGURED",
        error: "Webhook gateway URL is not configured",
      },
      503,
    );
  }

  const project = readStringEnv(c, ["ELIZA_APP_WEBHOOK_PROJECT"]) ?? "eliza-app";
  const target = new URL(baseUrl);
  const sourceUrl = new URL(c.req.url);
  target.pathname = `/webhook/${encodeURIComponent(project)}/${platform}${requestSuffix(
    c,
    platform,
  )}`;
  target.search = sourceUrl.search;

  return proxyRequest(c, target, "webhook gateway", options);
}

export async function forwardToDiscordWebhookHandler(c: AppContext): Promise<Response> {
  const configuredUrl = readStringEnv(c, [
    "ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL",
    "DISCORD_WEBHOOK_HANDLER_URL",
  ]);
  if (!configuredUrl) {
    return c.json(
      {
        success: false,
        code: "DISCORD_WEBHOOK_HANDLER_NOT_CONFIGURED",
        error: "Discord webhook handler URL is not configured",
      },
      503,
    );
  }

  const target = new URL(configuredUrl);
  target.search = new URL(c.req.url).search;
  return proxyRequest(c, target, "Discord webhook handler");
}
