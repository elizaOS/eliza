/** Downgrade-specific boundary over the same immutable organization quote store. */
import {
  type OrganizationDowngradeReview,
  organizationDowngradeReviewSchema,
} from "../../lib/services/organization-downgrade-review";
import type { OrganizationPlanChangeProviderBinding } from "../../lib/services/organization-plan-change-provider-binding";
import type { OrganizationScheduleQuoteTerms } from "../../lib/services/organization-schedule-quote-terms";
import type { readOrganizationPlanChangeSource } from "./organization-plan-change";
import {
  readOrganizationPlanChangeQuote,
  saveOrganizationPlanChangeQuote,
} from "./organization-plan-change-quotes";
import type { OrganizationSubscriptionSourceInput } from "./organization-subscription-manager";
export async function saveOrganizationDowngradeQuote(input: {
  identity: OrganizationSubscriptionSourceInput;
  captured: Awaited<ReturnType<typeof readOrganizationPlanChangeSource>>;
  review: OrganizationDowngradeReview;
  providerBinding: OrganizationPlanChangeProviderBinding;
  retainedTerms: OrganizationScheduleQuoteTerms;
}) {
  const quote = await saveOrganizationPlanChangeQuote({
    ...input,
    review: organizationDowngradeReviewSchema.parse(input.review),
  });
  return { ...quote, review: organizationDowngradeReviewSchema.parse(quote.review) };
}
export async function readOrganizationDowngradeQuote(
  identity: OrganizationSubscriptionSourceInput,
  quoteId: string,
) {
  const quote = await readOrganizationPlanChangeQuote(identity, quoteId, "downgrade_estimate");
  return { ...quote, review: organizationDowngradeReviewSchema.parse(quote.review) };
}
