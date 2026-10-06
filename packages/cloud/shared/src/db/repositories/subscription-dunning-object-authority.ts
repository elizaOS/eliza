/** Rechecks retained catalog, pending lineage and failed invoice objects under the caller's organization lock. */

import { eq } from "drizzle-orm";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";
import { validateScheduledDunningObjects } from "../../lib/services/organization-schedule-dunning-observation";
import { validateHistoricalDunningObjects } from "../../lib/services/stripe-renewal-dunning-observation";
import { assertCheckoutProviderAuthority } from "../../lib/services/subscription-checkout-contract";
import type { DbTransaction } from "../client";
import type { BillingSubscription } from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import {
  proveScheduledRenewalTarget,
  readOriginalScheduledRenewalAuthority,
} from "./organization-schedule-renewal-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { type DunningObservation, dunningUnavailable } from "./subscription-dunning-finalization";
import { findSubscriptionRenewalBinding } from "./subscription-purchased-binding";

export async function verifyDunningObjectsInTransaction(
  tx: DbTransaction,
  source: BillingSubscription,
  observation: DunningObservation,
) {
  if (source.pending_plan_key === null) {
    if (observation.scheduledObjects) dunningUnavailable("scheduled_source_changed");
    if (!observation.historicalObjects) return null;
    const configured = getCloudAwareEnv();
    const { contract, environment } = await findSubscriptionRenewalBinding(source, configured, tx);
    if (contract) {
      const account = observation.historicalObjects.providerAccountId;
      if (!account) dunningUnavailable("historical_dunning_account_missing");
      assertCheckoutProviderAuthority(contract, account, configured);
    }
    const [organization] = await tx
      .select({ customer: organizations.stripe_customer_id })
      .from(organizations)
      .where(eq(organizations.id, source.organization_id));
    const verified = validateHistoricalDunningObjects({
      source,
      objects: observation.historicalObjects,
      environment,
      organizationCustomerId: organization?.customer ?? null,
      observedAt: await readPostLockDatabaseNow(tx),
    });
    if (
      verified.providerStatus !== observation.providerStatus ||
      verified.providerObjectDigest !== observation.providerObjectDigest
    )
      dunningUnavailable("historical_dunning_observation_changed");
    return verified;
  }
  if (observation.historicalObjects) dunningUnavailable("historical_dunning_source_changed");
  const context = await readOriginalScheduledRenewalAuthority(source, tx);
  if (!context || !observation.scheduledObjects)
    dunningUnavailable("original_scheduled_dunning_missing");
  const [organization] = await tx
    .select({ customer: organizations.stripe_customer_id })
    .from(organizations)
    .where(eq(organizations.id, source.organization_id));
  const now = await readPostLockDatabaseNow(tx);
  const authority = proveScheduledRenewalTarget(
    context,
    observation.scheduledObjects.schedule,
    now,
  );
  const verified = validateScheduledDunningObjects({
    source,
    authority,
    objects: observation.scheduledObjects,
    observedAt: now,
    organizationCustomerId: organization?.customer ?? null,
    retainedCanceledAt: source.canceled_at,
  });
  if (
    verified.providerStatus !== observation.providerStatus ||
    verified.providerObjectDigest !== observation.providerObjectDigest
  )
    dunningUnavailable("scheduled_dunning_observation_changed");
  return verified;
}
