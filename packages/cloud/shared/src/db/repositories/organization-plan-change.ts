/** Captures primary authority for a read-only organization plan-change quote.
 * This is not command admission, provider mutation or allowance publication.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
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
  return writeTransaction((tx) => lockOrganizationPlanChangeSource(tx, input));
}

export async function lockOrganizationPlanChangeSource(
  tx: DbTransaction,
  input: OrganizationSubscriptionSourceInput,
  originalCommandId?: string,
) {
  const locked = await lockOrganizationSubscriptionManager(tx, input, reject);
  const source = await lockCurrentOrganizationSubscription(tx, input, locked, reject);
  if (source.cancel_at_period_end) reject("scheduled_cancellation_requires_resolution");
  // A revoked original actor cannot claim its expired command. Current manager
  // authority may retire only provably unstarted intents without a live lease;
  // started effects keep blocking admission until their outcome is reconciled.
  await tx
    .update(billingSubscriptionCommands)
    .set({
      status: sql`CASE WHEN ${billingSubscriptionCommands.status} = 'PREPARED' THEN 'SUPERSEDED' ELSE 'FAILED' END`,
      error_code: sql`CASE WHEN ${billingSubscriptionCommands.kind} = 'upgrade' THEN 'UPGRADE_REVIEW_EXPIRED_BEFORE_DISPATCH' ELSE 'DOWNGRADE_REVIEW_EXPIRED_BEFORE_DISPATCH' END`,
      completed_at: sql`clock_timestamp()`,
      updated_at: sql`clock_timestamp()`,
      state_revision: sql`${billingSubscriptionCommands.state_revision} + 1`,
      lease_token: null,
      lease_expires_at: null,
    })
    .where(
      and(
        eq(billingSubscriptionCommands.organization_id, input.organizationId),
        isNull(billingSubscriptionCommands.app_id),
        isNull(billingSubscriptionCommands.billing_scope_id),
        or(
          and(
            eq(billingSubscriptionCommands.kind, "upgrade"),
            eq(billingSubscriptionCommands.organization_upgrade_dispatch_state, "ready"),
          ),
          and(
            eq(billingSubscriptionCommands.kind, "downgrade"),
            eq(billingSubscriptionCommands.status, "PREPARED"),
            eq(billingSubscriptionCommands.execution_generation, 0),
            isNull(billingSubscriptionCommands.provider_started_at),
          ),
        ),
        inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN"]),
        or(
          isNull(billingSubscriptionCommands.lease_expires_at),
          lte(billingSubscriptionCommands.lease_expires_at, sql`clock_timestamp()`),
        ),
        originalCommandId ? ne(billingSubscriptionCommands.id, originalCommandId) : undefined,
        sql`EXISTS (SELECT 1 FROM ${organizationPlanChangeQuotes}
          WHERE ${organizationPlanChangeQuotes.consumed_by_command_id} = ${billingSubscriptionCommands.id}
          AND ${organizationPlanChangeQuotes.organization_id} = ${billingSubscriptionCommands.organization_id}
          AND ${organizationPlanChangeQuotes.expires_at} <= clock_timestamp())`,
      ),
    );
  const [pending] = await tx
    .select({ id: billingSubscriptionCommands.id })
    .from(billingSubscriptionCommands)
    .where(
      and(
        isNull(billingSubscriptionCommands.billing_scope_id),
        isNull(billingSubscriptionCommands.app_id),
        eq(billingSubscriptionCommands.organization_id, input.organizationId),
        inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
        originalCommandId ? ne(billingSubscriptionCommands.id, originalCommandId) : undefined,
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
}
