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
import { readPostLockDatabaseNow } from "./primary-database-clock";

export const SUBSCRIPTION_AUTHORITY_CONFLICT = "SUBSCRIPTION_AUTHORITY_CONFLICT";
export const SUBSCRIPTION_AUTHORITY_NOT_FOUND = "SUBSCRIPTION_AUTHORITY_NOT_FOUND";
export const SUBSCRIPTION_AUTHORITY_TENANT_NOT_FOUND = "SUBSCRIPTION_AUTHORITY_TENANT_NOT_FOUND";

type SubscriptionRevisionValues = Required<
  Pick<
    NewBillingSubscription,
    | "provider"
    | "provider_environment"
    | "stripe_customer_id"
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
    | "last_provider_event_id"
    | "last_provider_event_created_at"
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
  /** Confirms values came from a fresh provider-object retrieval, never the webhook payload. */
  observation: "authoritative_provider_retrieval";
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
    provider: subscription.provider,
    provider_environment: subscription.provider_environment,
    stripe_customer_id: subscription.stripe_customer_id,
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
    provider_event_id: subscription.last_provider_event_id,
    provider_event_created_at: subscription.last_provider_event_created_at,
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
  if (values.last_provider_event_id === null) return hasExactLifecycleValues(row, values);
  return (
    row.last_provider_event_id === values.last_provider_event_id &&
    row.provider_object_digest === values.provider_object_digest &&
    hasExactLifecycleValues(row, values)
  );
}

function requireActivationAllowed(
  organization: Pick<
    typeof organizations.$inferSelect,
    "account_lifecycle_state" | "paid_work_fenced_at" | "stripe_customer_id"
  >,
  values: SubscriptionRevisionValues,
): void {
  if (values.status !== "active" && values.status !== "grace") return;
  if (organization.account_lifecycle_state !== "active" || organization.paid_work_fenced_at) {
    conflict("Subscription activation is blocked by the account deletion fence", {
      accountLifecycleState: organization.account_lifecycle_state,
      paidWorkFencedAt: organization.paid_work_fenced_at?.toISOString() ?? null,
    });
  }
  if (
    organization.stripe_customer_id !== null &&
    organization.stripe_customer_id !== values.stripe_customer_id
  ) {
    conflict("Subscription customer differs from the organization billing authority", {
      organizationStripeCustomerId: organization.stripe_customer_id,
      subscriptionStripeCustomerId: values.stripe_customer_id,
    });
  }
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
            "incomplete",
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
        .select({
          id: organizations.id,
          account_lifecycle_state: organizations.account_lifecycle_state,
          paid_work_fenced_at: organizations.paid_work_fenced_at,
          stripe_customer_id: organizations.stripe_customer_id,
        })
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
      requireActivationAllowed(organization, values);

      const [currentForOrganization] = await tx
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.organization_id, values.organization_id),
            inArray(billingSubscriptions.status, [
              "pending",
              "incomplete",
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
        .onConflictDoNothing()
        .returning();
      let subscription = inserted.at(0);
      if (!subscription) {
        [subscription] = await tx
          .select()
          .from(billingSubscriptions)
          .where(
            and(
              eq(billingSubscriptions.provider, values.provider),
              eq(billingSubscriptions.provider_environment, values.provider_environment),
              eq(billingSubscriptions.stripe_subscription_id, values.stripe_subscription_id),
            ),
          )
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
        .select({
          id: organizations.id,
          account_lifecycle_state: organizations.account_lifecycle_state,
          paid_work_fenced_at: organizations.paid_work_fenced_at,
          stripe_customer_id: organizations.stripe_customer_id,
        })
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
      requireActivationAllowed(organization, input.values);
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
      if (input.values.last_provider_event_id !== null) {
        const [recordedEvent] = await tx
          .select()
          .from(billingSubscriptionRevisions)
          .where(
            and(
              eq(billingSubscriptionRevisions.provider, input.values.provider),
              eq(
                billingSubscriptionRevisions.provider_environment,
                input.values.provider_environment,
              ),
              eq(
                billingSubscriptionRevisions.provider_event_id,
                input.values.last_provider_event_id,
              ),
            ),
          )
          .limit(1);
        if (recordedEvent) {
          if (recordedEvent.subscription_id !== current.id) {
            conflict("Subscription provider event replay has a different authority", {
              subscriptionId: current.id,
              providerEventId: input.values.last_provider_event_id,
            });
          }
          return { subscription: current, revision: recordedEvent, replayed: true };
        }
      }
      // Provider event timestamps are deduplication metadata, not object versions. The
      // caller contract requires a fresh authoritative retrieval, so reordered events
      // converge on provider state without inventing a monotonic Stripe version.
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
      if (
        current.provider !== input.values.provider ||
        current.provider_environment !== input.values.provider_environment ||
        current.stripe_customer_id !== input.values.stripe_customer_id ||
        current.stripe_subscription_id !== input.values.stripe_subscription_id
      ) {
        conflict("Subscription provider identity is immutable", {
          subscriptionId: current.id,
        });
      }
      const nextRevision = current.lifecycle_revision + 1;
      const now = await readPostLockDatabaseNow(tx);
      const [subscription] = await tx
        .update(billingSubscriptions)
        .set({ ...input.values, lifecycle_revision: nextRevision, updated_at: now })
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
