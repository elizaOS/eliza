/** Saves provider-reviewed upgrade terms after reacquiring primary organization authority. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import {
  type OrganizationUpgradeReview,
  organizationUpgradeReviewSchema,
} from "../../lib/services/organization-plan-change-contract";
import { assertOrganizationSubscription } from "../../lib/services/organization-subscription-source";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { proratedAllowanceIncrease } from "../../lib/services/subscription-allowance-proration";
import { resolveSubscriptionPlanDefinition } from "../../lib/services/subscription-catalog";
import { writeTransaction } from "../helpers";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import {
  lockOrganizationPlanChangeSource,
  type readOrganizationPlanChangeSource,
} from "./organization-plan-change";
import type { OrganizationSubscriptionSourceInput } from "./organization-subscription-manager";
import { readPostLockDatabaseNow } from "./primary-database-clock";

type CapturedSource = Awaited<ReturnType<typeof readOrganizationPlanChangeSource>>;
function conflict(): never {
  throw new ElizaError("Review a fresh organization upgrade quote before confirming", {
    code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
  });
}

/** Internal service input; never accept provider review or captured authority from a renderer. */
export async function saveOrganizationUpgradeQuote(input: {
  identity: OrganizationSubscriptionSourceInput;
  captured: CapturedSource;
  review: OrganizationUpgradeReview;
}) {
  const review = organizationUpgradeReviewSchema.parse(input.review);
  return writeTransaction(async (tx) => {
    const current = await lockOrganizationPlanChangeSource(tx, input.identity);
    const now = await readPostLockDatabaseNow(tx);
    const source = current.source;
    assertOrganizationSubscription(source);
    const target = resolveSubscriptionPlanDefinition(review.targetPlanKey, review.catalogVersion);
    const previous = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
    const start = source.current_period_start?.getTime();
    const end = source.current_period_end?.getTime();
    if (start === undefined || end === undefined || end <= start) conflict();
    const additionalAllowanceUsd = proratedAllowanceIncrease({
      previousUsd: previous.allowance.amountUsd,
      targetUsd: target.allowance.amountUsd,
      periodStartMs: start,
      periodEndMs: end,
      effectiveAtMs: review.prorationDate * 1000,
    });
    if (review.additionalAllowanceUsd !== additionalAllowanceUsd) conflict();
    if (
      settlementDigest(current) !== settlementDigest(input.captured) ||
      review.subscriptionId !== source.id ||
      review.expectedSubscriptionRevision !== String(source.lifecycle_revision) ||
      review.sourcePlanKey !== source.plan_key ||
      review.catalogVersion !== source.catalog_version ||
      review.currentPeriodStart !== source.current_period_start?.toISOString() ||
      review.currentPeriodEnd !== source.current_period_end?.toISOString() ||
      target.amountCents <= previous.amountCents ||
      review.targetBaseAmountCents !== target.amountCents ||
      review.targetAllowanceUsd !== target.allowance.amountUsd ||
      Date.parse(review.expiresAt) <= now.getTime() ||
      Date.parse(review.observedAt) > now.getTime()
    )
      conflict();
    const [quote] = await tx
      .insert(organizationPlanChangeQuotes)
      .values({
        organization_id: input.identity.organizationId,
        actor_id: input.identity.actorId,
        subscription_id: source.id,
        subscription_revision: source.lifecycle_revision,
        target_plan_key: review.targetPlanKey,
        catalog_version: review.catalogVersion,
        source_digest: settlementDigest(current),
        review_digest: settlementDigest(review),
        review,
        created_at: now,
        expires_at: new Date(review.expiresAt),
      })
      .returning();
    if (!quote) conflict();
    return quote;
  });
}

/** Requires current manager authority and exact actor; a quote ID grants no access. */
export async function readOrganizationUpgradeQuote(
  identity: OrganizationSubscriptionSourceInput,
  quoteId: string,
) {
  return writeTransaction(async (tx) => {
    const current = await lockOrganizationPlanChangeSource(tx, identity);
    const [quote] = await tx
      .select()
      .from(organizationPlanChangeQuotes)
      .where(
        and(
          eq(organizationPlanChangeQuotes.id, quoteId),
          eq(organizationPlanChangeQuotes.organization_id, identity.organizationId),
          eq(organizationPlanChangeQuotes.actor_id, identity.actorId),
        ),
      );
    const now = await readPostLockDatabaseNow(tx);
    if (
      !quote ||
      quote.subscription_id !== current.source.id ||
      quote.subscription_revision !== current.source.lifecycle_revision ||
      quote.source_digest !== settlementDigest(current) ||
      quote.review_digest !== settlementDigest(quote.review) ||
      quote.expires_at <= now ||
      quote.consumed_by_command_id !== null
    )
      conflict();
    organizationUpgradeReviewSchema.parse(quote.review);
    return quote;
  });
}
