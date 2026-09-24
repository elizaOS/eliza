/** Creates and recovers merchant/catalog objects under durable app-owner intents through the existing Stripe adapter. */

import type { CreateAppBillingPlanRequest } from "@elizaos/cloud-sdk/app-billing-admin";
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { z } from "zod";
import { createGenericBillingProvider } from "./generic-billing-provider";
import {
  type BillingProviderMerchant,
  type BillingProviderPlan,
  type DurableProviderIntent,
  GENERIC_BILLING_STRIPE_API_VERSION,
} from "./generic-billing-provider-types";

interface AdminProviderContext {
  appId: string;
  organizationId: string;
  livemode: boolean;
}
function invalid(message: string): never {
  throw new ElizaError(message, { code: "APP_BILLING_ADMIN_PROVIDER_MISMATCH" });
}
const accountSchema = z.object({
  id: z.string().regex(/^acct_[A-Za-z0-9]+$/),
  metadata: z.record(z.string(), z.string()),
});
const priceSchema = z.object({
  id: z.string().regex(/^price_[A-Za-z0-9]+$/),
  product: z.union([z.string(), z.object({ id: z.string() })]),
  livemode: z.boolean(),
  metadata: z.record(z.string(), z.string()),
});
function tags(context: AdminProviderContext, intent: DurableProviderIntent) {
  return {
    eliza_app_id: context.appId,
    eliza_organization_id: context.organizationId,
    eliza_billing_mode: context.livemode ? "live" : "test",
    eliza_command_id: intent.commandId,
    eliza_request_digest: intent.requestDigest,
  };
}
function matches(actual: Record<string, string>, expected: Record<string, string>) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}
export function appPlanProviderBinding(
  id: string,
  input: CreateAppBillingPlanRequest,
  priceId: string,
  productId: string,
): BillingProviderPlan {
  return {
    planRevisionId: id,
    priceId,
    productId,
    amountCents: input.amountCents,
    currency: input.currency,
    interval: input.interval,
    intervalCount: input.intervalCount,
    minimumQuantity: input.seats.minimum,
    maximumQuantity: input.seats.maximum,
    trialDays: 7,
  };
}
export function createGenericBillingAdminProvider(stripe: Stripe, context: AdminProviderContext) {
  const baseOptions = { apiVersion: GENERIC_BILLING_STRIPE_API_VERSION };
  return {
    async findCreatedMerchant(intent: DurableProviderIntent): Promise<string | null> {
      let found: string | null = null;
      for await (const raw of stripe.accounts.list({ limit: 100 }, baseOptions)) {
        const value = accountSchema.parse(raw);
        if (!matches(value.metadata, tags(context, intent))) continue;
        if (found !== null)
          invalid("Multiple Stripe merchants match the same durable app billing intent");
        found = value.id;
      }
      return found;
    },
    async createMerchant(intent: DurableProviderIntent, country: string): Promise<string> {
      const result = accountSchema.parse(
        await stripe.accounts.create(
          {
            type: "express",
            country,
            capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            metadata: tags(context, intent),
          },
          { ...baseOptions, idempotencyKey: intent.idempotencyKey },
        ),
      );
      if (!matches(result.metadata, tags(context, intent)))
        invalid("Created merchant does not retain its app billing intent");
      return result.id;
    },
    async platformAccountId(): Promise<string> {
      return z
        .object({ id: z.string().regex(/^acct_[A-Za-z0-9]+$/) })
        .parse(await stripe.accounts.retrieve(null, {}, baseOptions)).id;
    },
    async onboarding(
      merchant: BillingProviderMerchant,
      intent: DurableProviderIntent,
      input: { returnUrl: string; refreshUrl: string },
    ) {
      const result = z
        .object({ url: z.string().url(), expires_at: z.number().int().positive() })
        .parse(
          await stripe.accountLinks.create(
            {
              account: merchant.stripeAccountId,
              type: "account_onboarding",
              return_url: input.returnUrl,
              refresh_url: input.refreshUrl,
            },
            { ...baseOptions, idempotencyKey: intent.idempotencyKey },
          ),
        );
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.hostname !== "connect.stripe.com")
        invalid("Stripe returned an unexpected merchant onboarding destination");
      return { url: result.url, expiresAt: new Date(result.expires_at * 1000).toISOString() };
    },
    async findCreatedPlan(
      merchant: BillingProviderMerchant,
      intent: DurableProviderIntent,
      planRevisionId: string,
    ): Promise<{ priceId: string; productId: string } | null> {
      let found: { priceId: string; productId: string } | null = null;
      const productId = `prod_eliza${planRevisionId.replaceAll("-", "")}`;
      for await (const raw of stripe.prices.list(
        { product: productId, limit: 100 },
        { ...baseOptions, stripeAccount: merchant.stripeAccountId },
      )) {
        const value = priceSchema.parse(raw);
        if (
          !matches(value.metadata, {
            ...tags(context, intent),
            eliza_plan_revision_id: planRevisionId,
          })
        )
          continue;
        const product = typeof value.product === "string" ? value.product : value.product.id;
        if (value.livemode !== context.livemode || product !== productId || found !== null)
          invalid("Recovered plan has ambiguous provider ownership");
        found = { priceId: value.id, productId };
      }
      return found;
    },
    async createPlan(
      merchant: BillingProviderMerchant,
      intent: DurableProviderIntent,
      planRevisionId: string,
      input: CreateAppBillingPlanRequest,
    ) {
      const metadata = { ...tags(context, intent), eliza_plan_revision_id: planRevisionId };
      const productId = `prod_eliza${planRevisionId.replaceAll("-", "")}`;
      const value = priceSchema.parse(
        await stripe.prices.create(
          {
            currency: input.currency,
            unit_amount: input.amountCents,
            billing_scheme: "per_unit",
            recurring: {
              interval: input.interval,
              interval_count: input.intervalCount,
              usage_type: "licensed",
            },
            product_data: { id: productId, name: input.name, metadata },
            metadata,
          },
          {
            ...baseOptions,
            stripeAccount: merchant.stripeAccountId,
            idempotencyKey: intent.idempotencyKey,
          },
        ),
      );
      if (
        !matches(value.metadata, metadata) ||
        value.livemode !== context.livemode ||
        (typeof value.product === "string" ? value.product : value.product.id) !== productId
      )
        invalid("Created plan does not retain its merchant and app billing intent");
      return createGenericBillingProvider(stripe, merchant).verifyPlan(
        appPlanProviderBinding(planRevisionId, input, value.id, productId),
      );
    },
  };
}
