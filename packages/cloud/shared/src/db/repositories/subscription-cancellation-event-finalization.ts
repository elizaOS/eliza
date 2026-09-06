/** Reconciles only an immutable applied cancellation result with a fresh scheduled provider observation, publishing source, projection and receipt atomically. */
import { and, eq } from "drizzle-orm";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";
import {
  cancellationReobserve,
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "../../lib/services/stripe-period-end-cancellation";
import { writeTransaction } from "../helpers";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import {
  billingSubscriptionCommands,
  billingSubscriptionEventReceipts,
} from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import type {
  FinalizeSubscriptionLifecycleEventResult,
  SubscriptionBillingOperationsRepository,
} from "./subscription-billing-operations";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";
import {
  lifecycleFailure,
  SUBSCRIPTION_LIFECYCLE_LEASE_LOST,
  SUBSCRIPTION_LIFECYCLE_REOBSERVE,
  SUBSCRIPTION_LIFECYCLE_UNSUPPORTED,
} from "./subscription-lifecycle-finalization";
export const SCHEDULED_CANCELLATION_DISPOSITION = "scheduled_cancellation_finalized";
const scheduledFields = [
  "provider",
  "provider_environment",
  "stripe_customer_id",
  "stripe_subscription_id",
  "stripe_subscription_item_id",
  "catalog_version",
  "plan_key",
  "status",
  "current_period_start",
  "current_period_end",
  "cancel_at_period_end",
  "canceled_at",
  "ended_at",
  "dunning_started_at",
  "grace_expires_at",
  "pending_plan_key",
] as const;
function rejectConflict(message: string, context: Record<string, unknown>): never {
  return lifecycleFailure(SUBSCRIPTION_LIFECYCLE_REOBSERVE, message, context);
}
export interface FinalizeCancellationEventInput {
  organizationId: string;
  subscriptionId: string;
  commandId: string;
  receiptId: string;
  leaseToken: string;
  expectedSubscriptionRevision: number;
  expectedProjectionRevision: number | null;
  providerEventId: string;
  eventCreatedAt: Date;
  raw: unknown;
  customer: unknown;
}
export async function finalizeCancellationEvent(
  operations: SubscriptionBillingOperationsRepository,
  input: FinalizeCancellationEventInput,
): Promise<FinalizeSubscriptionLifecycleEventResult> {
  if (
    !Number.isSafeInteger(input.expectedSubscriptionRevision) ||
    input.expectedSubscriptionRevision < 1 ||
    (input.expectedProjectionRevision !== null &&
      (!Number.isSafeInteger(input.expectedProjectionRevision) ||
        input.expectedProjectionRevision < 0))
  ) {
    cancellationReobserve("invalid_expected_revision");
  }
  return writeTransaction(async (tx) => {
    const [organization] = await tx
      .select({
        id: organizations.id,
        stripe_customer_id: organizations.stripe_customer_id,
        account_lifecycle_state: organizations.account_lifecycle_state,
        paid_work_fenced_at: organizations.paid_work_fenced_at,
        is_active: organizations.is_active,
        account_deletion_request_id: organizations.account_deletion_request_id,
      })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!organization)
      rejectConflict("Lifecycle organization does not exist", {
        organizationId: input.organizationId,
      });
    if (
      !organization.is_active ||
      organization.account_deletion_request_id !== null ||
      organization.account_lifecycle_state !== "active" ||
      organization.paid_work_fenced_at !== null
    ) {
      lifecycleFailure(
        SUBSCRIPTION_LIFECYCLE_UNSUPPORTED,
        "Account deletion must use its dedicated reconciliation owner",
        { organizationId: input.organizationId },
      );
    }
    const [accountAuthority] = await tx
      .select()
      .from(organizationSubscriptionAuthorities)
      .where(eq(organizationSubscriptionAuthorities.organization_id, input.organizationId))
      .limit(1)
      .for("update");
    const [receipt] = await tx
      .select()
      .from(billingSubscriptionEventReceipts)
      .where(
        and(
          eq(billingSubscriptionEventReceipts.organization_id, input.organizationId),
          eq(billingSubscriptionEventReceipts.id, input.receiptId),
        ),
      )
      .limit(1)
      .for("update");
    if (!receipt || receipt.subscription_id !== input.subscriptionId) {
      rejectConflict("Lifecycle receipt does not belong to the requested subscription", {
        receiptId: input.receiptId,
      });
    }
    if (
      receipt.provider_object_type !== "subscription" ||
      receipt.event_type !== "customer.subscription.updated" ||
      receipt.provider_event_id !== input.providerEventId ||
      receipt.event_created_at.getTime() !== input.eventCreatedAt.getTime()
    )
      cancellationReobserve("receipt_identity_mismatch");
    if (
      receipt.status === "applied" &&
      receipt.disposition === SCHEDULED_CANCELLATION_DISPOSITION
    ) {
      return { outcome: "already_applied", receipt };
    }
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (
      receipt.status !== "processing" ||
      receipt.lease_token !== input.leaseToken ||
      receipt.lease_expires_at === null ||
      receipt.lease_expires_at <= databaseNow
    ) {
      lifecycleFailure(
        SUBSCRIPTION_LIFECYCLE_LEASE_LOST,
        "Acquire a live receipt lease before lifecycle finalization",
        { receiptId: receipt.id },
      );
    }
    if (
      !accountAuthority ||
      accountAuthority.state !== "current" ||
      accountAuthority.subscription_id !== input.subscriptionId
    ) {
      lifecycleFailure(
        SUBSCRIPTION_LIFECYCLE_REOBSERVE,
        "Account authority changed; reconcile from a new provider observation",
        { subscriptionId: input.subscriptionId },
      );
    }
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
        ),
      )
      .for("update");
    const [current] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.organization_id, input.organizationId),
          eq(billingSubscriptions.id, input.subscriptionId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current || current.lifecycle_revision !== input.expectedSubscriptionRevision) {
      lifecycleFailure(
        SUBSCRIPTION_LIFECYCLE_REOBSERVE,
        "Subscription source changed; retrieve current provider state before retrying",
        { subscriptionId: input.subscriptionId },
      );
    }
    if (
      receipt.provider_object_id !== current.stripe_subscription_id ||
      receipt.livemode !== (current.provider_environment === "live")
    )
      cancellationReobserve("receipt_source_mismatch");
    if (
      !command ||
      command.kind !== "cancel" ||
      command.status !== "APPLIED" ||
      command.subscription_id !== current.id ||
      command.result_subscription_id !== current.id ||
      command.result_subscription_revision === null ||
      command.result_subscription_revision > current.lifecycle_revision
    )
      cancellationReobserve("applied_command_required");
    const [result] = await tx
      .select()
      .from(billingSubscriptionRevisions)
      .where(
        and(
          eq(billingSubscriptionRevisions.organization_id, input.organizationId),
          eq(billingSubscriptionRevisions.subscription_id, current.id),
          eq(billingSubscriptionRevisions.revision, command.result_subscription_revision),
        ),
      );
    if (!result || result.provider_object_digest !== command.provider_response_digest)
      cancellationReobserve("command_result_unavailable");
    if (
      current.last_provider_event_created_at !== null &&
      input.eventCreatedAt < current.last_provider_event_created_at
    )
      cancellationReobserve("out_of_order_event");
    validateCancellationCustomer({
      raw: input.customer,
      source: current,
      organizationCustomerId: organization.stripe_customer_id,
      environment: getCloudAwareEnv(),
    });
    for (const field of scheduledFields) {
      const a = current[field],
        b = result[field];
      if (a instanceof Date && b instanceof Date ? a.getTime() !== b.getTime() : a !== b)
        cancellationReobserve("command_result_source_mismatch");
    }
    const observed = validatePeriodEndCancellationObservation({
      source: current,
      organizationCustomerId: organization.stripe_customer_id,
      environment: getCloudAwareEnv(),
      raw: input.raw,
      observedAt: databaseNow,
      requireScheduled: true,
    });
    if (
      current.cancel_at_period_end !== true ||
      current.canceled_at?.getTime() !== observed.canceledAt?.getTime()
    )
      cancellationReobserve("command_schedule_mismatch");
    const values = {
      provider: current.provider,
      provider_environment: current.provider_environment,
      stripe_customer_id: current.stripe_customer_id,
      stripe_subscription_id: current.stripe_subscription_id,
      stripe_subscription_item_id: current.stripe_subscription_item_id,
      catalog_version: current.catalog_version,
      plan_key: current.plan_key,
      status: current.status,
      current_period_start: current.current_period_start,
      current_period_end: current.current_period_end,
      cancel_at_period_end: current.cancel_at_period_end,
      canceled_at: current.canceled_at,
      ended_at: current.ended_at,
      dunning_started_at: current.dunning_started_at,
      grace_expires_at: current.grace_expires_at,
      pending_plan_key: current.pending_plan_key,
      last_provider_event_id: input.providerEventId,
      last_provider_event_created_at: input.eventCreatedAt,
      provider_object_digest: observed.providerObjectDigest,
    };
    const lifecycle = await subscriptionAuthorityRepository.advanceInTransaction(tx, {
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId,
      expectedRevision: input.expectedSubscriptionRevision,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values,
    });
    if (lifecycle.revision.revision !== lifecycle.subscription.lifecycle_revision) {
      lifecycleFailure(
        SUBSCRIPTION_LIFECYCLE_REOBSERVE,
        "Historical provider-event replay cannot publish current entitlement",
        { receiptId: receipt.id },
      );
    }
    for (const field of [
      ...scheduledFields,
      "last_provider_event_id",
      "last_provider_event_created_at",
      "provider_object_digest",
    ] as const) {
      const a = lifecycle.subscription[field],
        b = values[field];
      if (a instanceof Date && b instanceof Date ? a.getTime() !== b.getTime() : a !== b)
        cancellationReobserve("event_replay_observation_mismatch");
    }
    const projection = await subscriptionEntitlementsRepository.rebuildInTransaction(tx, {
      organizationId: input.organizationId,
      sourceSubscriptionId: input.subscriptionId,
      sourceSubscriptionRevision: lifecycle.subscription.lifecycle_revision,
      expectedProjectionRevision: input.expectedProjectionRevision,
    });
    const applied = await operations.applyEventInTransaction(tx, {
      organizationId: input.organizationId,
      receiptId: receipt.id,
      leaseToken: input.leaseToken,
      subscriptionRevision: lifecycle.subscription.lifecycle_revision,
      disposition: SCHEDULED_CANCELLATION_DISPOSITION,
    });
    if (!applied) {
      lifecycleFailure(
        SUBSCRIPTION_LIFECYCLE_LEASE_LOST,
        "Receipt lease expired before commit; lifecycle and projection were rolled back",
        { receiptId: receipt.id },
      );
    }
    return {
      outcome: "applied",
      receipt: applied,
      subscription: lifecycle.subscription,
      entitlement: projection.entitlement,
    };
  });
}
