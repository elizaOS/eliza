/**
 * /api/crypto/webhook
 * OxaPay → us callback. Verifies HMAC-SHA512 signature against
 * `OXAPAY_MERCHANT_API_KEY`, dedupes by event id, then delegates to
 * `cryptoPaymentsService.handleWebhook`. POST returns "ok" on success per
 * OxaPay's contract. GET is a status probe.
 *
 * HMAC verification uses WebCrypto (Workers-native) instead of node:crypto.
 */

import { Hono } from "hono";
import { webhookEventsRepository } from "@/db/repositories/webhook-events";
import {
  extractWebhookTimestamp,
  normalizeWebhookPayload,
  type OxaPayWebhookPayload,
  validateWebhookTimestamp,
} from "@/lib/config/crypto";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { cryptoPaymentsService } from "@/lib/services/crypto-payments";
import { isOxaPayConfigured } from "@/lib/services/oxapay";
import { logger, redact } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

function getClientIp(c: AppContext): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown"
  );
}

function getWebhookAllowedIps(env: AppContext["env"]): string[] {
  const raw = env.OXAPAY_WEBHOOK_IPS;
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .split(",")
    .map((ip: string) => ip.trim())
    .filter(Boolean);
}

function isIpAllowed(ip: string, allowedIps: string[]): boolean {
  if (allowedIps.length === 0) return true;
  return allowedIps.includes(ip);
}

async function hmacHex(
  algo: "SHA-256" | "SHA-512",
  secret: string,
  message: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: algo },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyOxaPaySignature(
  secret: string,
  payload: string,
  signature: string | null,
  ip: string,
): Promise<boolean> {
  if (!signature) {
    logger.warn("[Crypto Webhook] No HMAC signature header provided", { ip: redact.ip(ip) });
    return false;
  }
  const expected = await hmacHex("SHA-512", secret, payload);
  return constantTimeEqualHex(signature, expected);
}

function generateWebhookEventId(trackId: string, status: string, payloadHash: string): string {
  return `oxapay_${trackId}_${status}_${payloadHash}`;
}

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  const ip = getClientIp(c);
  const allowedIps = getWebhookAllowedIps(c.env);

  if (!isIpAllowed(ip, allowedIps)) {
    logger.warn(
      "[Crypto Webhook] Request from non-allowlisted IP - potential unauthorized access",
      { ip: redact.ip(ip), allowlistConfigured: allowedIps.length > 0 },
    );
    return c.json({ error: "Unauthorized" }, 403);
  }

  try {
    if (!isOxaPayConfigured()) {
      logger.warn("[Crypto Webhook] Service not configured", { ip: redact.ip(ip) });
      return c.json({ error: "Service unavailable" }, 503);
    }

    const auditHashKey = c.env.OXAPAY_MERCHANT_API_KEY;
    if (!auditHashKey) {
      logger.error(
        "[Crypto Webhook] OXAPAY_MERCHANT_API_KEY is required when crypto payments are enabled",
        { ip: redact.ip(ip) },
      );
      return c.json({ error: "Service misconfigured" }, 503);
    }

    const rawBody = await c.req.text();
    const signature = c.req.header("hmac");
    const timestampHeader =
      c.req.header("x-webhook-timestamp") || c.req.header("timestamp") || null;

    const payloadHash = (await hmacHex("SHA-256", auditHashKey, rawBody)).slice(0, 16);

    if (!(await verifyOxaPaySignature(auditHashKey, rawBody, signature ?? null, ip))) {
      logger.error("[Crypto Webhook] Signature verification failed - potential security threat", {
        ip: redact.ip(ip),
        payloadHash,
        hasSignature: !!signature,
      });
      return c.json({ error: "Unauthorized" }, 401);
    }

    let payload: OxaPayWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      logger.warn("[Crypto Webhook] Invalid JSON payload", {
        ip: redact.ip(ip),
        payloadHash,
      });
      return c.json({ error: "Invalid request" }, 400);
    }

    const normalizedPayload = normalizeWebhookPayload(payload);

    if (!normalizedPayload.trackId || !normalizedPayload.status) {
      logger.warn("[Crypto Webhook] Missing required fields", {
        ip: redact.ip(ip),
        payloadHash,
        hasTrackId: !!normalizedPayload.trackId,
        hasStatus: !!normalizedPayload.status,
      });
      return c.json({ error: "Missing required fields" }, 400);
    }

    const webhookTimestampMs = extractWebhookTimestamp(timestampHeader, payload);
    const timestampValidation = validateWebhookTimestamp(webhookTimestampMs);
    if (!timestampValidation.isValid) {
      logger.warn("[Crypto Webhook] Timestamp validation failed - potential replay attack", {
        ip: redact.ip(ip),
        payloadHash,
        trackId: redact.trackId(normalizedPayload.trackId),
        error: timestampValidation.error,
      });
      return c.json({ error: `Webhook rejected: ${timestampValidation.error}` }, 400);
    }

    const eventId = generateWebhookEventId(
      normalizedPayload.trackId,
      normalizedPayload.status,
      payloadHash,
    );

    const insertResult = await webhookEventsRepository.tryCreate({
      event_id: eventId,
      provider: "oxapay",
      event_type: normalizedPayload.status,
      payload_hash: payloadHash,
      source_ip: ip,
      event_timestamp: timestampValidation.timestamp,
    });

    if (!insertResult.created) {
      logger.warn("[Crypto Webhook] Duplicate webhook detected - ignoring", {
        ip: redact.ip(ip),
        payloadHash,
        trackId: redact.trackId(normalizedPayload.trackId),
        status: normalizedPayload.status,
        eventId,
      });
      return c.json({ success: true, message: "Webhook already processed" });
    }

    logger.info("[Crypto Webhook] Valid webhook received", {
      ip: redact.ip(ip),
      trackId: redact.trackId(normalizedPayload.trackId),
      status: normalizedPayload.status,
      amount: normalizedPayload.amount,
      payAmount: normalizedPayload.payAmount,
      payloadHash,
      eventId,
    });

    const result = await cryptoPaymentsService.handleWebhook({
      track_id: normalizedPayload.trackId,
      status: normalizedPayload.status,
      amount: normalizedPayload.amount,
      pay_amount: normalizedPayload.payAmount,
      txID: normalizedPayload.txID,
    });

    logger.info("[Crypto Webhook] Webhook processed successfully", {
      ip: redact.ip(ip),
      trackId: redact.trackId(normalizedPayload.trackId),
      success: result.success,
      message: result.message,
      eventId,
    });

    // OxaPay requires exactly "ok" with HTTP 200 for successful delivery.
    return c.body("ok", 200, { "Content-Type": "text/plain" });
  } catch (error) {
    logger.error("[Crypto Webhook] Error processing webhook", {
      ip: redact.ip(ip),
      error: error instanceof Error ? error.message : "Unknown error",
    });
    // Return 500 so OxaPay will retry.
    return c.body("error", 500, { "Content-Type": "text/plain" });
  }
});

app.get("/", (c) => c.json({ status: "ok", message: "OxaPay webhook endpoint" }));

export default app;
