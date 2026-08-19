/**
 * POST /api/v1/oxapay/webhook
 *
 * Unauthed but signature-verified OxaPay callback for the unified
 * payment_requests flow — the settlement leg of the OxaPay credit rail
 * (#10732). Authenticates the callback the same way the legacy
 * /api/crypto/webhook does (optional OXAPAY_WEBHOOK_IPS allowlist + the
 * HMAC-SHA512 `hmac` header, verified against OXAPAY_MERCHANT_API_KEY
 * inside the adapter's `parseWebhook`), dedupes by track id + disposition,
 * then atomically persists the provider event, request transition, and credit
 * grant before dispatching a non-authoritative callback.
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
import { OxaPayApiError } from "@/lib/services/oxapay";
import { createOxaPayPaymentAdapter } from "@/lib/services/payment-adapters/oxapay";
import { paymentCallbackBus } from "@/lib/services/payment-callback-bus";
import {
  type DurablePaymentProviderEvent,
  dispatchPaymentCallbacks,
  processPaymentProviderEvent,
  sha256Hex,
} from "@/lib/services/payment-request-settlement";
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

interface OxaPayWebhookDependencies {
  adapter: typeof oxaPayAdapter;
  processProviderEvent: (
    event: DurablePaymentProviderEvent & { provider: "oxapay" },
  ) => ReturnType<typeof processPaymentProviderEvent>;
  dispatchCallbacks: typeof dispatchPaymentCallbacks;
  digest: typeof sha256Hex;
}

export function createOxaPayWebhookApp(
  dependencies: OxaPayWebhookDependencies = {
    adapter: oxaPayAdapter,
    processProviderEvent: processPaymentProviderEvent,
    dispatchCallbacks: dispatchPaymentCallbacks,
    digest: sha256Hex,
  },
): Hono<AppEnv> {
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

    if (!dependencies.adapter.parseWebhook) {
      return c.json(
        { success: false, error: "OxaPay adapter does not support webhooks" },
        500,
      );
    }

    let parsed: Awaited<
      ReturnType<NonNullable<typeof oxaPayAdapter.parseWebhook>>
    >;
    try {
      parsed = await dependencies.adapter.parseWebhook({ rawBody, signature });
    } catch (error) {
      // error-policy:J1 translate provider authentication and parsing failures.
      if (error instanceof IgnoredWebhookEvent) {
        logger.info("[OxaPayWebhook API] Ignored event", {
          reason: error.message,
        });
        // OxaPay requires exactly "ok" with HTTP 200 to stop redelivery.
        return c.body("ok", 200, { "Content-Type": "text/plain" });
      }
      if (error instanceof OxaPayApiError) {
        logger.error("[OxaPayWebhook API] Payment inquiry failed", {
          error: error.message,
        });
        return c.body("error", 500, { "Content-Type": "text/plain" });
      }
      logger.warn(
        "[OxaPayWebhook API] Signature verification or parse failed",
        {
          ip: redact.ip(ip),
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return c.json(
        { success: false, error: "Webhook verification failed" },
        400,
      );
    }
    if (!parsed.txRef) {
      return c.body("error", 400, { "Content-Type": "text/plain" });
    }
    const failureReason =
      parsed.status === "settled"
        ? null
        : typeof parsed.proof.oxapay_status === "string"
          ? `OxaPay invoice ${parsed.proof.oxapay_status}`
          : "OxaPay payment failed";

    let processed: Awaited<ReturnType<typeof processPaymentProviderEvent>>;
    try {
      const semanticDelivery = JSON.stringify({
        providerEventId: parsed.providerEventId,
        paymentRequestId: parsed.paymentRequestId,
        disposition: parsed.status,
        providerTxRef: parsed.txRef,
        amountCents: parsed.amountCents ?? null,
        currency: parsed.currency?.toUpperCase() ?? null,
      });
      processed = await dependencies.processProviderEvent({
        provider: "oxapay",
        providerEventId: parsed.providerEventId,
        paymentRequestId: parsed.paymentRequestId,
        disposition: parsed.status,
        providerTxRef: parsed.txRef,
        payloadDigest: await dependencies.digest(semanticDelivery),
        amountCents: parsed.amountCents,
        currency: parsed.currency,
        proof: parsed.proof,
        error: failureReason ?? undefined,
      });
    } catch (error) {
      // error-policy:J1 ask OxaPay to retry durable fulfillment failures.
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

    if (
      processed.callbackState === "pending" ||
      processed.callbackState === "failed"
    ) {
      await paymentCallbackBus.publish(processed.callback);
      await dependencies.dispatchCallbacks({
        provider: "oxapay",
        providerEventId: processed.callback.providerEventId,
        limit: 1,
      });
    }

    return c.body("ok", 200, { "Content-Type": "text/plain" });
  });

  app.get("/", (c) =>
    c.json({
      status: "ok",
      message: "OxaPay payment_requests webhook endpoint",
    }),
  );

  return app;
}

const app = createOxaPayWebhookApp();
export default app;
