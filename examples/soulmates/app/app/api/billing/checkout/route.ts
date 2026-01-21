import {
  badRequest,
  forbidden,
  ok,
  parseBody,
  serverError,
  unauthorized,
} from "@/lib/api-utils";
import { getCreditPack } from "@/lib/credits";
import { generateRequestId, logger } from "@/lib/logger";
import { requireSessionUser } from "@/lib/session";
import { getStripeClient } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const reqId = generateRequestId();
  const user = await requireSessionUser();

  if (!user) {
    logger.warn("Checkout unauthorized", {}, reqId);
    return unauthorized();
  }

  if (user.status !== "active") {
    logger.warn(
      "Checkout forbidden - user not active",
      { userId: user.id, status: user.status },
      reqId,
    );
    return forbidden();
  }

  const body = await parseBody<{ packId?: string }>(request);
  const pack = getCreditPack(body?.packId ?? "");
  if (!pack) {
    logger.warn("Checkout invalid pack", { packId: body?.packId }, reqId);
    return badRequest("Choose a credit pack.");
  }

  try {
    const stripe = getStripeClient();
    const origin = request.headers.get("origin") ?? "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pack.amount,
            product_data: {
              name: `Soulmates credits (${pack.credits})`,
              description: pack.description,
            },
          },
        },
      ],
      success_url: `${origin}/app/billing?success=1`,
      cancel_url: `${origin}/app/billing?canceled=1`,
      customer_email: user.email ?? undefined,
      metadata: {
        userId: user.id,
        credits: String(pack.credits),
        packId: pack.id,
      },
    });

    if (!session.url) {
      logger.error(
        "Checkout session created without URL",
        { sessionId: session.id },
        reqId,
      );
      return serverError("Unable to create checkout session.");
    }

    logger.info(
      "Checkout session created",
      { userId: user.id, packId: pack.id, sessionId: session.id },
      reqId,
    );
    return ok({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe error.";
    logger.error("Checkout failed", { userId: user.id, error: message }, reqId);
    return serverError(message);
  }
}
