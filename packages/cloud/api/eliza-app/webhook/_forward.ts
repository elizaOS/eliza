/** Authenticates provider webhooks and proxies them to the matching connector gateway. */
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import {
  appendServerTiming,
  ELIZA_TRACE_ID_HEADER,
  resolveElizaTraceId,
} from "@/lib/observability/http-telemetry";
import { logger } from "@/lib/utils/logger";
import type { AppContext } from "@/types/cloud-worker-env";

type GatewayPlatform = "telegram" | "blooio" | "twilio";

const WEBHOOK_GATEWAY_ENV_KEYS = [
  "ELIZA_APP_WEBHOOK_GATEWAY_URL",
  "WEBHOOK_GATEWAY_URL",
  "GATEWAY_WEBHOOK_URL",
] as const;

// Shared secret proving a request actually came from THIS BFF forwarder rather
// than straight at the internal gateway. The forwarders are unauthenticated at
// the edge (providers can't present a Cloud session), so without a local
// signal the gateway has to trust its network boundary alone. Stamping a
// shared secret on the forwarded call lets the gateway reject anything that
// didn't transit the BFF. (finding L3, #12878 / #12227)
//
// This is a DEDICATED secret, deliberately NOT reusing `GATEWAY_INTERNAL_SECRET`
// (which gates the gateway's `/internal/event` K8s path). Coupling the two would
// force every direct provider webhook to present the internal-event secret the
// moment internal events are enabled. Keeping it separate makes the
// forwarder-only gate opt-in without touching existing traffic.
const WEBHOOK_GATEWAY_SECRET_ENV_KEYS = [
  "ELIZA_APP_WEBHOOK_GATEWAY_SECRET",
] as const;

// The header the gateway validates for BFF-forwarded webhooks
// (`enforceForwarderSecret` in
// packages/cloud/services/gateway-webhook/src/internal-auth.ts). Any inbound
// copy of this header from the original caller MUST be stripped before we
// (re)stamp our own value — a client that could inject it would forge the
// "came from the BFF" proof. It is stripped on EVERY proxied request (including
// the Discord handler) and stamped ONLY on gateway forwards.
const GATEWAY_SECRET_HEADER = "x-eliza-webhook-forwarder-secret";

// Blooio documents a five-minute replay window. The edge and gateway must use
// the same tolerance or a valid provider retry can pass one boundary and fail
// the other.
const BLOOIO_SIGNATURE_TOLERANCE_SECONDS = 300;

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

function isProduction(c: AppContext): boolean {
  return (
    c.env.NODE_ENV === "production" || process.env.NODE_ENV === "production"
  );
}

function platformSecret(
  c: AppContext,
  platform: GatewayPlatform,
): string | null {
  switch (platform) {
    case "telegram":
      return readStringEnv(c, [
        "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
        "TELEGRAM_WEBHOOK_SECRET",
      ]);
    case "blooio":
      return readStringEnv(c, [
        "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
        "BLOOIO_WEBHOOK_SECRET",
      ]);
    case "twilio":
      return readStringEnv(c, [
        "ELIZA_APP_TWILIO_AUTH_TOKEN",
        "TWILIO_AUTH_TOKEN",
      ]);
  }
}

async function hmacHex(
  secret: string,
  payload: string,
  algorithm: AlgorithmIdentifier,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacBase64(
  secret: string,
  payload: string,
  algorithm: AlgorithmIdentifier,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function constantTimeHexEqual(actual: string, expected: string): boolean {
  return timingSafeEqualSecret(actual.toLowerCase(), expected.toLowerCase());
}

async function verifyBlooioSignature(
  request: Request,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  const signatureHeader = request.headers.get("x-blooio-signature") ?? "";
  const parts = signatureHeader.split(",");
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const signaturePart = parts.find((p) => p.startsWith("v1="));
  if (!timestampPart || !signaturePart) return false;

  const timestamp = Number.parseInt(timestampPart.slice(2), 10);
  if (!Number.isFinite(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > BLOOIO_SIGNATURE_TOLERANCE_SECONDS)
    return false;

  const expected = signaturePart.slice(3);
  const computed = await hmacHex(secret, `${timestamp}.${rawBody}`, "SHA-256");
  return constantTimeHexEqual(computed, expected);
}

async function verifyTwilioSignature(
  request: Request,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  const signature = request.headers.get("x-twilio-signature") ?? "";
  if (!signature) return false;

  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  if (forwardedHost) url.host = forwardedHost;

  const params = new URLSearchParams(rawBody);
  const sorted = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${value}`)
    .join("");

  const computed = await hmacBase64(
    secret,
    `${url.toString()}${sorted}`,
    "SHA-1",
  );
  return timingSafeEqualSecret(computed, signature);
}

export async function verifyLocalWebhookSignature(
  request: Request,
  platform: GatewayPlatform,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  switch (platform) {
    case "telegram": {
      const header =
        request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      return timingSafeEqualSecret(header, secret);
    }
    case "blooio":
      return verifyBlooioSignature(request, rawBody, secret);
    case "twilio":
      return verifyTwilioSignature(request, rawBody, secret);
  }
}

async function validateLocalWebhookSignature(
  c: AppContext,
  platform: GatewayPlatform,
): Promise<{ response?: Response; body?: string }> {
  const secret = platformSecret(c, platform);
  if (!secret) {
    if (isProduction(c)) {
      logger.error(
        "[ElizaAppWebhook] webhook signature secret is not configured",
        { platform },
      );
      return {
        response: c.json(
          {
            success: false,
            code: "WEBHOOK_SIGNATURE_NOT_CONFIGURED",
            error: "Webhook signature secret is not configured",
          },
          503,
        ),
      };
    }
    logger.warn(
      "[ElizaAppWebhook] webhook signature validation skipped outside production",
      {
        platform,
      },
    );
    return {};
  }

  const needsBody =
    platform !== "telegram" &&
    c.req.method !== "GET" &&
    c.req.method !== "HEAD";
  const body = needsBody ? await c.req.text() : undefined;
  const valid = await verifyLocalWebhookSignature(
    c.req.raw,
    platform,
    body ?? "",
    secret,
  );
  if (!valid) {
    logger.warn("[ElizaAppWebhook] rejected invalid webhook signature", {
      platform,
    });
    return {
      response: c.json(
        {
          success: false,
          code: "WEBHOOK_SIGNATURE_INVALID",
          error: "Invalid webhook signature",
        },
        401,
      ),
    };
  }

  return { body };
}

interface ForwardOptions {
  body?: BodyInit | null;
}

interface ProxyOptions extends ForwardOptions {
  // When true, stamp the BFF forwarder secret (gateway forwards only). The
  // trust header is ALWAYS stripped regardless, so a client can never inject it
  // — even on the Discord path, which never stamps.
  stampGatewaySecret?: boolean;
  headerOverrides?: Readonly<Record<string, string>>;
  telemetryMetric: "webhook_gateway_proxy" | "discord_webhook_proxy";
}

async function proxyRequest(
  c: AppContext,
  target: URL,
  serviceName: string,
  options: ProxyOptions,
): Promise<Response> {
  const headers = new Headers(c.req.raw.headers);
  const traceId = c.get("traceId") ?? resolveElizaTraceId(c.req.raw.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", new URL(c.req.url).host);
  headers.set(
    "x-forwarded-proto",
    new URL(c.req.url).protocol.replace(":", ""),
  );

  // L3: never let the original caller supply the forwarder trust header. Strip
  // it unconditionally on EVERY proxied request (gateway AND Discord), so a
  // client can never forge the "came from the BFF" proof.
  headers.delete(GATEWAY_SECRET_HEADER);
  // The BFF owns this hop's correlation identity. Re-stamping its resolved id
  // prevents an untrusted provider header from splitting the Cloud and gateway
  // spans while keeping the value opaque and bounded.
  headers.set(ELIZA_TRACE_ID_HEADER, traceId);
  // Stamp our own value ONLY on gateway forwards, and only when the dedicated
  // secret is configured. The Discord handler (a potentially separate/public
  // service) must never receive this credential.
  if (options.stampGatewaySecret) {
    const gatewaySecret = readStringEnv(c, WEBHOOK_GATEWAY_SECRET_ENV_KEYS);
    if (gatewaySecret) {
      headers.set(GATEWAY_SECRET_HEADER, gatewaySecret);
    }
  }
  for (const [name, value] of Object.entries(options.headerOverrides ?? {})) {
    headers.set(name, value);
  }

  const startedAt = performance.now();
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
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set(ELIZA_TRACE_ID_HEADER, traceId);
    appendServerTiming(responseHeaders, [
      { name: options.telemetryMetric, durationMs },
    ]);
    const logContext = {
      traceId,
      serviceName,
      status: upstream.status,
      durationMs,
    };
    if (upstream.status >= 500 || durationMs >= 1_000) {
      logger.warn(
        "[ElizaAppWebhook] upstream request slow or failed",
        logContext,
      );
    } else {
      logger.info("[ElizaAppWebhook] upstream request completed", logContext);
    }
    return new Response(upstream.body, {
      headers: responseHeaders,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch (error) {
    // error-policy:J1 Translate an upstream transport failure at the HTTP boundary.
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    logger.error("[ElizaAppWebhook] Upstream request failed", {
      traceId,
      serviceName,
      target: target.origin,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
    const response = c.json(
      {
        success: false,
        code: "WEBHOOK_UPSTREAM_UNREACHABLE",
        error: `${serviceName} is unreachable`,
      },
      502,
    );
    response.headers.set(ELIZA_TRACE_ID_HEADER, traceId);
    appendServerTiming(response.headers, [
      { name: options.telemetryMetric, durationMs },
    ]);
    return response;
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

  const validation = await validateLocalWebhookSignature(c, platform);
  if (validation.response) return validation.response;
  const signedBody = validation.body;

  const project =
    readStringEnv(c, ["ELIZA_APP_WEBHOOK_PROJECT"]) ?? "eliza-app";
  const target = new URL(baseUrl);
  const sourceUrl = new URL(c.req.url);
  target.pathname = `/webhook/${encodeURIComponent(project)}/${platform}${suffix}`;
  target.search = sourceUrl.search;

  const headerOverrides: Record<string, string> = {};
  if (platform === "twilio") {
    const secret = platformSecret(c, platform);
    const body = signedBody ?? "";
    if (secret) {
      // Twilio signs the complete public webhook URL. The BFF changes the path
      // from /api/eliza-app/webhook/twilio to /webhook/eliza-app/twilio, so the
      // original signature cannot pass the gateway's second verification. The
      // edge has already authenticated that signature; re-sign the exact URL
      // the gateway reconstructs from X-Forwarded-Host/Proto plus its route.
      const gatewayVerificationUrl = new URL(target);
      gatewayVerificationUrl.protocol = sourceUrl.protocol;
      gatewayVerificationUrl.host = sourceUrl.host;
      const params = new URLSearchParams(body);
      const sorted = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}${value}`)
        .join("");
      headerOverrides["x-twilio-signature"] = await hmacBase64(
        secret,
        `${gatewayVerificationUrl.toString()}${sorted}`,
        "SHA-1",
      );
    }
  }

  return proxyRequest(c, target, "webhook gateway", {
    ...options,
    body: options.body ?? signedBody,
    stampGatewaySecret: true,
    headerOverrides,
    telemetryMetric: "webhook_gateway_proxy",
  });
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
  return proxyRequest(c, target, "Discord webhook handler", {
    telemetryMetric: "discord_webhook_proxy",
  });
}
