import { logger } from "@/lib/utils/logger";
import type { AppContext } from "@/types/cloud-worker-env";

type GatewayPlatform = "telegram" | "blooio" | "twilio" | "whatsapp";

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

// The forwarder appends the request's trailing path onto the internal gateway
// URL, so a traversal suffix (`..%2f…`, `%2e%2e…`, backslashes) would let a
// caller escape `/webhook/<project>/<platform>` and hit arbitrary gateway paths.
// The URL parser only collapses *literal* dot-segments, so percent-encoded
// separators survive to here. Webhook routes are fixed paths, so a legitimate
// suffix is only ever empty or benign safe-char segments — reject anything else
// rather than forward it. (finding L3, #12878 / #12227)
const SAFE_WEBHOOK_SUFFIX = /^(?:\/[A-Za-z0-9_-]+)*\/?$/;

/**
 * Extract the trailing path to forward from `pathname`, or `null` if it is a
 * traversal attempt. Pure so the allowlist can be exercised directly.
 */
export function safeWebhookSuffix(
  pathname: string,
  platform: string,
): string | null {
  const prefix = `/api/eliza-app/webhook/${platform}`;
  if (!pathname.startsWith(prefix)) return "";
  const suffix = pathname.slice(prefix.length);
  if (suffix === "/" || suffix === "") return "";
  return SAFE_WEBHOOK_SUFFIX.test(suffix) ? suffix : null;
}

function requestSuffix(c: AppContext, platform: string): string | null {
  return safeWebhookSuffix(new URL(c.req.url).pathname, platform);
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
  headers.set(
    "x-forwarded-proto",
    new URL(c.req.url).protocol.replace(":", ""),
  );

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

  const suffix = requestSuffix(c, platform);
  if (suffix === null) {
    logger.warn("[ElizaAppWebhook] rejected traversal suffix", { platform });
    return c.json(
      {
        success: false,
        code: "WEBHOOK_INVALID_PATH",
        error: "Invalid webhook path",
      },
      400,
    );
  }

  const project =
    readStringEnv(c, ["ELIZA_APP_WEBHOOK_PROJECT"]) ?? "eliza-app";
  const target = new URL(baseUrl);
  const sourceUrl = new URL(c.req.url);
  target.pathname = `/webhook/${encodeURIComponent(project)}/${platform}${suffix}`;
  target.search = sourceUrl.search;

  return proxyRequest(c, target, "webhook gateway", options);
}

export async function forwardToDiscordWebhookHandler(
  c: AppContext,
): Promise<Response> {
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
