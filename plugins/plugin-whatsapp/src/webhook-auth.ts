/**
 * X-Hub-Signature-256 verification for Meta webhook POSTs. Resolves the app
 * secret (runtime setting then env) and validates the HMAC-SHA256 signature over
 * the raw request body, so unsigned or tampered webhook events are rejected
 * before the connector processes them.
 */
import crypto from "node:crypto";
import type { IAgentRuntime, RouteRequest } from "@elizaos/core";

const SIGNATURE_HEADER = "x-hub-signature-256";

export function resolveWhatsAppAppSecret(runtime: IAgentRuntime): string | null {
  const fromSetting = runtime.getSetting("WHATSAPP_APP_SECRET");
  if (typeof fromSetting === "string" && fromSetting.trim()) {
    return fromSetting.trim();
  }
  const fromEnv = process.env.WHATSAPP_APP_SECRET;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return null;
}

/**
 * Verify Meta WhatsApp webhook signature (X-Hub-Signature-256).
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
export function verifyWhatsAppWebhookSignature(
  appSecret: string,
  signatureHeader: string | undefined,
  rawBody: string
): boolean {
  if (!signatureHeader || !appSecret || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  try {
    const expectedSignature = signatureHeader.slice("sha256=".length);
    const computedSignature = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const computedBuffer = Buffer.from(computedSignature, "hex");
    if (expectedBuffer.length !== computedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
  } catch {
    return false;
  }
}

export function readRouteHeader(req: RouteRequest, name: string): string | undefined {
  const headers = req.headers;
  if (!headers) return undefined;
  const key = name.toLowerCase();
  const value = headers[key] ?? headers[name] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

export function readWebhookRawBody(req: RouteRequest): string | null {
  if (typeof req.rawBody === "string" && req.rawBody.length > 0) {
    return req.rawBody;
  }
  return null;
}

export function isWhatsAppWebhookAuthorized(runtime: IAgentRuntime, req: RouteRequest): boolean {
  const rawBody = readWebhookRawBody(req);
  if (rawBody === null) {
    return false;
  }
  const appSecret = resolveWhatsAppAppSecret(runtime);
  if (!appSecret) {
    return false;
  }
  return verifyWhatsAppWebhookSignature(appSecret, readRouteHeader(req, SIGNATURE_HEADER), rawBody);
}
