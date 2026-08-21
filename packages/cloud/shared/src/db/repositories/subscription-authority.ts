/**
 * Owns primary-database subscription lifecycle authority and its immutable
 * revision journal. Every mutation locks the organization before the
 * subscription so callers can compose it with allowance and credit work.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../helpers";
import {
  type BillingSubscription,
  type BillingSubscriptionRevision,
  type BillingSubscriptionRevisionSource,
  billingSubscriptionRevisions,
  billingSubscriptions,
  type NewBillingSubscription,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";

export const SUBSCRIPTION_AUTHORITY_CONFLICT = "SUBSCRIPTION_AUTHORITY_CONFLICT";
export const SUBSCRIPTION_AUTHORITY_NOT_FOUND = "SUBSCRIPTION_AUTHORITY_NOT_FOUND";
export const SUBSCRIPTION_AUTHORITY_TENANT_NOT_FOUND = "SUBSCRIPTION_AUTHORITY_TENANT_NOT_FOUND";

type SubscriptionRevisionValues = Required<
  Pick<
    NewBillingSubscription,
    | "stripe_subscription_id"
    | "stripe_subscription_item_id"
    | "catalog_version"
    | "plan_key"
    | "status"
    | "current_period_start"
    | "current_period_end"
    | "cancel_at_period_end"
    | "canceled_at"
    | "ended_at"
    | "dunning_started_at"
    | "grace_expires_at"
    | "pending_plan_key"
    | "provider_object_version"
    | "provider_event_id"
    | "provider_event_created_at"
    | "provider_object_digest"
  >
>;

type SubscriptionCreateValues = SubscriptionRevisionValues & {
  id?: string;
  organization_id: string;
};

export interface AdvanceSubscriptionInput {
  organizationId: string;
  subscriptionId: string;
  expectedRevision: number;
  source: BillingSubscriptionRevisionSource;
  values: SubscriptionRevisionValues;
}

export interface SubscriptionMutationResult {
  subscription: BillingSubscription;
  revision: BillingSubscriptionRevision;
  replayed: boolean;
}

function conflict(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, {
    code: SUBSCRIPTION_AUTHORITY_CONFLICT,
    context,
    severity: "fatal",
  });
}

function revisionInsert(
  subscription: BillingSubscription,
  source: BillingSubscriptionRevisionSource,
) {
  return {
    organization_id: subscription.organization_id,
    subscription_id: subscription.id,
    revision: subscription.lifecycle_revision,
    source,
    stripe_subscription_id: subscription.stripe_subscription_id,
    stripe_subscription_item_id: subscription.stripe_subscription_item_id,
    catalog_version: subscription.catalog_version,
    plan_key: subscription.plan_key,
    status: subscription.status,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end,
    cancel_at_period_end: subscription.cancel_at_period_end,
    canceled_at: subscription.canceled_at,
    ended_at: subscription.ended_at,
    dunning_started_at: subscription.dunning_started_at,
    grace_expires_at: subscription.grace_expires_at,
    pending_plan_key: subscription.pending_plan_key,
    provider_object_version: subscription.provider_object_version,
    provider_event_id: subscription.provider_event_id,
    provider_event_created_at: subscription.provider_event_created_at,
    provider_object_digest: subscription.provider_object_digest,
  } satisfies typeof billingSubscriptionRevisions.$inferInsert;
}

function sameStoredValue(stored: unknown, requested: unknown): boolean {
  if (stored instanceof Date && requested instanceof Date) {
    return stored.getTime() === requested.getTime();
  }
  return stored === (requested ?? null);
}

function hasExactLifecycleValues(
  row: BillingSubscription,
  values: SubscriptionRevisionValues,
): boolean {
  return Object.entries(values).every(([key, requested]) =>
    sameStoredValue(row[key as keyof BillingSubscription], requested),
  );
}

function isExactProviderReplay(row: BillingSubscription, values: SubscriptionRevisionValues) {
  return hasExactLifecycleValues(row, values);
}

function isExactCreateReplay(row: BillingSubscription, values: SubscriptionCreateValues) {
  const { id: requestedId, organization_id: requestedOrganizationId, ...lifecycleValues } = values;
  return (
    (requestedId == null || row.id === requestedId) &&
    row.organization_id === requestedOrganizationId &&
    hasExactLifecycleValues(row, lifecycleValues)
  );
}

export class SubscriptionAuthorityRepository {
  async findCurrent(organizationId: string): Promise<BillingSubscription | undefined> {
    const [row] = await dbWrite
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.organization_id, organizationId),
          inArray(billingSubscriptions.status, [
            "pending",
            "active",
            "grace",
            "past_due",
            "unpaid",
          ]),
        ),
      )
      .orderBy(desc(billingSubscriptions.updated_at))
      .limit(1);
    return row;
  }

  async findById(
    organizationId: string,
    subscriptionId: string,
  ): Promise<BillingSubscription | undefined> {
    const [row] = await dbWrite
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.organization_id, organizationId),
          eq(billingSubscriptions.id, subscriptionId),
        ),
      )
      .limit(1);
    return row;
  }

  async listRevisions(
    organizationId: string,
    subscriptionId: string,
  ): Promise<BillingSubscriptionRevision[]> {
    return dbWrite
      .select()
      .from(billingSubscriptionRevisions)
      .where(
        and(
          eq(billingSubscriptionRevisions.organization_id, organizationId),
          eq(billingSubscriptionRevisions.subscription_id, subscriptionId),
        ),
      )
      .orderBy(asc(billingSubscriptionRevisions.revision));
  }

  async create(
    values: SubscriptionCreateValues,
    source: BillingSubscriptionRevisionSource,
  ): Promise<SubscriptionMutationResult> {
    return writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, values.organization_id))
        .limit(1)
        .for("update");
      if (!organization) {
        throw new ElizaError("Subscription organization does not exist", {
          code: SUBSCRIPTION_AUTHORITY_TENANT_NOT_FOUND,
          context: { organizationId: values.organization_id },
        });
      }

      const [currentForOrganization] = await tx
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.organization_id, values.organization_id),
            inArray(billingSubscriptions.status, [
              "pending",
              "active",
              "grace",
              "past_due",
              "unpaid",
            ]),
          ),
        )
        .limit(1)
        .for("update");
      if (currentForOrganization) {
        const [existing] = await tx
          .select()
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.id, currentForOrganization.id))
          .limit(1)
          .for("update");
        if (!existing || !isExactCreateReplay(existing, values)) {
          conflict("Organization already has a live subscription authority", {
            organizationId: values.organization_id,
            subscriptionId: currentForOrganization.id,
          });
        }
        const [revision] = await tx
          .select()
          .from(billingSubscriptionRevisions)
          .where(
            and(
              eq(billingSubscriptionRevisions.subscription_id, existing.id),
              eq(billingSubscriptionRevisions.revision, existing.lifecycle_revision),
            ),
          )
          .limit(1);
        if (!revision) {
          conflict("Subscription replay has no immutable revision", {
            subscriptionId: existing.id,
            revision: existing.lifecycle_revision,
          });
        }
        return { subscription: existing, revision, replayed: true };
      }

      const inserted = await tx
        .insert(billingSubscriptions)
        .values({ ...values, lifecycle_revision: 1 })
        .onConflictDoNothing({ target: billingSubscriptions.stripe_subscription_id })
        .returning();
      let subscription = inserted.at(0);
      if (!subscription) {
        [subscription] = await tx
          .select()
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.stripe_subscription_id, values.stripe_subscription_id))
          .limit(1)
          .for("update");
        if (
          !subscription ||
          subscription.organization_id !== values.organization_id ||
          !isExactCreateReplay(subscription, values)
        ) {
          conflict("Subscription create idempotency key conflicts with different state", {
            organizationId: values.organization_id,
            stripeSubscriptionId: values.stripe_subscription_id,
          });
        }
        const [revision] = await tx
          .select()
          .from(billingSubscriptionRevisions)
          .where(
            and(
              eq(billingSubscriptionRevisions.subscription_id, subscription.id),
              eq(billingSubscriptionRevisions.revision, subscription.lifecycle_revision),
            ),
          )
          .limit(1);
        if (!revision) {
          conflict("Subscription replay has no immutable revision", {
            subscriptionId: subscription.id,
            revision: subscription.lifecycle_revision,
          });
        }
        return { subscription, revision, replayed: true };
      }

      const [revision] = await tx
        .insert(billingSubscriptionRevisions)
        .values(revisionInsert(subscription, source))
        .returning();
      if (!revision) {
        conflict("Subscription revision insert returned no row", {
          subscriptionId: subscription.id,
          revision: 1,
        });
      }
      return { subscription, revision, replayed: false };
    });
  }

  async advance(input: AdvanceSubscriptionInput): Promise<SubscriptionMutationResult> {
    return writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
        .for("update");
      if (!organization) {
        throw new ElizaError("Subscription organization does not exist", {
          code: SUBSCRIPTION_AUTHORITY_TENANT_NOT_FOUND,
          context: { organizationId: input.organizationId },
        });
      }
      const [current] = await tx
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.id, input.subscriptionId),
            eq(billingSubscriptions.organization_id, input.organizationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) {
        throw new ElizaError("Subscription authority row does not exist", {
          code: SUBSCRIPTION_AUTHORITY_NOT_FOUND,
          context: {
            organizationId: input.organizationId,
            subscriptionId: input.subscriptionId,
          },
        });
      }
      if (isExactProviderReplay(current, input.values)) {
        const [revision] = await tx
          .select()
          .from(billingSubscriptionRevisions)
          .where(
            and(
              eq(billingSubscriptionRevisions.subscription_id, current.id),
              eq(billingSubscriptionRevisions.revision, current.lifecycle_revision),
            ),
          )
          .limit(1);
        if (!revision) {
          conflict("Subscription replay has no immutable revision", {
            subscriptionId: current.id,
            revision: current.lifecycle_revision,
          });
        }
        return { subscription: current, revision, replayed: true };
      }
      if (current.lifecycle_revision !== input.expectedRevision) {
        conflict("Subscription lifecycle revision compare-and-swap failed", {
          subscriptionId: current.id,
          expectedRevision: input.expectedRevision,
          actualRevision: current.lifecycle_revision,
        });
      }
      if (input.values.provider_object_version <= current.provider_object_version) {
        conflict("Subscription provider object version did not advance", {
          subscriptionId: current.id,
          currentProviderObjectVersion: current.provider_object_version,
          requestedProviderObjectVersion: input.values.provider_object_version,
        });
      }
      if (
        current.provider_event_created_at != null &&
        input.values.provider_event_created_at != null &&
        input.values.provider_event_created_at.getTime() <
          current.provider_event_created_at.getTime()
      ) {
        conflict("Subscription provider event is older than current authority", {
          subscriptionId: current.id,
          currentProviderEventCreatedAt: current.provider_event_created_at.toISOString(),
          requestedProviderEventCreatedAt: input.values.provider_event_created_at.toISOString(),
        });
      }

      const nextRevision = current.lifecycle_revision + 1;
      const [subscription] = await tx
        .update(billingSubscriptions)
        .set({ ...input.values, lifecycle_revision: nextRevision, updated_at: new Date() })
        .where(
          and(
            eq(billingSubscriptions.id, current.id),
            eq(billingSubscriptions.organization_id, input.organizationId),
            eq(billingSubscriptions.lifecycle_revision, input.expectedRevision),
          ),
        )
        .returning();
      if (!subscription) {
        conflict("Subscription lifecycle revision compare-and-swap lost", {
          subscriptionId: current.id,
          expectedRevision: input.expectedRevision,
        });
      }
      const [revision] = await tx
        .insert(billingSubscriptionRevisions)
        .values(revisionInsert(subscription, input.source))
        .returning();
      if (!revision) {
        conflict("Subscription revision insert returned no row", {
          subscriptionId: subscription.id,
          revision: nextRevision,
        });
      }
      return { subscription, revision, replayed: false };
    });
  }
}

export const subscriptionAuthorityRepository = new SubscriptionAuthorityRepository();
