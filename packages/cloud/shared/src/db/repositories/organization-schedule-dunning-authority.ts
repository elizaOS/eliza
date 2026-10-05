/** Rechecks original pending lineage and current failed target objects under the caller's organization lock. */
import { eq } from "drizzle-orm";
import { validateScheduledDunningObjects } from "../../lib/services/organization-schedule-dunning-observation";
import type { DbTransaction } from "../client";
import type { BillingSubscription } from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import {
  proveScheduledRenewalTarget,
  readOriginalScheduledRenewalAuthority,
} from "./organization-schedule-renewal-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { type DunningObservation, dunningUnavailable } from "./subscription-dunning-finalization";

export async function verifyScheduledDunningInTransaction(
  tx: DbTransaction,
  source: BillingSubscription,
  observation: DunningObservation,
) {
  if (source.pending_plan_key === null) {
    if (observation.scheduledObjects) dunningUnavailable("scheduled_source_changed");
    return null;
  }
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
