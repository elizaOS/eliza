/**
 * Atomically admits app-customer allowance and developer-paid inference in the existing funding ledgers.
 * Scope, member, environment and entitlement authority come from the primary database. A provider
 * admission is a durable dispatch intent: a repeated logical operation cannot invoke the provider again.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { writeTransaction } from "../../db/helpers";
import { appBillingMembershipEnvironment } from "../../db/repositories/app-billing-membership-scope";
import {
  lockAppBillingScope,
  type ScopedBillingContext,
} from "../../db/repositories/app-subscription-authority";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { subscriptionAllowanceRepository } from "../../db/repositories/subscription-allowance";
import {
  type BillingFundingScope,
  type CanonicalMoney,
  fundingScopePredicate,
  microsToMoney,
  moneyToMicros,
  subscriptionFundingReservationsRepository,
} from "../../db/repositories/subscription-funding-reservations";
import { appBillingMembers, appBillingScopes } from "../../db/schemas/app-billing";
import {
  type BillingFundingReservation,
  billingFundingReservations,
} from "../../db/schemas/billing-funding-reservations";
import { billingSubscriptions } from "../../db/schemas/billing-subscriptions";
import { organizationEntitlements } from "../../db/schemas/organization-entitlements";
import { providerAdmissions } from "../../db/schemas/provider-admissions";
import { subscriptionAllowancePeriods } from "../../db/schemas/subscription-allowance-periods";
import { users } from "../../db/schemas/users";
import { creditsService } from "./credits";
import { settlementDigest } from "./settlement-digest";
import { capSubscriptionFundingSettlement } from "./subscription-funding";
import { SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN } from "./subscription-funding-policy";

/** Resolved registered backend credential and delegated actor; HTTP fields alone cannot construct authority. */
export interface AppInferenceFundingActor {
  appId: string;
  billingAccountId: string;
  productFamilyKey: string;
  environment: "test" | "live";
  developerOrganizationId: string;
  actorUserId: string;
}
export interface AppInferenceFundingRequest {
  actor: AppInferenceFundingActor;
  logicalOperationId: string;
  /** Digest of the complete provider request, computed by the trusted route. */
  requestDigest: string;
  estimatedAmountUsd: string;
}
export interface AppInferenceFundingReservation {
  logicalOperationId: string;
  scopeId: string;
  allowanceReservationId: string;
  infrastructureReservationId: string;
  status: "reserved" | "finalized" | "canceled";
  reservedAmountUsd: CanonicalMoney;
  validUntil: Date;
  /** Only the transaction that created the pair receives permission to dispatch. */
  dispatchGranted: boolean;
}
export interface AppInferenceFundingSettlement {
  status: "finalized" | "canceled";
  replayed: boolean;
  collectedAmountUsd: CanonicalMoney;
  uncollectedOverageUsd: CanonicalMoney;
  infrastructureDebitTransactionId: string;
  infrastructureRefundTransactionId: string | null;
}
function fail(code: string, message: string): never {
  throw new ElizaError(message, { code: `APP_INFERENCE_${code}` });
}
function validateRequest(input: AppInferenceFundingRequest): CanonicalMoney {
  if (
    !SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN.test(input.logicalOperationId) ||
    !/^[a-f0-9]{64}$/.test(input.requestDigest)
  )
    fail("REQUEST", "A stable operation ID and complete request digest are required");
  if (input.actor.environment !== "test" && input.actor.environment !== "live")
    fail("ENVIRONMENT", "Billing environment must be explicit");
  const amount = moneyToMicros(input.estimatedAmountUsd, "estimatedAmountUsd");
  if (amount <= 0n) fail("AMOUNT", "Inference reservation must be positive");
  return microsToMoney(amount);
}
function identity(input: AppInferenceFundingRequest) {
  const operation = settlementDigest({
    appId: input.actor.appId,
    billingAccountId: input.actor.billingAccountId,
    productFamilyKey: input.actor.productFamilyKey,
    environment: input.actor.environment,
    logicalOperationId: input.logicalOperationId,
  });
  return {
    allowanceKey: `app-allowance:${operation}`,
    infrastructureKey: `app-infrastructure:${operation}`,
  };
}
async function scopeForActor(
  tx: DbTransaction,
  actor: AppInferenceFundingActor,
  allowFenced = false,
) {
  const [hint] = await tx
    .select({ id: appBillingScopes.id })
    .from(appBillingScopes)
    .where(
      and(
        eq(appBillingScopes.app_id, actor.appId),
        eq(appBillingScopes.billing_account_id, actor.billingAccountId),
        eq(appBillingScopes.product_family_key, actor.productFamilyKey),
        eq(appBillingScopes.livemode, actor.environment === "live"),
      ),
    );
  if (!hint) fail("SCOPE", "App subscription scope is unavailable in this environment");
  const scope = await lockAppBillingScope(tx, hint.id, true);
  if (scope.fenced && !allowFenced) fail("SCOPE", "App subscription access is suspended");
  if (
    scope.organizationId !== actor.developerOrganizationId ||
    scope.appId !== actor.appId ||
    scope.billingAccountId !== actor.billingAccountId ||
    scope.productFamilyKey !== actor.productFamilyKey ||
    scope.livemode !== (actor.environment === "live")
  )
    fail("SCOPE", "Developer credential does not own this app billing scope");
  return scope;
}
async function requireMember(tx: DbTransaction, actor: AppInferenceFundingActor) {
  const [principal] = await tx
    .select({ active: users.is_active, deletedAt: users.deleted_at })
    .from(users)
    .where(eq(users.id, actor.actorUserId))
    .for("update");
  const [member] = await tx
    .select({ id: appBillingMembers.id })
    .from(appBillingMembers)
    .where(
      and(
        eq(appBillingMembers.app_id, actor.appId),
        eq(appBillingMembers.billing_account_id, actor.billingAccountId),
        eq(appBillingMembers.user_id, actor.actorUserId),
        isNull(appBillingMembers.revoked_at),
        appBillingMembershipEnvironment(actor.environment === "live"),
      ),
    )
    .for("update");
  if (!principal?.active || principal.deletedAt || !member)
    fail("MEMBERSHIP", "Current app account membership is required");
}
function scopeBinding(scope: ScopedBillingContext): BillingFundingScope {
  return { scopeId: scope.scopeId, merchantKey: scope.merchantKey };
}
async function findPair(
  tx: DbTransaction,
  scope: ScopedBillingContext,
  input: AppInferenceFundingRequest,
) {
  const keys = identity(input);
  const [allowance] = await tx
    .select()
    .from(billingFundingReservations)
    .where(
      and(
        eq(billingFundingReservations.organization_id, scope.organizationId),
        eq(billingFundingReservations.logical_operation_id, keys.allowanceKey),
        fundingScopePredicate(billingFundingReservations, scopeBinding(scope)),
      ),
    )
    .for("update");
  const [infrastructure] = await tx
    .select()
    .from(billingFundingReservations)
    .where(
      and(
        eq(billingFundingReservations.organization_id, scope.organizationId),
        eq(billingFundingReservations.logical_operation_id, keys.infrastructureKey),
        fundingScopePredicate(billingFundingReservations),
      ),
    )
    .for("update");
  if (Boolean(allowance) !== Boolean(infrastructure))
    fail("PAIR_CONFLICT", "App usage funding is incomplete and requires reconciliation");
  return allowance && infrastructure ? { allowance, infrastructure } : null;
}
function requestDigests(
  scope: ScopedBillingContext,
  input: AppInferenceFundingRequest,
  amount: CanonicalMoney,
) {
  const bound = {
    actor: input.actor,
    scopeId: scope.scopeId,
    merchantId: scope.merchantId,
    merchantKey: scope.merchantKey,
    logicalOperationId: input.logicalOperationId,
    requestDigest: input.requestDigest,
    amount,
  };
  return {
    allowance: settlementDigest({ ...bound, leg: "customer_allowance" }),
    infrastructure: settlementDigest({ ...bound, leg: "developer_infrastructure" }),
  };
}
function assertPair(
  input: { allowance: BillingFundingReservation; infrastructure: BillingFundingReservation },
  digests: ReturnType<typeof requestDigests>,
  amount: CanonicalMoney,
) {
  if (
    input.allowance.request_digest !== digests.allowance ||
    input.infrastructure.request_digest !== digests.infrastructure ||
    input.allowance.requested_amount !== amount ||
    input.infrastructure.requested_amount !== amount ||
    input.allowance.status !== input.infrastructure.status
  )
    fail(
      "REPLAY_CONFLICT",
      "Operation ID belongs to a different inference request or terminal outcome",
    );
}

export class AppInferenceFundingService {
  async reserve(input: AppInferenceFundingRequest): Promise<AppInferenceFundingReservation> {
    const amount = validateRequest(input);
    const result = await writeTransaction(async (tx) => {
      const scope = await scopeForActor(tx, input.actor);
      await requireMember(tx, input.actor);
      const now = await readPostLockDatabaseNow(tx);
      const digests = requestDigests(scope, input, amount);
      const existing = await findPair(tx, scope, input);
      if (existing) {
        assertPair(existing, digests, amount);
        return {
          logicalOperationId: input.logicalOperationId,
          scopeId: scope.scopeId,
          allowanceReservationId: existing.allowance.id,
          infrastructureReservationId: existing.infrastructure.id,
          status: existing.allowance.status,
          reservedAmountUsd: amount,
          validUntil: new Date(
            Math.min(
              existing.allowance.expires_at.getTime(),
              existing.infrastructure.expires_at.getTime(),
            ),
          ),
          dispatchGranted: false,
        };
      }
      const [entitlement] = await tx
        .select()
        .from(organizationEntitlements)
        .where(
          and(
            eq(organizationEntitlements.organization_id, scope.organizationId),
            eq(organizationEntitlements.billing_scope_id, scope.scopeId),
          ),
        )
        .for("update");
      if (
        !entitlement ||
        !entitlement.entitlement_effective ||
        entitlement.access !== "granted" ||
        entitlement.effective_from > now ||
        entitlement.effective_until === null ||
        entitlement.effective_until <= now ||
        !entitlement.features.includes("inference") ||
        !entitlement.source_subscription_id
      )
        fail("ENTITLEMENT", "This app subscription does not currently grant inference access");
      const [subscription] = await tx
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.id, entitlement.source_subscription_id),
            eq(billingSubscriptions.organization_id, scope.organizationId),
            fundingScopePredicate(billingSubscriptions, scopeBinding(scope)),
          ),
        )
        .for("update");
      if (
        !subscription ||
        subscription.provider_environment !== input.actor.environment ||
        subscription.lifecycle_revision !== entitlement.source_subscription_revision ||
        !["active", "trialing"].includes(subscription.status)
      )
        fail("PROJECTION_UNAVAILABLE", "App subscription projection is stale or unavailable");
      const periods = await tx
        .select()
        .from(subscriptionAllowancePeriods)
        .where(
          and(
            eq(subscriptionAllowancePeriods.organization_id, scope.organizationId),
            fundingScopePredicate(subscriptionAllowancePeriods, scopeBinding(scope)),
            eq(subscriptionAllowancePeriods.subscription_id, subscription.id),
            eq(subscriptionAllowancePeriods.provider_environment, input.actor.environment),
            eq(subscriptionAllowancePeriods.state, "open"),
            lte(subscriptionAllowancePeriods.period_start, now),
            gt(subscriptionAllowancePeriods.expires_at, now),
          ),
        )
        .for("update");
      const period = periods[0];
      if (
        periods.length !== 1 ||
        !period ||
        moneyToMicros(period.available_amount, "availableAmount") < moneyToMicros(amount, "amount")
      )
        fail(
          "ALLOWANCE_INSUFFICIENT",
          "This app account has no sufficient current usage allowance",
        );
      const validUntil = new Date(
        Math.min(entitlement.effective_until.getTime(), period.expires_at.getTime()),
      );
      const keys = identity(input);
      const metadata = {
        type: "app_subscription_infrastructure",
        appId: scope.appId,
        billingAccountId: scope.billingAccountId,
        billingScopeId: scope.scopeId,
        merchantId: scope.merchantId,
        environment: input.actor.environment,
        actorUserId: input.actor.actorUserId,
        logicalOperationId: input.logicalOperationId,
        requestDigest: input.requestDigest,
      };
      const debitAmount = Number(amount);
      if (!Number.isFinite(debitAmount) || debitAmount.toFixed(6) !== amount)
        fail(
          "AMOUNT",
          "Infrastructure reservation cannot be represented exactly by the credit writer",
        );
      const debit = await creditsService.reserveAndDeductCredits({
        organizationId: scope.organizationId,
        amount: debitAmount,
        description: "App subscription inference infrastructure reservation",
        metadata,
        stripePaymentIntentId: `app-infrastructure-reserve:${digests.infrastructure}`,
        db: tx,
        deferPostCommitEffects: true,
      });
      if (!debit.success || !debit.transaction)
        fail(
          "INFRASTRUCTURE_INSUFFICIENT",
          "The app developer has insufficient infrastructure funding",
        );
      const infrastructure = await subscriptionFundingReservationsRepository.createPrerequisite(
        tx,
        {
          organizationId: scope.organizationId,
          logicalOperationId: keys.infrastructureKey,
          requestDigest: digests.infrastructure,
          fundingClass: "cash_only",
          requestedAmount: amount,
          allowancePeriodId: null,
          allowanceAmount: microsToMoney(0n),
          purchasedCreditAmount: amount,
          purchasedCreditReservationTransactionId: debit.transaction.id,
          expiresAt: validUntil,
        },
      );
      const allowance = await subscriptionAllowanceRepository.reserve(tx, {
        organizationId: scope.organizationId,
        billingScope: scopeBinding(scope),
        periodId: period.id,
        logicalOperationId: keys.allowanceKey,
        requestDigest: digests.allowance,
        requestedAmount: amount,
        allowanceAmount: amount,
        purchasedCreditAmount: microsToMoney(0n),
        purchasedCreditReservationTransactionId: null,
      });
      await tx.insert(providerAdmissions).values({
        organization_id: scope.organizationId,
        operation_kind: "app_inference",
        operation_id: allowance.reservation.id,
        admitted_at: now,
      });
      return {
        logicalOperationId: input.logicalOperationId,
        scopeId: scope.scopeId,
        allowanceReservationId: allowance.reservation.id,
        infrastructureReservationId: infrastructure.reservation.id,
        status: allowance.reservation.status,
        reservedAmountUsd: amount,
        validUntil,
        dispatchGranted: true,
      };
    });
    if (result.dispatchGranted)
      await creditsService.invalidateCreditCaches(input.actor.developerOrganizationId);
    return result;
  }

  /** Rechecks the primary authority immediately before the winning executor invokes inference. */
  async assertDispatchCurrent(input: AppInferenceFundingRequest): Promise<void> {
    const amount = validateRequest(input);
    await writeTransaction(async (tx) => {
      const scope = await scopeForActor(tx, input.actor);
      await requireMember(tx, input.actor);
      const pair = await findPair(tx, scope, input);
      if (!pair) fail("RESERVATION", "Original app funding reservation is unavailable");
      assertPair(pair, requestDigests(scope, input, amount), amount);
      const now = await readPostLockDatabaseNow(tx);
      const [entitlement] = await tx
        .select()
        .from(organizationEntitlements)
        .where(
          and(
            eq(organizationEntitlements.organization_id, scope.organizationId),
            eq(organizationEntitlements.billing_scope_id, scope.scopeId),
          ),
        )
        .for("update");
      const [admission] = await tx
        .select({ id: providerAdmissions.id })
        .from(providerAdmissions)
        .where(
          and(
            eq(providerAdmissions.organization_id, scope.organizationId),
            eq(providerAdmissions.operation_kind, "app_inference"),
            eq(providerAdmissions.operation_id, pair.allowance.id),
            isNull(providerAdmissions.released_at),
          ),
        )
        .for("update");
      if (
        pair.allowance.status !== "reserved" ||
        pair.infrastructure.expires_at <= now ||
        pair.allowance.expires_at <= now ||
        !entitlement ||
        !entitlement.entitlement_effective ||
        entitlement.access !== "granted" ||
        entitlement.effective_from > now ||
        !entitlement.effective_until ||
        entitlement.effective_until <= now ||
        !entitlement.features.includes("inference") ||
        !admission
      )
        fail(
          "DISPATCH_EXPIRED",
          "App subscription authority expired or changed before inference dispatch",
        );
    });
  }

  async settle(
    input: AppInferenceFundingRequest & { actualAmountUsd: string },
  ): Promise<AppInferenceFundingSettlement> {
    return this.finish(input, "settlement");
  }
  async release(input: AppInferenceFundingRequest): Promise<AppInferenceFundingSettlement> {
    return this.finish({ ...input, actualAmountUsd: "0.000000" }, "cancellation");
  }
  private async finish(
    input: AppInferenceFundingRequest & { actualAmountUsd: string },
    kind: "settlement" | "cancellation",
  ) {
    const amount = validateRequest(input);
    const actual = microsToMoney(moneyToMicros(input.actualAmountUsd, "actualAmountUsd"));
    const result = await writeTransaction(async (tx) => {
      // Completion must remain possible after membership revocation or expiry, using the bound original operation.
      const scope = await scopeForActor(tx, input.actor, true);
      const pair = await findPair(tx, scope, input);
      if (!pair) fail("RESERVATION", "Original app funding reservation is unavailable");
      assertPair(pair, requestDigests(scope, input, amount), amount);
      const cap = capSubscriptionFundingSettlement({
        requestedActualAmount: actual,
        reservedAmount: amount,
      });
      const terminalDigest = settlementDigest({
        actor: input.actor,
        operation: input.logicalOperationId,
        requestDigest: input.requestDigest,
        kind,
        actual,
      });
      const allowanceDigest = settlementDigest({ terminalDigest, leg: "customer_allowance" });
      const infrastructureDigest = settlementDigest({
        terminalDigest,
        leg: "developer_infrastructure",
      });
      const expectedStatus = kind === "settlement" ? "finalized" : "canceled";
      const locked = await subscriptionFundingReservationsRepository.lockById(
        tx,
        scope.organizationId,
        pair.infrastructure.id,
      );
      const cash = locked.allocations.find(
        (allocation) => allocation.source === "purchased_credit",
      );
      if (!cash?.purchased_credit_reservation_transaction_id)
        fail("PAIR_CONFLICT", "Developer infrastructure reservation has no original debit");
      if (pair.allowance.status !== "reserved") {
        const stored = (row: BillingFundingReservation) =>
          kind === "settlement" ? row.settlement_digest : row.cancellation_digest;
        if (
          pair.allowance.status !== expectedStatus ||
          stored(pair.allowance) !== allowanceDigest ||
          stored(pair.infrastructure) !== infrastructureDigest
        )
          fail("REPLAY_CONFLICT", "Funding has a different terminal result");
        return {
          status: expectedStatus,
          replayed: true,
          collectedAmountUsd: cap.collectedAmount,
          uncollectedOverageUsd: cap.uncollectedOverageAmount,
          infrastructureDebitTransactionId: cash.purchased_credit_reservation_transaction_id,
          infrastructureRefundTransactionId: cash.purchased_credit_refund_transaction_id,
        } as const;
      }
      const now = await readPostLockDatabaseNow(tx);
      const refundAmount =
        moneyToMicros(amount, "amount") - moneyToMicros(cap.collectedAmount, "collectedAmount");
      let refundId: string | null = null;
      if (refundAmount > 0n) {
        const refund = await creditsService.refundCredits({
          organizationId: scope.organizationId,
          amount: microsToMoney(refundAmount),
          description: "App subscription inference infrastructure release",
          metadata: {
            appId: scope.appId,
            billingScopeId: scope.scopeId,
            logicalOperationId: input.logicalOperationId,
          },
          stripePaymentIntentId: `app-infrastructure-release:${infrastructureDigest}`,
          db: tx,
          deferCacheInvalidation: true,
        });
        refundId = refund.transaction.id;
      }
      const common = {
        organizationId: scope.organizationId,
        reservationId: pair.allowance.id,
        billingScope: scopeBinding(scope),
        idempotencyKey: `app-usage:${allowanceDigest}`,
        requestDigest: allowanceDigest,
        purchasedCreditSettlementTransactionId: null,
        purchasedCreditRefundTransactionId: null,
      };
      if (kind === "cancellation") await subscriptionAllowanceRepository.cancel(tx, common);
      else
        await subscriptionAllowanceRepository.finalize(tx, {
          ...common,
          actualAllowanceAmount: cap.collectedAmount,
          actualPurchasedCreditAmount: microsToMoney(0n),
          uncollectedOverageAmount: cap.uncollectedOverageAmount,
        });
      await subscriptionFundingReservationsRepository.persistTerminal(tx, locked, {
        kind,
        key: `app-infra:${infrastructureDigest}`,
        digest: infrastructureDigest,
        actualAllowanceAmount: microsToMoney(0n),
        actualPurchasedCreditAmount: cap.collectedAmount,
        uncollectedOverageAmount: cap.uncollectedOverageAmount,
        allowanceExpired: false,
        purchasedCreditSettlementTransactionId:
          moneyToMicros(cap.collectedAmount, "collectedAmount") > 0n
            ? cash.purchased_credit_reservation_transaction_id
            : null,
        purchasedCreditRefundTransactionId: refundId,
        databaseNow: now,
      });
      await tx
        .update(providerAdmissions)
        .set({ released_at: now })
        .where(
          and(
            eq(providerAdmissions.organization_id, scope.organizationId),
            eq(providerAdmissions.operation_kind, "app_inference"),
            eq(providerAdmissions.operation_id, pair.allowance.id),
            isNull(providerAdmissions.released_at),
          ),
        );
      return {
        status: expectedStatus,
        replayed: false,
        collectedAmountUsd: cap.collectedAmount,
        uncollectedOverageUsd: cap.uncollectedOverageAmount,
        infrastructureDebitTransactionId: cash.purchased_credit_reservation_transaction_id,
        infrastructureRefundTransactionId: refundId,
      } as const;
    });
    if (!result.replayed)
      await creditsService.invalidateCreditCaches(input.actor.developerOrganizationId);
    return result;
  }
}
export const appInferenceFundingService = new AppInferenceFundingService();
