import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { generateRequestId, logger } from "@/lib/logger";
import { addCredits } from "@/lib/store";
import { getStripeClient, getStripeWebhookSecret } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const reqId = generateRequestId();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    logger.warn("Webhook missing signature", {}, reqId);
    return NextResponse.json(
      { ok: false, error: "Missing Stripe signature." },
      { status: 400 },
    );
  }

  let event: Stripe.Event;
  try {
    const payload = await request.text();
    event = getStripeClient().webhooks.constructEvent(
      payload,
      signature,
      getStripeWebhookSecret(),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid Stripe webhook.";
    logger.error("Webhook verification failed", { error: message }, reqId);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  logger.info(
    "Webhook received",
    { type: event.type, eventId: event.id },
    reqId,
  );

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const { userId = "", credits: creditStr = "" } = session.metadata ?? {};
    const credits = Number.parseInt(creditStr, 10);

    if (userId && Number.isFinite(credits) && credits > 0) {
      const reference =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : null;
      await addCredits(userId, credits, "topup", reference);
      logger.info(
        "Credits added via webhook",
        { userId, credits, reference },
        reqId,
      );
    } else {
      logger.warn(
        "Webhook missing valid metadata",
        { userId, credits: creditStr },
        reqId,
      );
    }
  }

  return NextResponse.json({ ok: true });
}
