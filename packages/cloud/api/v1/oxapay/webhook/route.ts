/**
 * POST /api/v1/oxapay/webhook
 *
 * Unauthed but signature-verified OxaPay callback for the unified
 * payment_requests flow — the settlement leg of the OxaPay credit rail
 * (#10732). Authenticates the callback the same way the legacy
 * /api/crypto/webhook does (optional OXAPAY_WEBHOOK_IPS allowlist + the
 * HMAC-SHA512 `hmac` header, verified against OXAPAY_MERCHANT_API_KEY
 * inside the adapter's `parseWebhook`), dedupes by track id + disposition,
 * then marks the payment request settled/failed and publishes
 * `PaymentSettled` / `PaymentFailed` on the payment callback bus — the
 * exact shape of /api/v1/stripe/webhook.
 *
 * Distinct from the legacy `/api/crypto/webhook` route, which settles the
 * old `crypto_payments` table. New invoices created by the OxaPay payment
 * adapter point their per-invoice callback here.
 */

import { Hono } from "hono";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { createOxaPayPaymentAdapter } from "@/lib/services/payment-adapters/oxapay";
import { paymentCallbackBus } from "@/lib/services/payment-callback-bus";
import { getPaymentRequestsService } from "@/lib/services/payment-requests-default";
import { IgnoredWebhookEvent } from "@/lib/services/payment-webhook-errors";
import { logger, redact } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const oxaPayAdapter = createOxaPayPaymentAdapter();

function getClientIp(c: AppContext): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
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

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.AGGRESSIVE), async (c) => {
  const ip = getClientIp(c);
  const allowedIps = getWebhookAllowedIps(c.env);
  if (allowedIps.length > 0 && !allowedIps.includes(ip)) {
    logger.warn("[OxaPayWebhook API] Request from non-allowlisted IP", {
      ip: redact.ip(ip),
    });
    return c.json({ success: false, error: "Unauthorized" }, 403);
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("hmac") ?? null;
  if (!signature) {
    return c.json({ success: false, error: "Missing hmac header" }, 400);
  }

  if (!oxaPayAdapter.parseWebhook) {
    return c.json(
      { success: false, error: "OxaPay adapter does not support webhooks" },
      500,
    );
  }

  let parsed: Awaited<
    ReturnType<NonNullable<typeof oxaPayAdapter.parseWebhook>>
  >;
  try {
    parsed = await oxaPayAdapter.parseWebhook({ rawBody, signature });
  } catch (error) {
    if (error instanceof IgnoredWebhookEvent) {
      logger.info("[OxaPayWebhook API] Ignored event", {
        reason: error.message,
      });
      // OxaPay requires exactly "ok" with HTTP 200 to stop redelivery.
      return c.body("ok", 200, { "Content-Type": "text/plain" });
    }
    logger.warn("[OxaPayWebhook API] Signature verification or parse failed", {
      ip: redact.ip(ip),
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { success: false, error: "Webhook verification failed" },
      400,
    );
  }

  const providerEventId = `${parsed.txRef ?? parsed.paymentRequestId}:${parsed.status}`;
  const service = getPaymentRequestsService(c.env);
  const failureReason =
    parsed.status === "settled"
      ? null
      : typeof parsed.proof.status === "string"
        ? `OxaPay invoice ${parsed.proof.status}`
        : "OxaPay payment failed";

  // Persist FIRST, record the dedupe key only after success: recording before
  // persistence would poison the key when markSettled fails transiently, and
  // OxaPay's retry would then be skipped — the user pays and is never
  // credited. Replays are safe either way because markSettled/markFailed are
  // idempotent (a same-txRef replay returns the existing settled row without
  // emitting a second event).
  try {
    if (parsed.status === "settled") {
      await service.markSettled(
        parsed.paymentRequestId,
        parsed.txRef ?? "oxapay:settled",
        parsed.proof,
      );
    } else {
      await service.markFailed(
        parsed.paymentRequestId,
        failureReason ?? "OxaPay payment failed",
      );
    }
  } catch (error) {
    // Unknown payment request, terminal-state conflict, or storage failure.
    // Return 500 so OxaPay retries; benign replays (same txRef, already
    // settled) do not throw, so retry storms self-resolve while genuine
    // anomalies stay loud in the logs.
    logger.error("[OxaPayWebhook API] Settlement persistence failed", {
      paymentRequestId: parsed.paymentRequestId,
      status: parsed.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.body("error", 500, { "Content-Type": "text/plain" });
  }

  // In-process replay dedupe for bus publishes (same shape as the Stripe
  // webhook — the durable settle guarantee above does not depend on it).
  const recorded = paymentCallbackBus.recordProviderEvent(
    "oxapay",
    providerEventId,
  );
  if (!recorded) {
    logger.debug("[OxaPayWebhook API] Duplicate event — skipping publish", {
      providerEventId,
    });
    return c.body("ok", 200, { "Content-Type": "text/plain" });
  }

  if (parsed.status === "settled") {
    await paymentCallbackBus.publish({
      name: "PaymentSettled",
      paymentRequestId: parsed.paymentRequestId,
      provider: "oxapay",
      txRef: parsed.txRef,
      providerEventId,
      settledAt: new Date(),
    });
  } else {
    await paymentCallbackBus.publish({
      name: "PaymentFailed",
      paymentRequestId: parsed.paymentRequestId,
      provider: "oxapay",
      txRef: parsed.txRef,
      providerEventId,
      error: failureReason ?? "OxaPay payment failed",
      failedAt: new Date(),
    });
  }

  return c.body("ok", 200, { "Content-Type": "text/plain" });
});

app.get("/", (c) =>
  c.json({ status: "ok", message: "OxaPay payment_requests webhook endpoint" }),
);

export default app;
