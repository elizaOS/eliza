import Stripe from "stripe";
import { readEnv } from "@/lib/env";

let stripe: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (stripe) return stripe;
  const key = readEnv("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe secret key is missing.");
  stripe = new Stripe(key);
  return stripe;
}

export function getStripeWebhookSecret(): string {
  const secret = readEnv("STRIPE_WEBHOOK_SECRET");
  if (!secret) throw new Error("Stripe webhook secret is missing.");
  return secret;
}
