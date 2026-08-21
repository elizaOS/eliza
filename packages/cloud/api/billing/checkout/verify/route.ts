/**
 * POST /api/billing/checkout/verify
 *
 * Synchronous fallback for the Stripe webhook on the billing-success page.
 * Retrieves a Stripe Checkout Session, verifies it belongs to the caller's
 * organization, and delegates to the same durable settlement authority used
 * by the webhook queue. Stripe metadata is only an order lookup hint.
 */

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import { dbRead } from "@/db/helpers";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import {
  ForbiddenError,
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { safeFetch } from "@/lib/security/safe-fetch";
import { invoicesService } from "@/lib/services/invoices";
import {
  StripeCheckoutAuthorityError,
  stripeCheckoutOrdersService,
} from "@/lib/services/stripe-checkout-orders";
import { usersService } from "@/lib/services/users";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const VerifyBody = z.object({
  session_id: z.string().min(1),
  from: z.string().optional(),
});

const app = new Hono<AppEnv>();

app.use("*", moneyRateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const rawBody = await c.req.json().catch(() => null);
    const parsed = VerifyBody.safeParse(rawBody);
    if (!parsed.success) {
      throw ValidationError("Invalid request body", {
        issues: parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const { session_id: sessionId } = parsed.data;

    const session = await requireStripe().checkout.sessions.retrieve(
      sessionId,
      {
        expand: ["payment_intent"],
      },
    );

    if (session.payment_status !== "paid") {
      throw ValidationError(
        `Payment not completed. Status: ${session.payment_status}`,
      );
    }

    const checkoutOrderId = session.metadata?.checkout_order_id;
    const agentId = session.metadata?.agent_id;
    const user = await resolveCreditUser(c, agentId);

    const paymentIntent = session.payment_intent as
      | Stripe.PaymentIntent
      | string
      | null;
    const paymentIntentId =
      typeof paymentIntent === "string"
        ? paymentIntent
        : (paymentIntent?.id ?? null);

    if (!paymentIntentId) {
      throw ValidationError("No payment intent found on session");
    }

    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : (session.customer?.id ?? null);
    const settlement = checkoutOrderId
      ? await stripeCheckoutOrdersService.settle(
          {
            checkoutOrderId,
            clientReferenceId: session.client_reference_id,
            metadataOrderId: session.metadata?.checkout_order_id ?? null,
            checkoutSessionId: session.id,
            paymentIntentId,
            paymentStatus: session.payment_status,
            amountTotal: session.amount_total,
            currency: session.currency,
            customerId,
          },
          {
            callerOrganizationId: user.organization_id,
            callerUserId: user.id,
          },
        )
      : await stripeCheckoutOrdersService.settleLegacy(
          {
            checkoutSessionId: session.id,
            paymentIntentId,
            paymentStatus: session.payment_status,
            amountTotal: session.amount_total,
            currency: session.currency,
            customerId,
            organizationId: session.metadata?.organization_id ?? null,
            initiatedByUserId: session.metadata?.user_id ?? null,
            purchaseType: session.metadata?.type ?? null,
            creditPackId: session.metadata?.credit_pack_id ?? null,
            claimedCredits: session.metadata?.credits ?? null,
          },
          {
            callerOrganizationId: user.organization_id,
            callerUserId: user.id,
          },
        );
    const authority =
      "order" in settlement
        ? {
            durableOrder: settlement.order,
            organizationId: settlement.order.organization_id,
            stripeCustomerId: settlement.order.stripe_customer_id,
            credits: Number(settlement.order.credits_to_grant),
            purchaseType: settlement.order.purchase_type,
          }
        : {
            durableOrder: null,
            organizationId: settlement.organizationId,
            stripeCustomerId: customerId as string,
            credits: Number(settlement.creditsToGrant),
            purchaseType: settlement.purchaseType,
          };
    const { durableOrder, credits, purchaseType } = authority;
    if (!authority.stripeCustomerId) {
      throw new StripeCheckoutAuthorityError(
        "STRIPE_CHECKOUT_CUSTOMER_MISMATCH",
        "Settled Checkout order has no pinned Stripe customer",
      );
    }

    const existingInvoice = await invoicesService.getByStripeInvoiceId(
      `cs_${sessionId}`,
    );
    if (!existingInvoice) {
      const amountTotal = durableOrder
        ? (Number(durableOrder.charge_amount_cents) / 100).toFixed(2)
        : ((session.amount_total ?? 0) / 100).toFixed(2);

      await invoicesService.create({
        organization_id: authority.organizationId,
        stripe_invoice_id: `cs_${sessionId}`,
        stripe_customer_id: authority.stripeCustomerId,
        stripe_payment_intent_id: paymentIntentId,
        amount_due: amountTotal,
        amount_paid: amountTotal,
        currency: session.currency ?? "usd",
        status: "paid",
        invoice_type: purchaseType,
        invoice_number: undefined,
        invoice_pdf: undefined,
        hosted_invoice_url: undefined,
        credits_added: credits.toString(),
        metadata: {
          type: purchaseType,
          ...(durableOrder ? { checkout_order_id: durableOrder.id } : {}),
          session_id: sessionId,
          ...(agentId ? { agent_id: agentId } : {}),
          source: durableOrder
            ? "durable_checkout_settlement"
            : "legacy_checkout_cutover",
        },
        paid_at: new Date(),
      });
    }

    if (agentId) {
      await notifyWaifuCreditsToppedUp({
        agentId,
        eventId: `billing-verify:${sessionId}:credits.topped_up:${agentId}${settlement.alreadyApplied ? ":already_applied" : ""}`,
        credits,
        paymentIntentId,
        sessionId,
      });
    }

    return c.json({
      success: true,
      balance: settlement.newBalance,
      alreadyApplied: settlement.alreadyApplied,
    });
  } catch (error) {
    // error-policy:J1 route boundary for the billing/ dir — the outermost handler
    // catch translates exceptions into a structured HTTP failure
    // (failureResponse → 5xx / typed status), never a fabricated success.
    logger.error("[Billing Checkout Verify] Error:", error);
    if (error instanceof StripeCheckoutAuthorityError) {
      if (
        error.code === "STRIPE_CHECKOUT_ORGANIZATION_MISMATCH" ||
        error.code === "STRIPE_CHECKOUT_USER_MISMATCH"
      ) {
        return failureResponse(
          c,
          ForbiddenError("You do not have access to this checkout order"),
        );
      }
      return failureResponse(
        c,
        ValidationError("Checkout settlement could not be verified"),
      );
    }
    return failureResponse(c, error);
  }
});

async function resolveCreditUser(
  c: Parameters<typeof requireUserOrApiKeyWithOrg>[0],
  agentId?: string,
): ReturnType<typeof requireUserOrApiKeyWithOrg> {
  if (!agentId) return requireUserOrApiKeyWithOrg(c);
  // S2S agent-billing branch: enforce a valid service key (validateServiceKey
  // returns null on a bad key, so awaiting-and-discarding it left this path
  // triggerable unauthenticated — see #11981 class).
  await requireServiceKey(c);

  const [sandbox] = await dbRead
    .select({
      organizationId: agentSandboxes.organization_id,
      userId: agentSandboxes.user_id,
    })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId))
    .limit(1);
  if (!sandbox) throw ValidationError("Invalid agent_id");

  const user = await usersService.getWithOrganization(sandbox.userId);
  if (
    !user?.organization_id ||
    !user?.organization ||
    user.organization_id !== sandbox.organizationId
  ) {
    throw ValidationError("Agent owner account is not billable");
  }

  return user as Awaited<ReturnType<typeof requireUserOrApiKeyWithOrg>>;
}

async function notifyWaifuCreditsToppedUp(params: {
  agentId: string;
  eventId: string;
  credits: number;
  paymentIntentId: string;
  sessionId: string;
}): Promise<void> {
  const [sandbox] = await dbRead
    .select({
      id: agentSandboxes.id,
      organizationId: agentSandboxes.organization_id,
      agent_config: agentSandboxes.agent_config,
      status: agentSandboxes.status,
      billing_status: agentSandboxes.billing_status,
    })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, params.agentId))
    .limit(1);
  if (!sandbox) return;

  const config = recordFromUnknown(sandbox.agent_config);
  const waifuWebhook = recordFromUnknown(config.waifuWebhook);
  const webhookUrl =
    stringField(config, "webhookUrl") ?? stringField(waifuWebhook, "url");
  const webhookSecret =
    stringField(config, "webhookSecret") ??
    stringField(waifuWebhook, "secret") ??
    process.env.ELIZA_CLOUD_WEBHOOK_SECRET ??
    process.env.WAIFU_WEBHOOK_SECRET;
  if (!webhookUrl || !webhookSecret) return;

  const timestamp = new Date().toISOString();
  const account = recordFromUnknown(config.account);
  const body = JSON.stringify({
    event: "credits.topped_up",
    timestamp,
    eventId: params.eventId,
    elizaCloudAgentId: sandbox.id,
    agentId: sandbox.id,
    organizationId: sandbox.organizationId,
    tokenContractAddress: stringField(config, "tokenContractAddress"),
    tokenAddress: stringField(config, "tokenContractAddress"),
    tokenChain: stringField(config, "chain"),
    chain: stringField(config, "chain"),
    chainId: numberField(config, "chainId"),
    primaryWalletAddress: stringField(account, "primaryWalletAddress"),
    walletKeyRef: stringField(account, "walletKeyRef"),
    amount: params.credits,
    amountUsd: params.credits,
    paymentIntentId: params.paymentIntentId,
    sessionId: params.sessionId,
    billingStatus: sandbox.billing_status,
    status: sandbox.status,
  });
  const signature = `sha256=${createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;

  try {
    // SECURITY (#9853): webhookUrl is DB-stored per-agent config — IP-pin it so
    // a malicious receiver URL can't pivot into internal/metadata networks.
    const response = await safeFetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Waifu-Webhook-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn("[Billing Checkout Verify] Waifu credit webhook failed", {
        agentId: params.agentId,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn("[Billing Checkout Verify] Waifu credit webhook error", {
      agentId: params.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberField(
  data: Record<string, unknown>,
  key: string,
): number | null {
  const value = data[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export default app;
