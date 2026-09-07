/** Requires a semantically current immutable source and derived entitlement before acknowledging a lifecycle observation without publication. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  type BillingSubscription,
  billingSubscriptionRevisions,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { deriveSubscriptionEntitlementValues } from "./subscription-entitlements";
import { subscriptionScheduleFields } from "./subscription-schedule-lineage";

function same(a: unknown, b: unknown) {
  return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
}
export async function requireReconciliationProjection(
  tx: DbTransaction,
  source: BillingSubscription,
  expectedProjectionRevision: number | null,
) {
  const [revision] = await tx
    .select()
    .from(billingSubscriptionRevisions)
    .where(
      and(
        eq(billingSubscriptionRevisions.organization_id, source.organization_id),
        eq(billingSubscriptionRevisions.subscription_id, source.id),
        eq(billingSubscriptionRevisions.revision, source.lifecycle_revision),
      ),
    );
  const [projection] = await tx
    .select()
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organization_id, source.organization_id))
    .for("update");
  const fail = (): never => {
    throw new ElizaError(
      "Current subscription projection requires reconciliation before acknowledgment",
      {
        code: "SUBSCRIPTION_RECONCILIATION_PROJECTION_UNAVAILABLE",
        context: { subscriptionId: source.id },
      },
    );
  };
  if (!revision || !projection || projection.projection_revision !== expectedProjectionRevision)
    fail();
  for (const key of [...subscriptionScheduleFields, "provider_object_digest"] as const)
    if (!same(source[key], revision[key])) fail();
  const expected = deriveSubscriptionEntitlementValues(revision);
  for (const key of Object.keys(expected) as Array<keyof typeof expected>)
    if (!same(projection[key], expected[key])) fail();
}
