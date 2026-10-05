/** Read-only dunning observation using original account/price and pending schedule authority. */
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { dbWrite } from "../../db/helpers";
import {
  proveScheduledRenewalTarget,
  readOriginalScheduledRenewalAuthority,
} from "../../db/repositories/organization-schedule-renewal-authority";
import type { DunningObservation } from "../../db/repositories/subscription-dunning-finalization";
import { findSubscriptionRenewalBinding } from "../../db/repositories/subscription-purchased-binding";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { organizations } from "../../db/schemas/organizations";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { validateScheduledDunningObjects } from "./organization-schedule-dunning-observation";
import { validateStripeDunningObservation } from "./stripe-dunning-lifecycle";
import { assertCheckoutProviderAuthority } from "./subscription-checkout-contract";

export async function retrieveStripeDunningObservation(
  source: BillingSubscription,
  raw: unknown,
  stripe: Stripe,
  observedCustomer?: unknown,
): Promise<DunningObservation> {
  const configured = getCloudAwareEnv();
  const { contract, environment } = await findSubscriptionRenewalBinding(source, configured);
  if (contract)
    assertCheckoutProviderAuthority(
      contract,
      (await stripe.accounts.retrieve(null)).id,
      configured,
    );
  const context = await readOriginalScheduledRenewalAuthority(source);
  if (!context) return validateStripeDunningObservation(raw, source, environment);
  const invoiceId = z
    .object({ latest_invoice: z.string().regex(/^in_[A-Za-z0-9]+$/) })
    .parse(raw).latest_invoice;
  const [schedule, customer, invoice] = await Promise.all([
    stripe.subscriptionSchedules.retrieve(
      context.scheduleId,
      {},
      { apiVersion: context.providerBinding.apiVersion },
    ),
    observedCustomer === undefined
      ? stripe.customers.retrieve(source.stripe_customer_id)
      : Promise.resolve(observedCustomer),
    stripe.invoices.retrieve(invoiceId),
  ]);
  const [organization] = await dbWrite
    .select({ customer: organizations.stripe_customer_id })
    .from(organizations)
    .where(eq(organizations.id, source.organization_id));
  const observedAt = new Date(),
    authority = proveScheduledRenewalTarget(context, schedule, observedAt);
  const scheduledObjects = { schedule, customer, invoice, subscription: raw };
  const value = validateScheduledDunningObjects({
    source,
    authority,
    objects: scheduledObjects,
    observedAt,
    organizationCustomerId: organization?.customer ?? null,
    retainedCanceledAt: source.canceled_at,
  });
  return {
    providerStatus: value.providerStatus,
    providerObjectDigest: value.providerObjectDigest,
    scheduledObjects,
  };
}
