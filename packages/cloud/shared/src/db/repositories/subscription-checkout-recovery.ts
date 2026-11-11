/**
 * Read-only primary queries for organization Plus/Pro checkout recovery and Customer Portal
 * admission. Every query is restricted to organization-level rows (no app billing scope).
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { dbWrite } from "../helpers";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import {
  type BillingSubscriptionCommand,
  billingSubscriptionCommands,
} from "../schemas/subscription-billing-operations";

/** Statuses that still carry organization subscription authority (mirrors checkout admission). */
export const LIVE_ORGANIZATION_SUBSCRIPTION_STATUSES = [
  "pending",
  "incomplete",
  "active",
  "grace",
  "past_due",
  "unpaid",
] as const;

export interface SubscriptionPortalAuthority {
  customerId: string;
  subscriptionId: string;
  subscriptionStatus: string;
}

export class SubscriptionCheckoutRecoveryRepository {
  /** True only when the checkout's published subscription still carries live organization authority. */
  async isLiveOrganizationSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<boolean> {
    const [row] = await dbWrite
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.organization_id, organizationId),
          isNull(billingSubscriptions.billing_scope_id),
          eq(billingSubscriptions.id, subscriptionId),
          inArray(billingSubscriptions.status, [...LIVE_ORGANIZATION_SUBSCRIPTION_STATUSES]),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Every org-level checkout that may still hold a payable provider session. */
  async listPendingCheckoutsForOrganization(
    organizationId: string,
  ): Promise<BillingSubscriptionCommand[]> {
    return dbWrite
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, organizationId),
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.kind, "checkout"),
          inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN"]),
        ),
      )
      .orderBy(asc(billingSubscriptionCommands.created_at));
  }

  /**
   * Pending org-level checkouts old enough to be at (or near) provider expiry, or whose organization
   * can no longer receive paid authority. The caller confirms each one with the provider.
   */
  async listStalePendingCheckouts(
    createdBefore: Date,
    limit: number,
  ): Promise<Array<{ command: BillingSubscriptionCommand; organizationFenced: boolean }>> {
    return dbWrite
      .select({
        command: billingSubscriptionCommands,
        organizationFenced: sql<boolean>`(${organizations.paid_work_fenced_at} IS NOT NULL OR ${organizations.account_deletion_request_id} IS NOT NULL OR NOT ${organizations.is_active} OR ${organizations.account_lifecycle_state} <> 'active')`,
      })
      .from(billingSubscriptionCommands)
      .innerJoin(organizations, eq(organizations.id, billingSubscriptionCommands.organization_id))
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.kind, "checkout"),
          inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN"]),
          or(
            lte(billingSubscriptionCommands.created_at, createdBefore),
            isNotNull(organizations.paid_work_fenced_at),
            isNotNull(organizations.account_deletion_request_id),
            eq(organizations.is_active, false),
          ),
        ),
      )
      .orderBy(asc(billingSubscriptionCommands.updated_at))
      .limit(limit);
  }

  /**
   * Dispatched org-level checkouts of unfenced organizations, inside the provider retry horizon,
   * that are due for a read-back so a paid session is settled without its webhook. Fenced and
   * past-horizon checkouts belong to `listStalePendingCheckouts` and never appear here.
   *
   * `rotateCheckoutRecovery` stamps `updated_at` at each inspection, so the wait before the next
   * one is the checkout's age at its last inspection, clamped to [minAge, maxBackoff]: a checkout
   * is read at about 2, 4, 8, 16… minutes after dispatch, then every `maxBackoff`. An abandoned
   * open checkout therefore costs a bounded number of provider reads over its lifetime.
   */
  async listDispatchedCheckoutsDueForInspection(input: {
    now: Date;
    createdAfter: Date;
    minAgeMs: number;
    maxBackoffMs: number;
    limit: number;
  }): Promise<BillingSubscriptionCommand[]> {
    const minAge = sql`make_interval(secs => ${input.minAgeMs / 1000})`;
    const maxBackoff = sql`make_interval(secs => ${input.maxBackoffMs / 1000})`;
    const now = sql`${input.now.toISOString()}::timestamptz`;
    const rows = await dbWrite
      .select({ command: billingSubscriptionCommands })
      .from(billingSubscriptionCommands)
      .innerJoin(organizations, eq(organizations.id, billingSubscriptionCommands.organization_id))
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.kind, "checkout"),
          eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"),
          gt(billingSubscriptionCommands.created_at, input.createdAfter),
          isNull(organizations.paid_work_fenced_at),
          isNull(organizations.account_deletion_request_id),
          eq(organizations.is_active, true),
          sql`${billingSubscriptionCommands.provider_started_at} + ${minAge} <= ${now}`,
          sql`${billingSubscriptionCommands.updated_at} + GREATEST(${minAge}, LEAST(${maxBackoff}, ${billingSubscriptionCommands.updated_at} - ${billingSubscriptionCommands.provider_started_at})) <= ${now}`,
        ),
      )
      .orderBy(asc(billingSubscriptionCommands.updated_at))
      .limit(input.limit);
    return rows.map((row) => row.command);
  }

  /**
   * Rotates an inspected-but-unsettled checkout behind its peers so one unrecoverable command
   * cannot starve recovery. Only the inspection timestamp changes; state CAS fields are untouched.
   */
  async rotateCheckoutRecovery(
    command: Pick<BillingSubscriptionCommand, "id" | "organization_id" | "status">,
  ): Promise<void> {
    await dbWrite
      .update(billingSubscriptionCommands)
      .set({ updated_at: sql`clock_timestamp()` })
      .where(
        and(
          eq(billingSubscriptionCommands.id, command.id),
          eq(billingSubscriptionCommands.organization_id, command.organization_id),
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.kind, "checkout"),
          eq(billingSubscriptionCommands.status, command.status),
        ),
      );
  }

  /**
   * Resolves the organization's own Stripe customer for the Customer Portal only when an unfenced
   * organization has an org-level Stripe subscription bound to that same customer.
   */
  async readPortalAuthority(organizationId: string): Promise<SubscriptionPortalAuthority | null> {
    const [organization] = await dbWrite
      .select({
        isActive: organizations.is_active,
        lifecycle: organizations.account_lifecycle_state,
        deletion: organizations.account_deletion_request_id,
        fenced: organizations.paid_work_fenced_at,
        customerId: organizations.stripe_customer_id,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (
      !organization ||
      !organization.isActive ||
      organization.lifecycle !== "active" ||
      organization.deletion !== null ||
      organization.fenced !== null ||
      !organization.customerId
    )
      return null;
    const [subscription] = await dbWrite
      .select({ id: billingSubscriptions.id, status: billingSubscriptions.status })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.organization_id, organizationId),
          isNull(billingSubscriptions.billing_scope_id),
          eq(billingSubscriptions.provider, "stripe"),
          eq(billingSubscriptions.stripe_customer_id, organization.customerId),
        ),
      )
      .orderBy(asc(billingSubscriptions.created_at))
      .limit(1);
    if (!subscription) return null;
    return {
      customerId: organization.customerId,
      subscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
    };
  }
}

export const subscriptionCheckoutRecoveryRepository = new SubscriptionCheckoutRecoveryRepository();
