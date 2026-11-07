/** Upgrade-specific boundary over shared immutable organization plan quotes. */
import {
  type OrganizationUpgradeReview,
  organizationUpgradeReviewSchema,
} from "../../lib/services/organization-plan-change-contract";
import type { OrganizationUpgradeProviderBinding } from "../../lib/services/organization-upgrade-provider-binding";
import type { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import type { readOrganizationPlanChangeSource } from "./organization-plan-change";
import {
  assertCurrentOrganizationPlanChangeQuote,
  readOrganizationPlanChangeQuote,
  saveOrganizationPlanChangeQuote,
} from "./organization-plan-change-quotes";
import type { OrganizationSubscriptionSourceInput } from "./organization-subscription-manager";

type CapturedSource = Awaited<ReturnType<typeof readOrganizationPlanChangeSource>>;
/** Internal service input; never accept provider terms or authority from a renderer. */
export async function saveOrganizationUpgradeQuote(input: {
  identity: OrganizationSubscriptionSourceInput;
  captured: CapturedSource;
  review: OrganizationUpgradeReview;
  providerBinding: OrganizationUpgradeProviderBinding;
}) {
  const quote = await saveOrganizationPlanChangeQuote({
    ...input,
    review: organizationUpgradeReviewSchema.parse(input.review),
  });
  return { ...quote, review: organizationUpgradeReviewSchema.parse(quote.review) };
}

/** Requires current manager authority and exact actor; a quote ID grants no access. */
export async function readOrganizationUpgradeQuote(
  identity: OrganizationSubscriptionSourceInput,
  quoteId: string,
) {
  const quote = await readOrganizationPlanChangeQuote(identity, quoteId, "upgrade_estimate");
  return { ...quote, review: organizationUpgradeReviewSchema.parse(quote.review) };
}
/** Called only while holding primary organization authority inside the caller transaction. */
export function assertCurrentOrganizationUpgradeQuote(
  quote: typeof organizationPlanChangeQuotes.$inferSelect,
  current: CapturedSource,
  now: Date,
): asserts quote is typeof organizationPlanChangeQuotes.$inferSelect & {
  review: OrganizationUpgradeReview;
} {
  assertCurrentOrganizationPlanChangeQuote(quote, current, now, "upgrade_estimate");
}
