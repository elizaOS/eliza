/** Saves provider-reviewed plan-change terms after reacquiring primary organization authority. */

import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import {
  type OrganizationDowngradeReview,
  organizationDowngradeReviewSchema,
} from "../../lib/services/organization-downgrade-review";
import {
  type OrganizationUpgradeReview,
  organizationUpgradeReviewSchema,
} from "../../lib/services/organization-plan-change-contract";
import {
  type OrganizationPlanChangeProviderBinding,
  organizationPlanChangeProviderBindingSchema,
} from "../../lib/services/organization-plan-change-provider-binding";
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
  throw new ElizaError("Review a fresh organization plan-change quote before confirming", {
    code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
  });
}

/** Internal service input; never accept provider review or captured authority from a renderer. */
export async function saveOrganizationPlanChangeQuote(input: {
  identity: OrganizationSubscriptionSourceInput;
  captured: CapturedSource;
  review: OrganizationUpgradeReview | OrganizationDowngradeReview;
  providerBinding: OrganizationPlanChangeProviderBinding;
}) {
  const review =
    input.review.kind === "upgrade_estimate"
      ? organizationUpgradeReviewSchema.parse(input.review)
      : organizationDowngradeReviewSchema.parse(input.review);
  const providerBinding = organizationPlanChangeProviderBindingSchema.parse(input.providerBinding);
  return writeTransaction(async (tx) => {
    const current = await lockOrganizationPlanChangeSource(tx, input.identity);
    const now = await readPostLockDatabaseNow(tx);
    const source = current.source;
    assertOrganizationSubscription(source);
    if (providerBinding.livemode !== (source.provider_environment === "live")) conflict();
    const target = resolveSubscriptionPlanDefinition(review.targetPlanKey, review.catalogVersion);
    const previous = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
    const start = source.current_period_start?.getTime();
    const end = source.current_period_end?.getTime();
    if (start === undefined || end === undefined || end <= start) conflict();
    if (review.kind === "upgrade_estimate") {
      const additionalAllowanceUsd = proratedAllowanceIncrease({
        previousUsd: previous.allowance.amountUsd,
        targetUsd: target.allowance.amountUsd,
        periodStartMs: start,
        periodEndMs: end,
        effectiveAtMs: review.prorationDate * 1000,
      });
      if (review.additionalAllowanceUsd !== additionalAllowanceUsd) conflict();
    } else if (
      review.effectiveAt !== source.current_period_end?.toISOString() ||
      review.amountDueNowCents !== 0
    )
      conflict();
    if (
      settlementDigest(current) !== settlementDigest(input.captured) ||
      review.subscriptionId !== source.id ||
      review.expectedSubscriptionRevision !== String(source.lifecycle_revision) ||
      review.sourcePlanKey !== source.plan_key ||
      review.catalogVersion !== source.catalog_version ||
      review.currentPeriodStart !== source.current_period_start?.toISOString() ||
      review.currentPeriodEnd !== source.current_period_end?.toISOString() ||
      (review.kind === "upgrade_estimate"
        ? target.amountCents <= previous.amountCents
        : target.amountCents >= previous.amountCents) ||
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
        provider_binding: providerBinding,
        created_at: now,
        expires_at: new Date(review.expiresAt),
      })
      .returning();
    if (!quote) conflict();
    return { ...quote, review };
  });
}

export async function readOrganizationPlanChangeQuote(
  identity: OrganizationSubscriptionSourceInput,
  quoteId: string,
  expectedKind: "upgrade_estimate" | "downgrade_estimate",
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
    if (!quote) conflict();
    return assertCurrentOrganizationPlanChangeQuote(quote, current, now, expectedKind);
  });
}
export function assertCurrentOrganizationPlanChangeQuote(
  quote: typeof organizationPlanChangeQuotes.$inferSelect,
  current: CapturedSource,
  now: Date,
  expectedKind: "upgrade_estimate" | "downgrade_estimate",
) {
  if (
    quote.review.kind !== expectedKind ||
    quote.subscription_id !== current.source.id ||
    quote.subscription_revision !== current.source.lifecycle_revision ||
    quote.source_digest !== settlementDigest(current) ||
    quote.review_digest !== settlementDigest(quote.review) ||
    quote.expires_at <= now ||
    quote.consumed_by_command_id !== null
  )
    conflict();
  const review =
    expectedKind === "upgrade_estimate"
      ? organizationUpgradeReviewSchema.parse(quote.review)
      : organizationDowngradeReviewSchema.parse(quote.review);
  const binding = organizationPlanChangeProviderBindingSchema.parse(quote.provider_binding);
  if (binding.livemode !== (current.source.provider_environment === "live")) conflict();
  return { ...quote, review };
}
