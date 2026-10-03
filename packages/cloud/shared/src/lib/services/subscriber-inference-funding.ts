/**
 * Deferred allowance-first funding for subscriber inference on the Worker.
 *
 * Admission reserves only the organization's Durable Object lease against the
 * subscriber's funding capacity: purchased credit plus currently spendable
 * allowance, fenced by the organization balance revision (migration 0491 makes
 * every platform allowance change advance it). After the provider responds, one
 * primary transaction reserves and settles the exact charge allowance-first
 * under the request's retry-stable funding key, then reads the post-accounting
 * capacity in that same transaction for the gate settlement. Live settlement and
 * alarm recovery share the key, so a replay never funds a request twice.
 *
 * Affiliate-marked requests pin their payout contract at admission. The same
 * funding transaction enqueues the collected affiliate markup, so the payout
 * commits atomically with the debit and a replay never pays twice.
 */

import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { writeTransaction } from "../../db/helpers";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { readEligibleSubscriptionAllowance } from "../../db/repositories/subscription-allowance-eligibility";
import { billingFundingReservations } from "../../db/schemas/billing-funding-reservations";
import { organizations } from "../../db/schemas/organizations";
import { logger } from "../utils/logger";
import type { AffiliateBillingAttribution } from "./affiliate-billing-attribution";
import { AFFILIATE_PAYOUT_CONTRACT_VERSION } from "./affiliate-payout-outbox";
import { canonicalFundingAmount, subscriptionFundingOperationKey } from "./allowance-first-credits";
import {
  type CreditReconciliationResult,
  creditsService,
  RESERVATION_SWEEP_GRACE_MS,
} from "./credits";
import {
  type OrganizationQuotaPolicy,
  requireOrganizationPolicyBalance,
} from "./organization-quota-policy";
import { subscriptionFundingService } from "./subscription-funding";

/** Subscriber funding capacity at one organization balance revision. */
export interface SubscriberFundingCapacity {
  balanceUsd: number;
  balanceRevision: string;
}

export interface SubscriberInferenceCharge {
  organizationId: string;
  requestId: string;
  userId: string;
  model: string;
  provider: string;
  billingSource: string;
  description: string;
  metadata?: Record<string, unknown>;
  /** Marked-up charge (affiliate markup included when `affiliatePayout` is set). */
  amountUsd: number;
  /** Payout contract pinned before provider dispatch. */
  affiliatePayout?: {
    attribution: AffiliateBillingAttribution;
    sourceId: string;
  };
}

export interface SubscriberInferenceFundingResult {
  reconciliation: CreditReconciliationResult;
  capacity: SubscriberFundingCapacity;
}

function invalidCapacity(organizationId: string, field: string): never {
  throw new ElizaError("Subscriber funding capacity is invalid", {
    code: "SUBSCRIBER_FUNDING_CAPACITY_INVALID",
    context: { organizationId, field },
    severity: "fatal",
  });
}

function capacityFrom(
  organizationId: string,
  creditBalance: string | number,
  revision: string,
  allowanceAvailable: string | undefined,
): SubscriberFundingCapacity {
  const credit = new Decimal(creditBalance);
  const allowance = new Decimal(allowanceAvailable ?? 0);
  if (!credit.isFinite()) invalidCapacity(organizationId, "credit_balance");
  if (!allowance.isFinite() || allowance.isNegative())
    invalidCapacity(organizationId, "allowance_available");
  if (!/^(0|[1-9]\d*)$/.test(revision)) invalidCapacity(organizationId, "balance_revision");
  // A negative purchased balance funds nothing; allowance stays spendable.
  const balanceUsd = Decimal.max(credit, 0).plus(allowance).toNumber();
  if (!Number.isFinite(balanceUsd) || balanceUsd < 0) invalidCapacity(organizationId, "capacity");
  return { balanceUsd, balanceRevision: revision };
}

/**
 * Reads subscriber funding capacity in the caller's transaction. With an
 * already-read policy, its credit balance, revision and clock are reused so the
 * only added reads are the allowance eligibility checks.
 */
export async function readSubscriberFundingCapacityInTransaction(
  tx: DbTransaction,
  organizationId: string,
  options: { policy?: OrganizationQuotaPolicy; now?: Date } = {},
): Promise<SubscriberFundingCapacity> {
  if (options.policy) {
    const balance = requireOrganizationPolicyBalance(options.policy);
    const allowance = await readEligibleSubscriptionAllowance(
      tx,
      organizationId,
      new Date(options.policy.observedAt),
      false,
      options.policy,
    );
    return capacityFrom(
      organizationId,
      balance.balanceUsd,
      balance.revision,
      allowance?.available_amount,
    );
  }
  const [org] = await tx
    .select({
      credit_balance: organizations.credit_balance,
      balance_revision: organizations.balance_revision,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!org) invalidCapacity(organizationId, "organization");
  const now = options.now ?? (await readPostLockDatabaseNow(tx));
  const allowance = await readEligibleSubscriptionAllowance(tx, organizationId, now, false);
  return capacityFrom(
    organizationId,
    org.credit_balance,
    String(org.balance_revision),
    allowance?.available_amount,
  );
}

/**
 * Funds one completed subscriber inference allowance first, capped at the
 * capacity available under the organization lock. Any remainder is reported as
 * an uncollected overage, matching the synchronous lane's never-overcharge
 * policy. Replays return the original funding result.
 */
export async function fundSubscriberInferenceCharge(
  input: SubscriberInferenceCharge,
): Promise<SubscriberInferenceFundingResult> {
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
    throw new ElizaError("Subscriber inference charge must be positive", {
      code: "SUBSCRIPTION_FUNDING_INVALID_AMOUNT",
      context: { organizationId: input.organizationId, requestId: input.requestId },
      severity: "fatal",
    });
  }
  const logicalOperationId = await subscriptionFundingOperationKey(
    "inference-gate:",
    input.requestId,
  );
  const requested = new Decimal(canonicalFundingAmount(input.amountUsd));
  const metadata = {
    ...(input.metadata ?? {}),
    requestId: input.requestId,
    userId: input.userId,
    model: input.model,
    provider: input.provider,
    billingSource: input.billingSource,
    admission: "durable_object_subscription_funding",
    ...(input.affiliatePayout && {
      affiliatePayout: {
        version: AFFILIATE_PAYOUT_CONTRACT_VERSION,
        sourceId: input.affiliatePayout.sourceId,
        attribution: input.affiliatePayout.attribution,
        model: input.model,
      },
    }),
  };
  // Settlement may be capped to the funded amount; the payout is computed
  // against the full marked-up charge so uncollected markup is never paid.
  const payoutActualAmount = requested.toFixed(6);
  const outcome = await writeTransaction(async (tx) => {
    const [org] = await tx
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) invalidCapacity(input.organizationId, "organization");
    const now = await readPostLockDatabaseNow(tx);
    const [existing] = await tx
      .select()
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.organization_id, input.organizationId),
          eq(billingFundingReservations.logical_operation_id, logicalOperationId),
        ),
      )
      .for("update");
    let collected = new Decimal(0);
    let reservationId: string | null = null;
    let purchasedCreditDebited = false;
    let purchasedCreditRefunded = false;
    let replayed = false;
    let actualCost = input.amountUsd;
    if (existing) {
      replayed = true;
      reservationId = existing.id;
      if (existing.status === "reserved") {
        // A reservation without its settlement cannot be produced by this
        // lane's single transaction; finish it at its own reserved amount.
        const settled = await subscriptionFundingService.settleInTransaction(tx, {
          organizationId: input.organizationId,
          logicalOperationId,
          operation: "ai_inference",
          actualAmount: existing.requested_amount,
          occurredAt: existing.created_at,
          metadata,
          payoutActualAmount,
        });
        purchasedCreditRefunded = settled.purchasedCreditRefunded;
        collected = new Decimal(settled.collectedAmount);
      } else if (existing.status === "finalized") {
        collected = new Decimal(existing.requested_amount);
        if (collected.isZero()) {
          actualCost = new Decimal(existing.uncollected_overage_amount).toNumber();
        }
      }
    } else {
      const allowance = await readEligibleSubscriptionAllowance(
        tx,
        input.organizationId,
        now,
        true,
      );
      const available = Decimal.max(new Decimal(org.credit_balance), 0).plus(
        allowance?.available_amount ?? 0,
      );
      const funded = Decimal.min(requested, available).toDecimalPlaces(6, Decimal.ROUND_DOWN);
      if (funded.gt(0)) {
        const reserved = await subscriptionFundingService.reserveInTransaction(tx, {
          organizationId: input.organizationId,
          logicalOperationId,
          operation: "ai_inference",
          amount: funded.toFixed(6),
          description: input.description,
          reservationTtlMs: RESERVATION_SWEEP_GRACE_MS,
          metadata,
        });
        await subscriptionFundingService.settleInTransaction(tx, {
          organizationId: input.organizationId,
          logicalOperationId,
          operation: "ai_inference",
          actualAmount: reserved.reservation.requested_amount,
          occurredAt: reserved.reservation.created_at,
          metadata,
          payoutActualAmount,
        });
        reservationId = reserved.reservation.id;
        purchasedCreditDebited = reserved.purchasedCreditDebited;
        collected = funded;
      } else {
        const receipt = await subscriptionFundingService.recordUnfundedInferenceInTransaction(tx, {
          organizationId: input.organizationId,
          logicalOperationId,
          actualAmount: requested.toFixed(6),
          reservationTtlMs: RESERVATION_SWEEP_GRACE_MS,
        });
        reservationId = receipt.id;
      }
    }
    const capacity = await readSubscriberFundingCapacityInTransaction(tx, input.organizationId, {
      now,
    });
    return {
      collected,
      actualCost,
      reservationId,
      replayed,
      capacity,
      invalidate: purchasedCreditDebited || purchasedCreditRefunded,
    };
  });
  if (outcome.invalidate) {
    await creditsService.invalidateCreditCaches(input.organizationId);
  }
  const uncollected = new Decimal(canonicalFundingAmount(outcome.actualCost)).minus(
    outcome.collected,
  );
  if (uncollected.gt(0) && !outcome.replayed) {
    logger.warn("[SubscriberInferenceFunding] capacity could not fund the full inference charge", {
      organizationId: input.organizationId,
      requestId: input.requestId,
      requestedUsd: requested.toFixed(6),
      collectedUsd: outcome.collected.toFixed(6),
    });
  }
  const collectedUsd = outcome.collected.toNumber();
  return {
    reconciliation: {
      reservedAmount: collectedUsd,
      actualCost: outcome.actualCost,
      collectedAmount: collectedUsd,
      reservationTransactionId: outcome.reservationId,
      settlementTransactionIds: outcome.reservationId ? [outcome.reservationId] : [],
      adjustmentType: uncollected.gt(0) ? "uncollected_overage" : "none",
    },
    capacity: outcome.capacity,
  };
}
