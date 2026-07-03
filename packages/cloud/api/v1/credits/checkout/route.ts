/**
 * POST /api/v1/credits/checkout
 * Create a Stripe checkout session for purchasing organization credits.
 */

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
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  assertAllowedAbsoluteRedirectUrl,
  getDefaultPlatformRedirectOrigins,
} from "@/lib/security/redirect-validation";
import { organizationsService } from "@/lib/services/organizations";
import { usersService } from "@/lib/services/users";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CheckoutSchema = z.object({
  credits: z.number().min(1).max(1000),
  agent_id: z.string().uuid().optional(),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const validation = CheckoutSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: "Invalid request", details: validation.error.format() },
        400,
      );
    }

    const {
      credits: amount,
      agent_id,
      success_url,
      cancel_url,
    } = validation.data;
    const user = await resolveCreditUser(c, agent_id);
    const stripeCurrency =
      (c.env.STRIPE_CURRENCY as string | undefined) || "usd";
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
    const lineItems: LineItem[] = [
      {
        price_data: {
          currency: stripeCurrency,
          product_data: {
            name: "Account Balance Top-up",
            description: `Add $${amount.toFixed(2)} to your account balance`,
          },
          unit_amount: Math.round(amount * 100),
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

    if (!customerId) {
      const customerData: Stripe.CustomerCreateParams = {
        name: orgFull.name,
        metadata: { organization_id: organizationId },
      };
      const email = orgFull.billing_email || user.email;
      if (email) customerData.email = email;
      if (user.wallet_address) {
        customerData.metadata = {
          ...customerData.metadata,
          wallet_address: user.wallet_address,
        };
      }
      const customer = await requireStripe().customers.create(customerData);
      customerId = customer.id;
      await organizationsService.update(organizationId, {
        stripe_customer_id: customerId,
        updated_at: new Date(),
      });
    }

    successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");

    const session = await requireStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      metadata: {
        organization_id: organizationId,
        user_id: user.id,
        credits: amount.toFixed(2),
        type: "custom_amount",
        ...(agent_id ? { agent_id } : {}),
      },
    });

    logger.info("Created credits checkout session", {
      sessionId: session.id,
      organizationId,
      userId: user.id,
      amount,
    });

    return c.json({ url: session.url, sessionId: session.id });
  } catch (error) {
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
