/**
 * POST /api/v1/credits/checkout
 * Create a Stripe checkout session for purchasing organization credits.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import { dbRead } from "@/db/helpers";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  assertAllowedAbsoluteRedirectUrl,
  getDefaultPlatformRedirectOrigins,
} from "@/lib/security/redirect-validation";
import { stripeCheckoutOrdersService } from "@/lib/services/stripe-checkout-orders";
import { stripeCustomerAuthorityService } from "@/lib/services/stripe-customer-authority";
import { usersService } from "@/lib/services/users";
import { requireStripe } from "@/lib/stripe";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const checkoutAmountSchema = z.number().min(1).max(1000);

const CheckoutSchema = z
  .object({
    /** Canonical USD-denominated organization-credit purchase amount. */
    amountUsd: checkoutAmountSchema.optional(),
    /** @deprecated Compatibility alias; this number has always meant USD. */
    credits: checkoutAmountSchema.optional(),
    agent_id: z.string().uuid().optional(),
    success_url: z.string().url(),
    cancel_url: z.string().url(),
  })
  .superRefine((value, ctx) => {
    if (value.amountUsd === undefined && value.credits === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["amountUsd"],
        message: "amountUsd is required",
      });
      return;
    }
    if (
      value.amountUsd !== undefined &&
      value.credits !== undefined &&
      value.amountUsd !== value.credits
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["credits"],
        message: "credits must equal amountUsd when both are supplied",
      });
    }
  });

const app = new Hono<AppEnv>();

app.use("*", moneyRateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;
    const validation = CheckoutSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: "Invalid request", details: validation.error.format() },
        400,
      );
    }

    const { amountUsd, credits, agent_id, success_url, cancel_url } =
      validation.data;
    const amount = amountUsd ?? credits;
    if (amount === undefined) {
      throw ValidationError("amountUsd is required");
    }
    const user = await resolveCreditUser(c, agent_id);
    const stripeCurrency = (
      (c.env.STRIPE_CURRENCY as string | undefined) || "usd"
    ).toLowerCase();
    if (stripeCurrency !== "usd") {
      throw ValidationError("Credit checkout only supports USD");
    }
    const clientRequestKey = c.req.header("Idempotency-Key")?.trim();
    if (!clientRequestKey) {
      throw ValidationError("Idempotency-Key header is required");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(clientRequestKey)) {
      throw ValidationError("Idempotency-Key header is invalid");
    }
    const allowedRedirectOrigins = getDefaultPlatformRedirectOrigins();
    const successUrl = assertAllowedAbsoluteRedirectUrl(
      success_url,
      allowedRedirectOrigins,
      "success_url",
    );
    const cancelUrl = assertAllowedAbsoluteRedirectUrl(
      cancel_url,
      allowedRedirectOrigins,
      "cancel_url",
    );

    const organizationId = user.organization_id;

    // stripe v22 re-exports `SessionCreateParams` as a type alias from the
    // Checkout barrel, which strips the nested `LineItem` namespace. Derive
    // the line-item type from the params shape directly.
    type LineItem = NonNullable<
      Stripe.Checkout.SessionCreateParams["line_items"]
    >[number];
    const chargeAmountCents = amount * 100;
    if (!Number.isSafeInteger(chargeAmountCents)) {
      throw ValidationError("Credits must resolve to exact cents");
    }
    const lineItems: LineItem[] = [
      {
        price_data: {
          currency: stripeCurrency,
          product_data: {
            name: "Account Balance Top-up",
            description: `Add $${amount.toFixed(2)} to your account balance`,
          },
          unit_amount: chargeAmountCents,
        },
        quantity: 1,
      },
    ];

    const orgFull = (user.organization ?? {}) as {
      stripe_customer_id?: string | null;
      name?: string;
      billing_email?: string | null;
    };
    let customerId = orgFull.stripe_customer_id ?? null;

    successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");

    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          agentId: agent_id ?? null,
          cancelUrl: cancelUrl.toString(),
          chargeAmountCents,
          currency: stripeCurrency,
          successUrl: successUrl.toString(),
        }),
      )
      .digest("hex");
    let order = await stripeCheckoutOrdersService.create({
      organizationId,
      initiatedByUserId: user.id,
      clientRequestKey,
      requestDigest,
      purchaseType: "custom_amount",
      creditsToGrant: amount.toFixed(6),
      chargeAmountCents,
      currency: stripeCurrency,
      stripeCustomerId: null,
      metadata: agent_id ? { agent_id } : {},
    });
    const authoritativeCustomerId = await stripeCustomerAuthorityService.ensure(
      {
        organizationId,
        callerIntent: "credit_checkout",
      },
    );
    if (!order.stripe_customer_id) {
      order = await stripeCheckoutOrdersService.bindCustomer(
        order.id,
        authoritativeCustomerId,
      );
    } else if (order.stripe_customer_id !== authoritativeCustomerId) {
      throw new Error(
        "Checkout order customer conflicts with Stripe customer authority",
      );
    }
    customerId = order.stripe_customer_id;
    if (!customerId)
      throw new Error("Stripe customer authority was not established");
    if (order.status === "delivered" || order.status === "settled") {
      if (!order.stripe_checkout_session_id) {
        throw new Error("Delivered checkout order has no Stripe Session");
      }
      const existing = await requireStripe().checkout.sessions.retrieve(
        order.stripe_checkout_session_id,
      );
      return c.json({ url: existing.url, sessionId: existing.id });
    }
    if (
      order.status === "provider_started" ||
      order.status === "provider_ambiguous"
    ) {
      const recovered = await findCheckoutSessionForOrder(
        requireStripe(),
        order,
      );
      if (recovered) {
        await stripeCheckoutOrdersService.bindSession(order.id, recovered.id);
        return c.json({ url: recovered.url, sessionId: recovered.id });
      }
      if (Date.now() - order.updated_at.getTime() >= 23 * 60 * 60 * 1000) {
        throw new Error(
          "Stripe Checkout creation is ambiguous and requires reconciliation",
        );
      }
    }
    await stripeCheckoutOrdersService.markProviderStarted(order.id);

    let session: Stripe.Checkout.Session;
    try {
      session = await requireStripe().checkout.sessions.create(
        {
          customer: customerId,
          client_reference_id: order.id,
          payment_method_types: ["card"],
          line_items: lineItems,
          mode: "payment",
          success_url: successUrl.toString(),
          cancel_url: cancelUrl.toString(),
          metadata: {
            checkout_order_id: order.id,
            ...(agent_id ? { agent_id } : {}),
          },
        },
        { idempotencyKey: `checkout-order:${order.id}` },
      );
      await stripeCheckoutOrdersService.bindSession(order.id, session.id);
    } catch (error) {
      // error-policy:J1 Route boundary durably records an ambiguous provider outcome before translating it.
      await stripeCheckoutOrdersService.markProviderAmbiguous(
        order.id,
        error instanceof Error ? error.name : "unknown_error",
      );
      throw error;
    }

    logger.info("Created credits checkout session", {
      sessionId: session.id,
      organizationId,
      userId: user.id,
      amount,
    });

    return c.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    // error-policy:J1 HTTP boundary translates checkout failures into explicit client or server responses.
    const errorMessage = error instanceof Error ? error.message : "";
    if (
      errorMessage.includes("Invalid success_url") ||
      errorMessage.includes("Invalid cancel_url")
    ) {
      return c.json({ error: errorMessage }, 400);
    }
    logger.error("[Credits Checkout API v1] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;

async function findCheckoutSessionForOrder(
  stripe: Stripe,
  order: { id: string; stripe_customer_id: string | null; updated_at: Date },
): Promise<Stripe.Checkout.Session | null> {
  if (!order.stripe_customer_id) {
    throw new Error("Checkout order has no pinned Stripe customer");
  }
  const providerAttemptSeconds = Math.floor(order.updated_at.getTime() / 1000);
  let startingAfter: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const sessions = await stripe.checkout.sessions.list({
      customer: order.stripe_customer_id,
      created: {
        gte: Math.max(0, providerAttemptSeconds - 3600),
        lte: providerAttemptSeconds + 3600,
      },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const match = sessions.data.find(
      (session) =>
        session.client_reference_id === order.id &&
        session.metadata?.checkout_order_id === order.id,
    );
    if (match) return match;
    if (!sessions.has_more) return null;
    if (sessions.data.length === 0) {
      throw new Error(
        "Stripe Checkout reconciliation returned an empty continuation page",
      );
    }
    const nextCursor = sessions.data.at(-1)?.id;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error(
        "Stripe Checkout reconciliation returned invalid pagination",
      );
    }
    seenCursors.add(nextCursor);
    startingAfter = nextCursor;
  }
}

async function resolveCreditUser(
  c: Parameters<typeof requireUserOrApiKeyWithOrg>[0],
  agentId?: string,
): ReturnType<typeof requireUserOrApiKeyWithOrg> {
  if (!agentId) return requireUserOrApiKeyWithOrg(c);
  // Attributing a checkout to an ARBITRARY agent's owner/org from a
  // caller-supplied agent_id is a service-to-service capability. Require the
  // service key — `validateServiceKey` returned null (not throw) on a
  // missing/invalid key and the result was discarded, letting any authenticated
  // caller mint a Stripe customer/session against, and write stripe_customer_id
  // onto, a sibling org's row. `requireServiceKey` throws instead.
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
