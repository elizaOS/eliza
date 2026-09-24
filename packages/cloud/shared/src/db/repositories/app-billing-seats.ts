/** Mutates app seats under the caller's canonical scope lock; only current members may receive current entitlement capacity. */
import type { AppBillingSeat } from "@elizaos/cloud-sdk/app-billing";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { appBillingSeats } from "../schemas/app-billing";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";
import { readAppBillingMembership } from "./app-billing-queries";
import { appBillingConflict, type ScopedBillingContext } from "./app-subscription-authority";

function seatDto(row: typeof appBillingSeats.$inferSelect): AppBillingSeat {
  return { id: row.id, subject: row.subject, assignedAt: row.assigned_at.toISOString() };
}

/** Caller holds organization/scope locks, authorizes the actor and journals its own complete request. */
export async function setAppBillingSeat(
  tx: DbTransaction,
  input: {
    scope: ScopedBillingContext;
    subject: string;
    assigned: boolean;
    idempotencyKey: string;
    now: Date;
  },
): Promise<AppBillingSeat | null> {
  const { scope } = input;
  const [active] = await tx
    .select()
    .from(appBillingSeats)
    .where(
      and(
        eq(appBillingSeats.billing_scope_id, scope.scopeId),
        eq(appBillingSeats.subject, input.subject),
        isNull(appBillingSeats.revoked_at),
      ),
    );
  if (!input.assigned) {
    if (!active) return null;
    await tx
      .update(appBillingSeats)
      .set({ revoked_at: input.now })
      .where(eq(appBillingSeats.id, active.id));
    return seatDto(active);
  }
  if (scope.fenced) appBillingConflict("New seat assignments are fenced");
  const memberIdentity = {
    appId: scope.appId,
    billingAccountId: scope.billingAccountId,
    actorUserId: input.subject,
    livemode: scope.livemode,
  };
  await readAppBillingMembership(tx, memberIdentity);
  const [principal] = await tx
    .select({ anonymous: users.is_anonymous })
    .from(users)
    .where(eq(users.id, input.subject));
  if (!principal || principal.anonymous)
    appBillingConflict("Seat assignment requires a signed-in account member");
  const [source] = await tx
    .select({ projection: organizationEntitlements, subscription: billingSubscriptions })
    .from(organizationEntitlements)
    .innerJoin(
      billingSubscriptions,
      eq(billingSubscriptions.id, organizationEntitlements.source_subscription_id),
    )
    .where(eq(organizationEntitlements.billing_scope_id, scope.scopeId));
  if (
    !source ||
    source.subscription.billing_scope_id !== scope.scopeId ||
    source.subscription.provider_environment !== (scope.livemode ? "live" : "test") ||
    source.projection.source_subscription_revision !== source.subscription.lifecycle_revision ||
    source.projection.quantity !== source.subscription.quantity ||
    !source.projection.entitlement_effective ||
    source.projection.access !== "granted" ||
    source.projection.effective_from > input.now ||
    source.projection.effective_until === null ||
    source.projection.effective_until <= input.now
  )
    appBillingConflict("Seat assignment requires a current app subscription entitlement");
  const [previous] = await tx
    .select()
    .from(appBillingSeats)
    .where(
      and(
        eq(appBillingSeats.billing_scope_id, scope.scopeId),
        eq(appBillingSeats.idempotency_key, input.idempotencyKey),
      ),
    );
  if (previous) {
    if (previous.subject !== input.subject)
      appBillingConflict("Seat idempotency key belongs to another subject");
    return previous.revoked_at === null ? seatDto(previous) : null;
  }
  if (active) return seatDto(active);
  const [pending] = await tx
    .select({ id: billingSubscriptionCommands.id })
    .from(billingSubscriptionCommands)
    .where(
      and(
        eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
        inArray(billingSubscriptionCommands.kind, [
          "checkout",
          "upgrade",
          "downgrade",
          "cancel",
          "resume",
        ]),
        inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
      ),
    )
    .limit(1);
  if (pending) appBillingConflict("Seat assignment must wait for the pending subscription change");
  const occupied = await tx
    .select({ id: appBillingSeats.id })
    .from(appBillingSeats)
    .where(
      and(eq(appBillingSeats.billing_scope_id, scope.scopeId), isNull(appBillingSeats.revoked_at)),
    );
  if (occupied.length >= source.projection.quantity)
    appBillingConflict("App subscription has no unassigned seats");
  const [assigned] = await tx
    .insert(appBillingSeats)
    .values({
      billing_scope_id: scope.scopeId,
      subject: input.subject,
      idempotency_key: input.idempotencyKey,
      assigned_at: input.now,
    })
    .returning();
  if (!assigned) appBillingConflict("Seat assignment was not persisted");
  return seatDto(assigned);
}
