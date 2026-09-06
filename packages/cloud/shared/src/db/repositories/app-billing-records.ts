/** Reads scoped billing records and journals seat mutations in the same transaction as authorization and capacity checks. */
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import {
  appBillingPlanRevisions,
  appBillingScopes,
  appBillingSeats,
  billingMerchants,
} from "../schemas/app-billing";
import {
  type AppBillingSeatMutationResult,
  appBillingSeatMutations,
} from "../schemas/app-billing-seat-mutations";
import { apps } from "../schemas/apps";
import {
  billingFundingAllocations,
  billingFundingReservations,
} from "../schemas/billing-funding-reservations";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { type AppBillingReadIdentity, readAppBillingMembership } from "./app-billing-queries";
import { setAppBillingSeat } from "./app-billing-seats";
import {
  appBillingConflict,
  lockAppBillingScope,
  requireAppBillingAdministrator,
} from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

async function recordScope(tx: DbTransaction, input: AppBillingReadIdentity) {
  const [app] = await tx
    .select({ organizationId: apps.organization_id })
    .from(apps)
    .where(eq(apps.id, input.appId));
  if (!app) appBillingConflict("Registered app is unavailable");
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, app.organizationId))
    .for("update");
  const [row] = await tx
    .select({ id: appBillingScopes.id })
    .from(appBillingScopes)
    .where(
      and(
        eq(appBillingScopes.app_id, input.appId),
        eq(appBillingScopes.billing_account_id, input.billingAccountId),
        eq(appBillingScopes.product_family_key, input.productFamilyKey),
        eq(appBillingScopes.livemode, input.livemode),
      ),
    );
  const scope = row ? await lockAppBillingScope(tx, row.id, true) : null;
  await readAppBillingMembership(tx, input);
  if (!scope) {
    const [family] = await tx
      .select({ id: appBillingPlanRevisions.id })
      .from(appBillingPlanRevisions)
      .innerJoin(billingMerchants, eq(billingMerchants.id, appBillingPlanRevisions.merchant_id))
      .where(
        and(
          eq(appBillingPlanRevisions.app_id, input.appId),
          eq(appBillingPlanRevisions.product_family_key, input.productFamilyKey),
          eq(billingMerchants.livemode, input.livemode),
        ),
      )
      .limit(1);
    if (!family) appBillingConflict("Registered app product family is unavailable");
  }
  return scope;
}

export class AppBillingRecordsRepository {
  async seats(input: AppBillingReadIdentity, after: string | null, pageSize: number) {
    return writeTransaction(async (tx) => {
      const scope = await recordScope(tx, input);
      if (!scope) return [];
      return tx
        .select()
        .from(appBillingSeats)
        .where(
          and(
            eq(appBillingSeats.billing_scope_id, scope.scopeId),
            isNull(appBillingSeats.revoked_at),
            after ? gt(appBillingSeats.id, after) : undefined,
          ),
        )
        .orderBy(asc(appBillingSeats.id))
        .limit(pageSize + 1);
    });
  }

  async seatMutation(
    input: AppBillingReadIdentity,
    mutation:
      | { kind: "assign"; subject: string; idempotencyKey: string }
      | { kind: "revoke"; seatId: string; idempotencyKey: string },
  ): Promise<AppBillingSeatMutationResult> {
    return writeTransaction(async (tx) => {
      const scope = await recordScope(tx, input);
      if (!scope) appBillingConflict("App subscription scope is unavailable");
      await requireAppBillingAdministrator(tx, scope, input.actorUserId);
      const digest = settlementDigest({ ...mutation, actorUserId: input.actorUserId });
      const [previous] = await tx
        .select()
        .from(appBillingSeatMutations)
        .where(
          and(
            eq(appBillingSeatMutations.billing_scope_id, scope.scopeId),
            eq(appBillingSeatMutations.idempotency_key, mutation.idempotencyKey),
          ),
        );
      if (previous) {
        if (previous.request_digest !== digest)
          appBillingConflict("Seat idempotency key was used for a different request");
        return previous.result;
      }
      const now = await readPostLockDatabaseNow(tx);
      let result: AppBillingSeatMutationResult;
      if (mutation.kind === "assign") {
        const seat = await setAppBillingSeat(tx, { scope, ...mutation, assigned: true, now });
        if (!seat)
          appBillingConflict(
            "The previous seat assignment has been revoked; use a new request key",
          );
        result = { kind: "assign", seat };
      } else {
        const [seat] = await tx
          .select()
          .from(appBillingSeats)
          .where(
            and(
              eq(appBillingSeats.id, mutation.seatId),
              eq(appBillingSeats.billing_scope_id, scope.scopeId),
            ),
          );
        if (!seat) appBillingConflict("Seat does not belong to this app subscription");
        const revoked =
          seat.revoked_at === null &&
          (await setAppBillingSeat(tx, {
            scope,
            subject: seat.subject,
            assigned: false,
            now,
            idempotencyKey: mutation.idempotencyKey,
          })) !== null;
        result = { kind: "revoke", revoked };
      }
      await tx.insert(appBillingSeatMutations).values({
        billing_scope_id: scope.scopeId,
        idempotency_key: mutation.idempotencyKey,
        request_digest: digest,
        result,
        created_at: now,
      });
      return result;
    });
  }

  async invoiceContext(input: AppBillingReadIdentity) {
    return writeTransaction(async (tx) => {
      const scope = await recordScope(tx, input);
      if (!scope) return { scope: null, subscriptions: [] };
      const subscriptions = await tx
        .select({
          id: billingSubscriptions.id,
          providerId: billingSubscriptions.stripe_subscription_id,
        })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.billing_scope_id, scope.scopeId),
            eq(billingSubscriptions.provider_environment, input.livemode ? "live" : "test"),
          ),
        )
        .orderBy(asc(billingSubscriptions.id));
      return { scope, subscriptions };
    });
  }

  async usage(
    input: AppBillingReadIdentity,
    after: { reservationId: string; source: "trial_claim" | "paid_invoice" } | null,
    pageSize: number,
  ) {
    return writeTransaction(async (tx) => {
      const scope = await recordScope(tx, input);
      if (!scope) return [];
      return tx
        .select({
          reservationId: billingFundingReservations.id,
          operationId: billingFundingReservations.logical_operation_id,
          source: subscriptionAllowancePeriods.grant_source,
          amountUsd: sql<string>`sum(${billingFundingAllocations.finalized_amount})::text`,
          occurredAt: billingFundingReservations.finalized_at,
        })
        .from(billingFundingAllocations)
        .innerJoin(
          billingFundingReservations,
          eq(billingFundingReservations.id, billingFundingAllocations.reservation_id),
        )
        .innerJoin(
          subscriptionAllowancePeriods,
          eq(subscriptionAllowancePeriods.id, billingFundingAllocations.allowance_period_id),
        )
        .where(
          and(
            eq(billingFundingAllocations.billing_scope_id, scope.scopeId),
            eq(billingFundingReservations.billing_scope_id, scope.scopeId),
            eq(subscriptionAllowancePeriods.billing_scope_id, scope.scopeId),
            eq(billingFundingAllocations.merchant_key, scope.merchantKey),
            eq(billingFundingReservations.merchant_key, scope.merchantKey),
            eq(subscriptionAllowancePeriods.merchant_key, scope.merchantKey),
            eq(subscriptionAllowancePeriods.provider_environment, input.livemode ? "live" : "test"),
            eq(billingFundingReservations.status, "finalized"),
            eq(billingFundingAllocations.source, "allowance"),
            gt(billingFundingAllocations.finalized_amount, "0"),
            after
              ? or(
                  gt(billingFundingReservations.id, after.reservationId),
                  and(
                    eq(billingFundingReservations.id, after.reservationId),
                    gt(subscriptionAllowancePeriods.grant_source, after.source),
                  ),
                )
              : undefined,
          ),
        )
        .groupBy(
          billingFundingReservations.id,
          billingFundingReservations.logical_operation_id,
          subscriptionAllowancePeriods.grant_source,
          billingFundingReservations.finalized_at,
        )
        .orderBy(asc(billingFundingReservations.id), asc(subscriptionAllowancePeriods.grant_source))
        .limit(pageSize + 1);
    });
  }
}

export const appBillingRecordsRepository = new AppBillingRecordsRepository();
