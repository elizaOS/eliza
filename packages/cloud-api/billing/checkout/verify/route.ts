/**
 * POST /api/billing/checkout/verify
 *
 * Synchronous fallback for the Stripe webhook on the billing-success page.
 * Retrieves a Stripe Checkout Session, verifies it belongs to the caller's
 * organization, and credits the org once (idempotent on payment_intent.id via
 * `creditsService.addCredits`). Returns the live balance and whether the
 * webhook had already applied the credits.
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
import { validateServiceKey } from "@/lib/auth/service-key-hono-worker";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { creditsService } from "@/lib/services/credits";
import { invoicesService } from "@/lib/services/invoices";
import { organizationsService } from "@/lib/services/organizations";
import { usersService } from "@/lib/services/users";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_CREDITS = 10000;

const VerifyBody = z.object({
  session_id: z.string().min(1),
  from: z.string().optional(),
});

function parseAndValidateCredits(creditsStr: string): number | null {
  const credits = Number.parseFloat(creditsStr);
  if (!Number.isFinite(credits) || credits <= 0 || credits > MAX_CREDITS) {
    return null;
  }
  return Math.round(credits * 100) / 100;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

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

    const organizationId = session.metadata?.organization_id;
    const userId = session.metadata?.user_id;
    const creditsStr = session.metadata?.credits ?? "0";
    const credits = parseAndValidateCredits(creditsStr);
    const purchaseType = session.metadata?.type ?? "checkout";
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

    if (
      organizationId !== user.organization_id ||
      (userId && userId !== user.id)
    ) {
      throw ForbiddenError("You do not have access to this checkout session.");
    }

    if (
      !organizationId ||
      !credits ||
      (purchaseType !== "custom_amount" && purchaseType !== "credit_pack")
    ) {
      throw ValidationError("Invalid session metadata");
    }

    if (!paymentIntentId) {
      throw ValidationError("No payment intent found on session");
    }

    const existingTransaction =
      await creditsService.getTransactionByStripePaymentIntent(paymentIntentId);

    if (existingTransaction) {
      const freshOrg = await organizationsService.getById(user.organization_id);
      const balance = Number(freshOrg?.credit_balance ?? 0);
      if (agentId) {
        await notifyWaifuCreditsToppedUp({
          agentId,
          eventId: `billing-verify:${sessionId}:credits.topped_up:${agentId}:already_applied`,
          credits,
          paymentIntentId,
          sessionId,
        });
      }
      return c.json({
        success: true,
        balance,
        alreadyApplied: true,
      });
    }

    const { newBalance } = await creditsService.addCredits({
      organizationId,
      amount: credits,
      description: `Balance top-up - $${credits.toFixed(2)}`,
      metadata: {
        user_id: userId,
        payment_intent_id: paymentIntentId,
        session_id: sessionId,
        type: purchaseType,
        ...(agentId ? { agent_id: agentId } : {}),
        source: "success_page_fallback",
      },
      stripePaymentIntentId: paymentIntentId,
    });

    const existingInvoice = await invoicesService.getByStripeInvoiceId(
      `cs_${sessionId}`,
    );
    if (!existingInvoice) {
      const amountTotal = session.amount_total
        ? (session.amount_total / 100).toString()
        : credits.toString();

      await invoicesService.create({
        organization_id: organizationId,
        stripe_invoice_id: `cs_${sessionId}`,
        stripe_customer_id: session.customer as string,
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
          session_id: sessionId,
          ...(agentId ? { agent_id: agentId } : {}),
          source: "success_page_fallback",
        },
        paid_at: new Date(),
      });
    }

    if (agentId) {
      await notifyWaifuCreditsToppedUp({
        agentId,
        eventId: `billing-verify:${sessionId}:credits.topped_up:${agentId}`,
        credits,
        paymentIntentId,
        sessionId,
      });
    }

    return c.json({
      success: true,
      balance: newBalance,
      alreadyApplied: false,
    });
  } catch (error) {
    logger.error("[Billing Checkout Verify] Error:", error);
    return failureResponse(c, error);
  }
});

async function resolveCreditUser(
  c: Parameters<typeof requireUserOrApiKeyWithOrg>[0],
  agentId?: string,
): ReturnType<typeof requireUserOrApiKeyWithOrg> {
  if (!agentId) return requireUserOrApiKeyWithOrg(c);
  await validateServiceKey(c);

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
    const response = await fetch(webhookUrl, {
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
