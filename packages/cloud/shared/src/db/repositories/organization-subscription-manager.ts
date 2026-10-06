/** Primary organization subscription authority shared by reviewed lifecycle commands.
 * Call inside a write transaction; retain the organization-before-association-before-
 * subscription lock order. Product hosts never supply an alternate ownership store.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export interface OrganizationSubscriptionIdentity {
  organizationId: string;
  actorId: string;
}
export interface OrganizationSubscriptionSourceInput extends OrganizationSubscriptionIdentity {
  subscriptionId: string;
  expectedSubscriptionRevision: number;
}
type RejectOrganizationSubscription = (reason: string) => never;

export async function lockOrganizationSubscriptionManager(
  tx: DbTransaction,
  input: OrganizationSubscriptionIdentity,
  reject: RejectOrganizationSubscription,
) {
  const [organization] = await tx
    .select({
      id: organizations.id,
      active: organizations.is_active,
      state: organizations.account_lifecycle_state,
      deletion: organizations.account_deletion_request_id,
      fenced: organizations.paid_work_fenced_at,
      customer: organizations.stripe_customer_id,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("update");
  if (
    !organization ||
    !organization.active ||
    organization.state !== "active" ||
    organization.deletion !== null ||
    organization.fenced !== null
  )
    reject("organization_authority_unavailable");
  const [association] = await tx
    .select()
    .from(organizationSubscriptionAuthorities)
    .where(eq(organizationSubscriptionAuthorities.organization_id, input.organizationId))
    .for("update");
  const [actor] = await tx
    .select({
      organizationId: users.organization_id,
      role: users.role,
      active: users.is_active,
      anonymous: users.is_anonymous,
      deleted: users.deleted_at,
      expires: users.expires_at,
    })
    .from(users)
    .where(eq(users.id, input.actorId));
  const now = await readPostLockDatabaseNow(tx);
  if (
    !actor ||
    actor.organizationId !== input.organizationId ||
    !actor.active ||
    actor.anonymous ||
    actor.deleted !== null ||
    (actor.expires !== null && actor.expires <= now) ||
    (actor.role !== "owner" && actor.role !== "admin")
  )
    reject("current_manager_required");
  return { organization, association, now };
}
export async function lockCurrentOrganizationSubscription(
  tx: DbTransaction,
  input: OrganizationSubscriptionSourceInput,
  locked: Awaited<ReturnType<typeof lockOrganizationSubscriptionManager>>,
  reject: RejectOrganizationSubscription,
  pendingPolicy?: "configured_cancellation",
) {
  if (
    !locked.association ||
    locked.association.state !== "current" ||
    locked.association.subscription_id !== input.subscriptionId
  )
    reject("current_subscription_unavailable");
  const [source] = await tx
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        isNull(billingSubscriptions.billing_scope_id),
        eq(billingSubscriptions.organization_id, input.organizationId),
        eq(billingSubscriptions.id, input.subscriptionId),
      ),
    )
    .for("update");
  if (
    !source ||
    source.lifecycle_revision !== input.expectedSubscriptionRevision ||
    source.status !== "active" ||
    source.current_period_start === null ||
    source.current_period_end === null ||
    source.current_period_end <= locked.now ||
    source.ended_at !== null ||
    (source.pending_plan_key !== null && pendingPolicy !== "configured_cancellation") ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    locked.organization.customer === null ||
    locked.organization.customer !== source.stripe_customer_id
  )
    reject("source_changed_or_unsupported");
  return source;
}
