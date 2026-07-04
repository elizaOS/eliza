/**
 * OxaPay payment provider adapter for the unified payment_requests flow (#10732).
 *
 * `createIntent` opens an OxaPay invoice and returns the hosted pay link.
 * `parseWebhook` verifies the OxaPay HMAC-SHA512 callback signature and maps the
 * `orderId` (which we set to the payment_request id) back to the request.
 *
 * This unifies OxaPay onto the same `payment_requests` surface + ledger as
 * Stripe, so both rails top up credits interchangeably. The legacy
 * `crypto_payments` / `/api/crypto/webhook` path is unchanged and continues to
 * serve existing OxaPay integrations.
 */

import { getCloudAwareEnv } from "../../runtime/cloud-bindings";
import { logger } from "../../utils/logger";
import { isOxaPayConfigured, oxaPayService } from "../oxapay";
import { type PaymentProviderAdapter, type PaymentRequestRow } from "../payment-requests";
import { IgnoredWebhookEvent } from "../payment-webhook-errors";

function readMetaString(request: PaymentRequestRow, key: string): string | undefined {
  const meta = (request.metadata ?? {}) as Record<string, unknown>;
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
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

export function createOxaPayPaymentAdapter(): PaymentProviderAdapter {
  return {
    provider: "oxapay",

    async createIntent({ request }) {
      if (request.provider !== "oxapay") {
        throw new Error(
          `OxaPayPaymentAdapter received non-oxapay payment request (provider=${request.provider})`,
        );
      }
      if (!isOxaPayConfigured()) {
        throw new Error("OxaPay is not configured (OXAPAY_MERCHANT_API_KEY missing)");
      }
      const amountUsd = Number(request.amountCents) / 100;
      if (!(amountUsd > 0)) {
        throw new Error("OxaPay payment amount must be greater than zero");
      }

      // OxaPay → us settlement callback. The unified rail settles via
      // /api/v1/oxapay/webhook (markSettled on payment_requests); without an
      // explicit per-invoice callback OxaPay falls back to the merchant-panel
      // default, which points at the previous /api/crypto/webhook and can never
      // settle a payment_request — the user would pay and never be credited.
      // So resolve it here and fail invoice creation loudly if we cannot.
      const env = getCloudAwareEnv();
      const callbackUrl =
        readMetaString(request, "callback_url") ??
        env.OXAPAY_PAYMENT_REQUESTS_CALLBACK_URL ??
        (env.NEXT_PUBLIC_APP_URL ? `${env.NEXT_PUBLIC_APP_URL}/api/v1/oxapay/webhook` : undefined);
      if (!callbackUrl) {
        throw new Error(
          "OxaPay settlement callback URL unresolved — set NEXT_PUBLIC_APP_URL or OXAPAY_PAYMENT_REQUESTS_CALLBACK_URL so invoices settle via /api/v1/oxapay/webhook",
        );
      }

      const returnUrl = request.successUrl ?? readMetaString(request, "success_url");
      const invoice = await oxaPayService.createInvoice({
        amount: amountUsd,
        currency: (request.currency || "usd").toUpperCase(),
        // The order id is our handle back to this payment request on the webhook.
        orderId: request.id,
        description: request.reason ?? readMetaString(request, "product_description"),
        callbackUrl,
        returnUrl,
      });

      logger.info("[OxaPayPaymentAdapter] Created invoice", {
        paymentRequestId: request.id,
        trackId: invoice.trackId,
        amountUsd,
      });

      return {
        hostedUrl: invoice.payLink,
        providerIntent: {
          oxapay_track_id: invoice.trackId,
          oxapay_pay_link: invoice.payLink,
          oxapay_amount: invoice.amount,
          oxapay_currency: invoice.currency,
          oxapay_expires_at: invoice.expiresAt.toISOString(),
        },
      };
    },

    async parseWebhook({ rawBody, signature }) {
      const env = getCloudAwareEnv();
      const secret = env.OXAPAY_MERCHANT_API_KEY;
      if (!secret) {
        throw new Error("OXAPAY_MERCHANT_API_KEY not configured; cannot verify OxaPay webhook");
      }
      const expected = await hmacSha512Hex(secret, rawBody);
      if (!signature || !constantTimeEqualHex(signature, expected)) {
        throw new Error("Invalid OxaPay webhook signature");
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        throw new Error("OxaPay webhook body is not valid JSON");
      }

      const orderId =
        (typeof payload.orderId === "string" && payload.orderId) ||
        (typeof payload.order_id === "string" && payload.order_id) ||
        "";
      const status = String(payload.status ?? "");
      const trackId =
        (typeof payload.trackId === "string" && payload.trackId) ||
        (typeof payload.track_id === "string" && payload.track_id) ||
        undefined;

      if (!orderId) {
        // No mappable order id → not one of our unified payment_requests.
        throw new IgnoredWebhookEvent("OxaPay webhook has no orderId");
      }

      if (oxaPayService.isPaymentConfirmed(status)) {
        return {
          paymentRequestId: orderId,
          status: "settled",
          txRef: trackId,
          proof: { provider: "oxapay", trackId, status, payload },
        };
      }
      if (oxaPayService.isPaymentFailed(status) || oxaPayService.isPaymentExpired(status)) {
        return {
          paymentRequestId: orderId,
          status: "failed",
          txRef: trackId,
          proof: { provider: "oxapay", trackId, status, payload },
        };
      }

      // Pending / paying / confirming — nothing to settle yet.
      throw new IgnoredWebhookEvent(`OxaPay webhook status not terminal: ${status}`);
    },
  };
}
