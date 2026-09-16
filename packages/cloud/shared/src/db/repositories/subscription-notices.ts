/** Enqueues cancellation notice intent inside the caller's canonical lifecycle transaction without authorizing any external submission. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import type { BillingSubscription } from "../schemas/billing-subscriptions";
import { billingSubscriptionRevisions } from "../schemas/billing-subscriptions";
import { subscriptionNoticeIntents as intents } from "../schemas/subscription-notices";
export async function enqueueCanceledNoticeInTransaction(
  tx: DbTransaction,
  source: BillingSubscription,
): Promise<void> {
  if (source.status !== "canceled") return;
  const [revision] = await tx
    .select({ status: billingSubscriptionRevisions.status })
    .from(billingSubscriptionRevisions)
    .where(
      and(
        eq(billingSubscriptionRevisions.organization_id, source.organization_id),
        eq(billingSubscriptionRevisions.subscription_id, source.id),
        eq(billingSubscriptionRevisions.revision, source.lifecycle_revision),
      ),
    );
  if (revision?.status !== "canceled")
    throw new ElizaError("Notice requires canonical canceled revision", {
      code: "SUBSCRIPTION_NOTICE_SOURCE_INVALID",
    });
  await tx
    .insert(intents)
    .values({
      organization_id: source.organization_id,
      subscription_id: source.id,
      source_revision: source.lifecycle_revision,
    })
    .onConflictDoNothing();
}
