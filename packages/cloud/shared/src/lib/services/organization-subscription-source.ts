/** Validates that an infrastructure-only path cannot consume an app subscription or catalog. */
import { ElizaError } from "@elizaos/core";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";

type OrganizationSubscription = BillingSubscription & {
  billing_scope_id: null;
  merchant_key: "platform";
  plan_key: "plus_monthly" | "pro_monthly";
  pending_plan_key: "plus_monthly" | "pro_monthly" | null;
  status: Exclude<BillingSubscription["status"], "trialing" | "paused">;
};

export function assertOrganizationSubscription(
  source: BillingSubscription,
): asserts source is OrganizationSubscription {
  if (
    source.billing_scope_id !== null ||
    source.merchant_key !== "platform" ||
    (source.plan_key !== "plus_monthly" && source.plan_key !== "pro_monthly") ||
    (source.pending_plan_key !== null &&
      source.pending_plan_key !== "plus_monthly" &&
      source.pending_plan_key !== "pro_monthly") ||
    source.status === "trialing" ||
    source.status === "paused"
  )
    throw new ElizaError("Subscription is not a supported organization billing source", {
      code: "SUBSCRIPTION_ORGANIZATION_SOURCE_UNAVAILABLE",
    });
}
