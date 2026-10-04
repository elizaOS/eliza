/** Captures primary authority for a read-only organization plan-change quote.
 * This is not command admission, provider mutation or allowance publication.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { writeTransaction } from "../helpers";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import {
  lockCurrentOrganizationSubscription,
  lockOrganizationSubscriptionManager,
  type OrganizationSubscriptionSourceInput,
} from "./organization-subscription-manager";

function reject(reason: string): never {
  throw new ElizaError("Organization plan change requires a fresh eligible subscription", {
    code:
      reason === "current_manager_required" || reason === "organization_authority_unavailable"
        ? "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN"
        : "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    context: { reason },
  });
}

export async function readOrganizationPlanChangeSource(input: OrganizationSubscriptionSourceInput) {
  return writeTransaction(async (tx) => {
    const locked = await lockOrganizationSubscriptionManager(tx, input, reject);
    const source = await lockCurrentOrganizationSubscription(tx, input, locked, reject);
    if (source.cancel_at_period_end) reject("scheduled_cancellation_requires_resolution");
    const [pending] = await tx
      .select({ id: billingSubscriptionCommands.id })
      .from(billingSubscriptionCommands)
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
        ),
      )
      .limit(1);
    if (pending) reject("contradictory_command_pending");
    const [projection] = await tx
      .select()
      .from(organizationEntitlements)
      .where(
        and(
          isNull(organizationEntitlements.billing_scope_id),
          eq(organizationEntitlements.organization_id, input.organizationId),
        ),
      );
    if (
      !projection ||
      projection.source_subscription_id !== source.id ||
      projection.source_subscription_revision !== source.lifecycle_revision
    )
      reject("projection_unavailable");
    return { source, organizationCustomerId: locked.organization.customer };
  });
}
