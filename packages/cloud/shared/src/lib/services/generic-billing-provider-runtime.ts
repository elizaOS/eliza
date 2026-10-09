/** Composes merchant-scoped provider access from persisted catalog identity and durable object bindings. */
import { and, eq } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { appBillingProviderBindings } from "../../db/repositories/app-billing-provider-bindings";
import { appBillingConflict } from "../../db/repositories/app-subscription-authority";
import { type AppBillingPlanRevision, billingMerchants } from "../../db/schemas/app-billing";
import { createGenericBillingProvider } from "./generic-billing-provider";
import type { BillingProviderPlan } from "./generic-billing-provider-types";
import { appBillingProviderMerchant, getAppBillingStripe } from "./generic-billing-runtime-config";

type Provider = ReturnType<typeof createGenericBillingProvider>;

export function appBillingProviderPlan(plan: AppBillingPlanRevision): BillingProviderPlan {
  if (plan.trial_days !== 7) appBillingConflict("Registered plan must retain the seven-day trial");
  return {
    planRevisionId: plan.id,
    priceId: plan.stripe_price_id,
    productId: plan.stripe_product_id,
    amountCents: plan.amount_cents,
    currency: plan.currency,
    interval: plan.interval,
    intervalCount: plan.interval_count,
    minimumQuantity: plan.minimum_quantity,
    maximumQuantity: plan.maximum_quantity,
    trialDays: 7,
  };
}

export async function getAppBillingProvider(
  merchantId: string,
  livemode: boolean,
): Promise<Provider> {
  const [merchant] = await dbWrite
    .select()
    .from(billingMerchants)
    .where(and(eq(billingMerchants.id, merchantId), eq(billingMerchants.livemode, livemode)));
  if (!merchant) appBillingConflict("Registered billing merchant is unavailable");
  return createGenericBillingProvider(
    await getAppBillingStripe(livemode),
    appBillingProviderMerchant(merchant),
    appBillingProviderBindings,
  );
}
