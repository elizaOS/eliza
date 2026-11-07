/** Read-only provider review for a lower organization plan at the current period boundary. */
import { ElizaError } from "@elizaos/core";
import { saveOrganizationDowngradeQuote } from "../../db/repositories/organization-downgrade-quotes";
import { readOrganizationPlanChangeSource } from "../../db/repositories/organization-plan-change";
import type { OrganizationSubscriptionSourceInput } from "../../db/repositories/organization-subscription-manager";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { GENERIC_BILLING_STRIPE_API_VERSION } from "./generic-billing-provider-types";
import { projectOrganizationDowngradeReview } from "./organization-downgrade-review";
import {
  assertOrganizationPlanChangeProviderBindingCurrent,
  resolveOrganizationPlanChangeProviderBinding,
} from "./organization-plan-change-provider-binding";
import { captureOrganizationScheduleQuoteTerms } from "./organization-schedule-quote-terms";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

function reject(reason: string): never {
  throw new ElizaError("Organization downgrade requires a fresh complete provider review", {
    code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    context: { reason },
  });
}
/** Identity is authenticated server context. Only a catalog plan key comes from the caller. */
export async function createOrganizationDowngradeQuote(
  input: OrganizationSubscriptionSourceInput & { targetPlanKey: "plus_monthly" | "pro_monthly" },
  revalidateSession: () => Promise<void>,
) {
  await revalidateSession();
  const captured = await readOrganizationPlanChangeSource(input);
  const source = captured.source;
  assertOrganizationSubscription(source);
  const target = resolveSubscriptionPlanDefinition(input.targetPlanKey, source.catalog_version);
  if (
    target.amountCents >=
    resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version).amountCents
  )
    reject("downgrade_target_required");
  const stripe = requireStripe(),
    environment = getCloudAwareEnv();
  const providerBinding = resolveOrganizationPlanChangeProviderBinding(
    source,
    target.key,
    environment,
  );
  await getVerifiedSubscriptionPlans({
    env: environment,
    provider: adaptStripeSubscriptionCatalogProvider(stripe),
  });
  const options = { apiVersion: GENERIC_BILLING_STRIPE_API_VERSION };
  const rawCustomer = await stripe.customers.retrieve(
    source.stripe_customer_id,
    { expand: ["tax_ids"] },
    options,
  );
  validateCancellationCustomer({
    ...captured,
    environment,
    raw: rawCustomer,
  });
  const rawSubscription = await stripe.subscriptions.retrieve(
    source.stripe_subscription_id,
    {},
    options,
  );
  const observedAt = new Date();
  validatePeriodEndCancellationObservation({
    ...captured,
    environment,
    raw: rawSubscription,
    observedAt,
    requireScheduled: false,
    allowRetainedCanceledAt: source.canceled_at,
  });
  const retainedTerms = captureOrganizationScheduleQuoteTerms({
    rawSubscription,
    rawCustomer,
    observedAt,
  });
  const binding = resolveSubscriptionProviderBinding(
    environment,
    target.key,
    source.catalog_version,
  );
  const items = [{ id: source.stripe_subscription_item_id, price: binding.priceId, quantity: 1 }];
  const recurring = await stripe.invoices.createPreview(
    {
      customer: source.stripe_customer_id,
      subscription: source.stripe_subscription_id,
      preview_mode: "recurring",
      subscription_details: { items },
    },
    options,
  );
  const review = projectOrganizationDowngradeReview({
    source,
    targetPlanKey: target.key,
    environment,
    observedAt,
    recurring,
  });
  await revalidateSession();
  assertOrganizationPlanChangeProviderBindingCurrent(
    providerBinding,
    source,
    target.key,
    getCloudAwareEnv(),
  );
  return saveOrganizationDowngradeQuote({
    identity: input,
    captured,
    review,
    providerBinding,
    retainedTerms,
  });
}
