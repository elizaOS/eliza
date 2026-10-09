/** Persists elapsed container charges and their atomic credit and earnings ledgers. */

import Decimal from "decimal.js";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import {
  fundAllowanceEligibleChargeInTransaction,
  isAllowanceFirstOrganizationInTransaction,
} from "../../lib/services/allowance-first-credits";
import { creditsService } from "../../lib/services/credits";
import { logger } from "../../lib/utils/logger";
import { type DbTransaction, dbRead, dbWrite } from "../client";
import { billingFundingAllocations } from "../schemas/billing-funding-reservations";
import { containerComputeStopIntents } from "../schemas/compute-stop-intents";
import { containerBillingRecords, containers } from "../schemas/containers";
import { creditTransactions } from "../schemas/credit-transactions";
import { organizations } from "../schemas/organizations";
import { redeemableEarnings, redeemableEarningsLedger } from "../schemas/redeemable-earnings";
import { users } from "../schemas/users";
import { settleComputeRateSegments } from "./compute-billing-segments";
import { parseContainerBillingNumber } from "./container-billing-numeric";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { observeSubscriptionAllowanceEligibility } from "./subscription-allowance-eligibility";

export type ContainerBillingStatus = "active" | "warning" | "suspended" | "shutdown_pending";

/**
 * Exact durable witness that a provider stop may already have crossed the
 * control-plane boundary even though its intent proof transaction rolled back.
 *
 * The job marker is written in its own committed claim transaction before
 * provider I/O. Match the full tenant/intent/lifecycle envelope so unrelated
 * or poisoned jobs cannot suppress billing for another container. Active
 * intents only: a dispatcher may legitimately write the marker and then mark
 * the intent superseded before any provider call.
 */
export function unreconciledContainerStopProviderEffectExistsSql(
  organizationId: string | SQLWrapper,
  containerId: string | SQLWrapper,
) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM "container_compute_stop_intents" AS "provider_effect_intent"
    INNER JOIN "jobs" AS "provider_effect_job"
      ON "provider_effect_job"."id" = "provider_effect_intent"."job_id"
     AND "provider_effect_job"."organization_id" = "provider_effect_intent"."organization_id"
     AND "provider_effect_job"."type" = 'container_stop'
     AND "provider_effect_job"."data_storage" = 'inline'
     AND "provider_effect_job"."data_key" IS NULL
    WHERE "provider_effect_intent"."organization_id" = ${organizationId}
      AND "provider_effect_intent"."container_id" = ${containerId}
      AND "provider_effect_intent"."provider_confirmed_at" IS NULL
      AND "provider_effect_intent"."status" IN
        ('pending', 'dispatching', 'retry', 'terminal_attention')
      AND jsonb_typeof("provider_effect_job"."data") = 'object'
      AND "provider_effect_job"."data" ? 'providerEffectStartedAt'
      AND jsonb_typeof(
        "provider_effect_job"."data" -> 'providerEffectStartedAt'
      ) = 'string'
      AND lower("provider_effect_job"."data" ->> 'containerId') =
        "provider_effect_intent"."container_id"::text
      AND lower("provider_effect_job"."data" ->> 'organizationId') =
        "provider_effect_intent"."organization_id"::text
      AND lower("provider_effect_job"."data" ->> 'intentId') =
        "provider_effect_intent"."id"::text
      AND "provider_effect_job"."data" ->> 'lifecycleRevision' =
        "provider_effect_intent"."lifecycle_revision"::text
  )`;
}

function exactBillingDecimal(
  value: string | number | null | undefined,
  fieldName: string,
): Decimal {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(`Unable to read container billing ${fieldName}: value is empty or missing`);
  }
  const parsed = new Decimal(String(value));
  if (!parsed.isFinite()) {
    throw new Error(`Unable to read container billing ${fieldName}: value is not finite`);
  }
  return parsed;
}

/**
 * Allowance an allowance-first subscriber can apply to container compute, or
 * null when the organization bills on the purchased-credit lane. An
 * unresolvable subscription authority (for example a paid-work fence during
 * account deletion) keeps the purchased-credit lane so terminal settlement
 * never depends on subscription authority.
 */
export async function readContainerComputeAllowanceInTransaction(
  tx: DbTransaction,
  organizationId: string,
): Promise<Decimal | null> {
  if (!(await isAllowanceFirstOrganizationInTransaction(tx, organizationId))) return null;
  const eligibility = await observeSubscriptionAllowanceEligibility(
    tx,
    organizationId,
    await readPostLockDatabaseNow(tx),
  );
  if (eligibility.status === "unavailable") {
    // error-policy:J4 unavailable subscription authority selects the cash lane.
    logger.warn("[ContainerBilling] Subscription allowance unavailable; using purchased credits", {
      organizationId,
      code: eligibility.code,
    });
    return null;
  }
  return eligibility.period
    ? exactBillingDecimal(eligibility.period.available_amount, "allowance available_amount")
    : new Decimal(0);
}

export interface BillableContainer {
  id: string;
  name: string;
  project_name: string;
  organization_id: string;
  user_id: string;
  status: string;
  billing_status: string;
  desired_count: number;
  cpu: number;
  memory: number;
  shutdown_warning_sent_at: Date | null;
  scheduled_shutdown_at: Date | null;
  total_billed: string;
  last_billed_at: Date | null;
  next_billing_at: Date | null;
  created_at: Date;
}

export interface ContainerBillingOrganization {
  id: string;
  name: string;
  credit_balance: string;
  billing_email: string | null;
  pay_as_you_go_from_earnings: boolean;
  /**
   * Subscription allowance available to container compute (6dp string);
   * "0.000000" for organizations on the purchased-credit lane.
   */
  subscription_allowance_available: string;
}

export interface RecordBillingFailureInput {
  containerId: string;
  organizationId: string;
  amount: number;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  errorMessage: string;
}

export interface RecordSuccessfulBillingInput {
  containerId: string;
  organizationId: string;
  userId: string;
  containerName: string;
  dailyRate: number;
  earningsSourceUserId: string | null;
  payAsYouGoFromEarnings: boolean;
  /** @deprecated Compatibility-only route-test fields; repository ignores them. */
  dailyCost?: number;
  /** @deprecated Compatibility-only route-test fields; repository ignores them. */
  newBalance: number;
  /** @deprecated Compatibility-only route-test fields; repository ignores them. */
  fromEarnings?: number;
  /** @deprecated Compatibility-only route-test fields; repository ignores them. */
  fromCredits?: number;
  /** Wall-clock time of this billing run (used for the row-lock period guard). */
  now: Date;
}

export interface RecordSuccessfulBillingResult {
  newBalance: number;
  transactionId: string | null;
  alreadyBilled: boolean;
  insufficient?: boolean;
  /** The terminal lifecycle interval was audited but could not be collected. */
  uncollected?: boolean;
  amount?: number;
  fromEarnings?: number;
  /** Portion funded from the subscription allowance (allowance-first lane). */
  fromAllowance?: number;
  /** Allowance still available after this charge; absent on the purchased-credit lane. */
  allowanceRemaining?: number;
  /** Finalized allowance-first funding reservation that receipts this charge. */
  fundingReservationId?: string | null;
  /** The caller must invalidate credit caches after committing this charge. */
  creditCachesStale?: boolean;
}

export class ContainerBillingRepository {
  /**
   * Containers due for billing as of `now`. Gating on `next_billing_at` (set
   * to the end of the last billed period) makes the cron idempotent for the
   * common case: a same-day re-run skips containers whose period is already
   * paid. `null` means never billed → due immediately.
   */
  async listBillableContainers(now: Date): Promise<BillableContainer[]> {
    return await dbRead
      .select({
        id: containers.id,
        name: containers.name,
        project_name: containers.project_name,
        organization_id: containers.organization_id,
        user_id: containers.user_id,
        status: containers.status,
        billing_status: containers.billing_status,
        desired_count: containers.desired_count,
        cpu: containers.cpu,
        memory: containers.memory,
        shutdown_warning_sent_at: containers.shutdown_warning_sent_at,
        scheduled_shutdown_at: containers.scheduled_shutdown_at,
        total_billed: containers.total_billed,
        last_billed_at: containers.last_billed_at,
        next_billing_at: containers.next_billing_at,
        created_at: containers.created_at,
      })
      .from(containers)
      .where(
        and(
          inArray(containers.status, ["running", "deleting"]),
          inArray(containers.billing_status, ["active", "warning", "shutdown_pending"]),
          or(isNull(containers.next_billing_at), lte(containers.next_billing_at, now)),
          // Replica discovery is only a best-effort filter; the canonical
          // writer repeats this proof fence under row locks below.
          notExists(
            dbRead
              .select({ id: containerComputeStopIntents.id })
              .from(containerComputeStopIntents)
              .where(
                and(
                  eq(containerComputeStopIntents.organization_id, containers.organization_id),
                  eq(containerComputeStopIntents.container_id, containers.id),
                  isNotNull(containerComputeStopIntents.provider_confirmed_at),
                ),
              ),
          ),
          // A committed provider-effect admission is a conservative absence
          // cutoff until the daemon reconciles it to proof or a safe
          // supersession. Do not discover it for another billing pass.
          sql`NOT (${unreconciledContainerStopProviderEffectExistsSql(
            containers.organization_id,
            containers.id,
          )})`,
        ),
      );
  }

  async listBillingOrganizations(
    organizationIds: string[],
  ): Promise<ContainerBillingOrganization[]> {
    if (organizationIds.length === 0) return [];

    const rows = await dbRead
      .select({
        id: organizations.id,
        name: organizations.name,
        credit_balance: organizations.credit_balance,
        pay_as_you_go_from_earnings: organizations.pay_as_you_go_from_earnings,
        billing_email: organizations.billing_email,
      })
      .from(organizations)
      .where(inArray(organizations.id, organizationIds));
    // Discovery-only view of subscriber allowance so the cron's warning gate
    // counts every funding source. The writer re-derives it under locks.
    const withAllowance: ContainerBillingOrganization[] = [];
    for (const row of rows) {
      const allowance = await dbRead.transaction((tx) =>
        readContainerComputeAllowanceInTransaction(tx, row.id),
      );
      withAllowance.push({
        ...row,
        subscription_allowance_available: (allowance ?? new Decimal(0)).toFixed(6),
      });
    }
    return withAllowance;
  }

  async suspendContainer(containerId: string, organizationId: string, now: Date): Promise<void> {
    await dbWrite
      .update(containers)
      .set({
        status: "stopped",
        billing_status: "suspended" as ContainerBillingStatus,
        updated_at: now,
      })
      .where(and(eq(containers.id, containerId), eq(containers.organization_id, organizationId)));
  }

  async scheduleShutdownWarning(
    containerId: string,
    organizationId: string,
    now: Date,
    shutdownTime: Date,
  ): Promise<boolean> {
    const [scheduled] = await dbWrite
      .update(containers)
      .set({
        billing_status: "shutdown_pending" as ContainerBillingStatus,
        shutdown_warning_sent_at: now,
        scheduled_shutdown_at: shutdownTime,
        updated_at: now,
      })
      .where(
        and(
          eq(containers.id, containerId),
          eq(containers.organization_id, organizationId),
          eq(containers.status, "running"),
          inArray(containers.billing_status, ["active", "warning"]),
          // Discovery may be replica-stale. Never regress a provider-fenced
          // runtime back to shutdown_pending or publish its warning effects.
          notExists(
            dbWrite
              .select({ id: containerComputeStopIntents.id })
              .from(containerComputeStopIntents)
              .where(
                and(
                  eq(containerComputeStopIntents.organization_id, organizationId),
                  eq(containerComputeStopIntents.container_id, containerId),
                  isNotNull(containerComputeStopIntents.provider_confirmed_at),
                ),
              ),
          ),
          sql`NOT (${unreconciledContainerStopProviderEffectExistsSql(
            organizationId,
            containerId,
          )})`,
        ),
      )
      .returning({ id: containers.id });
    return scheduled !== undefined;
  }

  async recordBillingFailure(input: RecordBillingFailureInput): Promise<void> {
    await dbWrite.insert(containerBillingRecords).values({
      container_id: input.containerId,
      organization_id: input.organizationId,
      amount: String(input.amount),
      billing_period_start: input.billingPeriodStart,
      billing_period_end: input.billingPeriodEnd,
      status: "insufficient_credits",
      error_message: input.errorMessage,
      created_at: input.billingPeriodStart,
    });
  }

  async recordSuccessfulDailyBilling(
    input: RecordSuccessfulBillingInput,
  ): Promise<RecordSuccessfulBillingResult> {
    const result = await dbWrite.transaction(async (tx) =>
      this.recordSuccessfulDailyBillingInTransaction(tx, input),
    );
    if (result.creditCachesStale) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return result;
  }

  /** Shared atomic debit/receipt writer for cron and funded lifecycle fences. */
  async recordSuccessfulDailyBillingInTransaction(
    tx: DbTransaction,
    input: RecordSuccessfulBillingInput,
    options: {
      forceLifecycleSettlement?: boolean;
      terminalInsufficientDisposition?: "uncollected";
    } = {},
  ): Promise<RecordSuccessfulBillingResult> {
    if (options.terminalInsufficientDisposition && !options.forceLifecycleSettlement) {
      throw new Error("Terminal container settlement requires a lifecycle settlement fence");
    }
    // Idempotency guard: lock the container row and re-check whether it has
    // already been billed for this period. `next_billing_at` is the end of
    // the period last charged; if it is still in the future, the period is
    // paid — skip without touching any balance. This closes the read→write
    // race between listBillableContainers and this write (e.g. two concurrent
    // cron invocations both selecting the container before either commits).
    const [locked] = await tx
      .select({
        status: containers.status,
        billing_status: containers.billing_status,
        last_billed_at: containers.last_billed_at,
        next_billing_at: containers.next_billing_at,
        created_at: containers.created_at,
      })
      .from(containers)
      .where(
        and(
          eq(containers.id, input.containerId),
          eq(containers.organization_id, input.organizationId),
        ),
      )
      .for("update");

    // `listBillableContainers` may read from a lagging replica. Re-check the
    // provider absence proof on the writer after locking the workload and lock
    // the active intent before any settlement/debit. A provider-confirmed
    // runtime must never be billed even if publishing billing_status=suspended
    // failed in its own savepoint.
    const [providerProofIntent] =
      locked && !options.forceLifecycleSettlement
        ? await tx
            .select({ id: containerComputeStopIntents.id })
            .from(containerComputeStopIntents)
            .where(
              and(
                eq(containerComputeStopIntents.organization_id, input.organizationId),
                eq(containerComputeStopIntents.container_id, input.containerId),
                or(
                  isNotNull(containerComputeStopIntents.provider_confirmed_at),
                  unreconciledContainerStopProviderEffectExistsSql(
                    input.organizationId,
                    input.containerId,
                  ),
                ),
              ),
            )
            .for("update")
            .limit(1)
        : [undefined];

    if (
      !locked ||
      providerProofIntent ||
      (!options.forceLifecycleSettlement &&
        (!["running", "deleting"].includes(locked.status) ||
          !["active", "warning", "shutdown_pending"].includes(locked.billing_status) ||
          (locked.next_billing_at !== null && locked.next_billing_at > input.now)))
    ) {
      const [org] = await tx
        .select({ credit_balance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId));
      return {
        // Row present but the NUMERIC read is corrupt → fail closed with a
        // field-named error instead of returning a NaN balance. Row absent
        // (org concurrently deleted) keeps the caller-computed fallback.
        newBalance: org ? parseContainerBillingNumber(org.credit_balance, "credit_balance") : 0,
        transactionId: null,
        alreadyBilled: true,
        insufficient: false,
        amount: 0,
        fromEarnings: 0,
      };
    }

    const periodStart = locked.last_billed_at ?? locked.created_at;
    const elapsedMs = input.now.getTime() - periodStart.getTime();
    if (elapsedMs <= 0) {
      return {
        newBalance: 0,
        transactionId: null,
        alreadyBilled: true,
        insufficient: false,
        amount: 0,
        fromEarnings: 0,
      };
    }
    const settled = await settleComputeRateSegments(tx, {
      organizationId: input.organizationId,
      workloadKind: "container",
      workloadId: input.containerId,
      periodStart,
      periodEnd: input.now,
    });
    const amount = settled.amount;
    const effectiveDailyRate = amount
      .mul(24 * 60 * 60 * 1000)
      .div(elapsedMs)
      .toDecimalPlaces(6, Decimal.ROUND_HALF_UP);

    const [lockedOrg] = await tx
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!lockedOrg) throw new Error("Billing organization not found");

    let earningsRow: typeof redeemableEarnings.$inferSelect | null = null;
    if (input.payAsYouGoFromEarnings && input.earningsSourceUserId) {
      const [tenantUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, input.earningsSourceUserId),
            eq(users.organization_id, input.organizationId),
          ),
        )
        .limit(1);
      if (!tenantUser)
        throw new Error("Earnings source user is not a member of the billing tenant");
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${input.earningsSourceUserId}`}))`,
      );
      [earningsRow] = await tx
        .select()
        .from(redeemableEarnings)
        .where(eq(redeemableEarnings.user_id, input.earningsSourceUserId))
        .for("update")
        .limit(1);
    }

    const creditAvailable = exactBillingDecimal(lockedOrg.credit_balance, "credit_balance");
    const earningsAvailable = earningsRow
      ? exactBillingDecimal(earningsRow.available_balance, "available_balance")
      : new Decimal(0);

    const recordTerminalUncollected = async (): Promise<RecordSuccessfulBillingResult> => {
      await tx
        .update(containers)
        .set({
          // The provider-confirmed lifecycle boundary is the terminal cursor.
          // Advancing it prevents a later restart from fabricating a collectible
          // debt for compute that no longer exists.
          last_billed_at: input.now,
          next_billing_at: null,
          updated_at: input.now,
        })
        .where(
          and(
            eq(containers.id, input.containerId),
            eq(containers.organization_id, input.organizationId),
          ),
        );
      await tx.insert(containerBillingRecords).values({
        container_id: input.containerId,
        organization_id: input.organizationId,
        amount: amount.toFixed(6),
        rate_segments: settled.segments,
        billing_period_start: periodStart,
        billing_period_end: input.now,
        status: "uncollected",
        credit_transaction_id: null,
        error_message: "Terminal container settlement exceeded available funding",
        created_at: input.now,
      });
      return {
        newBalance: creditAvailable.toNumber(),
        transactionId: null,
        alreadyBilled: false,
        insufficient: true,
        uncollected: true,
        amount: amount.toNumber(),
        fromEarnings: 0,
      };
    };

    // Allowance-first subscribers also fund the charge from their current
    // allowance period. The organization row lock above serializes every
    // allowance consumer, so this read stays exact until the funding below.
    const allowanceAvailable = await readContainerComputeAllowanceInTransaction(
      tx,
      input.organizationId,
    );
    if (
      creditAvailable
        .plus(allowanceAvailable ?? 0)
        .plus(earningsAvailable)
        .lt(amount)
    ) {
      if (options.terminalInsufficientDisposition === "uncollected") {
        return await recordTerminalUncollected();
      }
      return {
        newBalance: creditAvailable.toNumber(),
        transactionId: null,
        alreadyBilled: false,
        insufficient: true,
        amount: amount.toNumber(),
        fromEarnings: 0,
      };
    }

    // Earnings-first split (#22951): when the pay-as-you-go toggle is on, the
    // owner's redeemable earnings absorb the charge FIRST and purchased
    // credits only cover the remainder — the order `computeContainerBillingPlan`
    // (and every doc, schema comment, and UI string) promises. A credits-first
    // split here would silently invert the documented survival-economics rule.
    const earningsApplied = Decimal.min(earningsAvailable, amount);
    const creditApplied = amount.minus(earningsApplied);
    // Earnings are stored at 4dp while compute debt is authoritative at 6dp.
    // Convert enough earnings to cover the exact debt and leave sub-0.0001
    // change in canonical organization credits; rounding down would attempt
    // an unbacked credit debit for earnings-only tenants.
    const earningsConversion = earningsApplied.toDecimalPlaces(4, Decimal.ROUND_UP);
    if (earningsAvailable.lt(earningsConversion)) {
      if (options.terminalInsufficientDisposition === "uncollected") {
        return await recordTerminalUncollected();
      }
      return {
        newBalance: creditAvailable.toNumber(),
        transactionId: null,
        alreadyBilled: false,
        insufficient: true,
        amount: amount.toNumber(),
        fromEarnings: 0,
      };
    }
    if (earningsRow && earningsConversion.gt(0) && input.earningsSourceUserId) {
      const [updatedEarnings] = await tx
        .update(redeemableEarnings)
        .set({
          available_balance: sql`${redeemableEarnings.available_balance} - ${earningsConversion.toFixed(4)}`,
          total_converted_to_credits: sql`${redeemableEarnings.total_converted_to_credits} + ${earningsConversion.toFixed(4)}`,
          version: sql`${redeemableEarnings.version} + 1`,
          updated_at: input.now,
        })
        .where(eq(redeemableEarnings.user_id, input.earningsSourceUserId))
        .returning({ available_balance: redeemableEarnings.available_balance });
      if (!updatedEarnings) throw new Error("Earnings balance changed during compute charge");
      await tx.insert(redeemableEarningsLedger).values({
        user_id: input.earningsSourceUserId,
        entry_type: "credit_conversion",
        amount: earningsConversion.negated().toFixed(4),
        balance_after: updatedEarnings.available_balance,
        source_id: input.organizationId,
        description: `Container hosting: ${input.containerName}`,
        metadata: {
          transaction_type: "credit_conversion",
          idempotency_key: `container:${input.organizationId}:${input.containerId}:${periodStart.toISOString()}`,
          container_id: input.containerId,
          billing_period_start: periodStart.toISOString(),
          billing_period_end: input.now.toISOString(),
        },
      });
      await tx.insert(creditTransactions).values({
        organization_id: input.organizationId,
        user_id: input.userId,
        amount: earningsConversion.toFixed(6),
        type: "credit",
        description: `Earnings conversion for container hosting: ${input.containerName}`,
        metadata: {
          container_id: input.containerId,
          billing_type: "container_earnings_conversion",
          billing_period_start: periodStart.toISOString(),
          billing_period_end: input.now.toISOString(),
          earnings_source_user_id: input.earningsSourceUserId,
        },
        created_at: input.now,
      });
    }

    // Precedence for subscribers: earnings (pay-as-you-go toggle) first, then
    // the subscription allowance, then purchased credits. The non-earnings
    // remainder is funded allowance-first; everyone else keeps the direct
    // purchased-credit debit of the whole charge.
    const subscriptionFunded = allowanceAvailable !== null && creditApplied.gt(0);
    const cashDebit = subscriptionFunded ? earningsApplied : amount;
    const billingMetadata = {
      container_id: input.containerId,
      container_name: input.containerName,
      billing_type: "daily_container",
      billing_period_start: periodStart.toISOString(),
      billing_period_end: input.now.toISOString(),
      daily_rate: effectiveDailyRate.toFixed(6),
      rate_segments: settled.segments,
      paid_from_earnings: earningsApplied.toFixed(6),
      earnings_converted: earningsConversion.toFixed(6),
    };

    // Materialize the 4dp earnings conversion in canonical credits and debit
    // the exact 6dp cash-lane share in the same transaction. The relative
    // update preserves concurrent top-ups and leaves any conversion-rounding
    // change available instead of overcharging or fabricating an unbacked debit.
    let [updatedOrg] =
      !subscriptionFunded || earningsConversion.gt(0)
        ? await tx
            .update(organizations)
            .set({
              credit_balance: sql`${organizations.credit_balance} + ${earningsConversion.toFixed(6)} - ${cashDebit.toFixed(6)}`,
              updated_at: input.now,
            })
            .where(eq(organizations.id, input.organizationId))
            .returning({ credit_balance: organizations.credit_balance })
        : [undefined];

    // The conversion credit above plus this debit exactly reconcile to the
    // organization balance movement and retain the cash share as one receipt.
    const [creditTx] =
      !subscriptionFunded || cashDebit.gt(0)
        ? await tx
            .insert(creditTransactions)
            .values({
              organization_id: input.organizationId,
              user_id: input.userId,
              amount: cashDebit.negated().toFixed(6),
              type: "debit",
              description: `Daily container billing: ${input.containerName}`,
              metadata: subscriptionFunded
                ? { ...billingMetadata, paid_from_credits: "0.000000", subscription_funded: true }
                : { ...billingMetadata, paid_from_credits: creditApplied.toFixed(6) },
              created_at: input.now,
            })
            .returning()
        : [undefined];

    let fundingReservationId: string | null = null;
    let fromAllowance = new Decimal(0);
    let creditCachesStale = false;
    if (subscriptionFunded) {
      // Retry-stable per elapsed period: the locked cursor makes one charge
      // per (container, period start), and a rolled-back attempt leaves no
      // reservation behind.
      const funded = await fundAllowanceEligibleChargeInTransaction(tx, {
        organizationId: input.organizationId,
        operation: "container_compute",
        logicalOperationId: `container.${input.containerId}.${periodStart.getTime()}`,
        amount: creditApplied.toFixed(6),
        description: `Daily container billing: ${input.containerName}`,
        occurredAt: input.now,
        metadata: { ...billingMetadata, paid_from_subscription_funding: creditApplied.toFixed(6) },
      });
      fundingReservationId = funded.reservation.id;
      const [allowanceAllocation] = await tx
        .select({ finalized_amount: billingFundingAllocations.finalized_amount })
        .from(billingFundingAllocations)
        .where(
          and(
            eq(billingFundingAllocations.organization_id, input.organizationId),
            eq(billingFundingAllocations.reservation_id, funded.reservation.id),
            eq(billingFundingAllocations.source, "allowance"),
          ),
        );
      fromAllowance = allowanceAllocation
        ? exactBillingDecimal(allowanceAllocation.finalized_amount, "allowance finalized_amount")
        : new Decimal(0);
      creditCachesStale = funded.purchasedCreditDebited || earningsConversion.gt(0);
      [updatedOrg] = await tx
        .select({ credit_balance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId));
    }

    await tx
      .update(containers)
      .set({
        last_billed_at: input.now,
        next_billing_at: new Date(input.now.getTime() + 24 * 60 * 60 * 1000),
        billing_status: "active" as ContainerBillingStatus,
        shutdown_warning_sent_at: null,
        scheduled_shutdown_at: null,
        // Fail closed on a corrupt running total instead of writing "NaN"
        // back into the NUMERIC column (which would poison every future
        // billing run for this container via a rolled-back cast error).
        total_billed: sql`${containers.total_billed} + ${amount.toFixed(6)}`,
        updated_at: input.now,
      })
      .where(eq(containers.id, input.containerId));

    await tx.insert(containerBillingRecords).values({
      container_id: input.containerId,
      organization_id: input.organizationId,
      amount: amount.toFixed(6),
      rate_segments: settled.segments,
      billing_period_start: periodStart,
      billing_period_end: input.now,
      status: "success",
      credit_transaction_id: creditTx?.id ?? null,
      funding_reservation_id: fundingReservationId,
      created_at: input.now,
    });

    return {
      // Fail closed on a corrupt post-decrement balance read rather than
      // returning NaN (which the low-balance email would render as `$NaN`).
      // Row absent keeps the caller-computed fallback.
      newBalance: updatedOrg
        ? parseContainerBillingNumber(updatedOrg.credit_balance, "credit_balance")
        : 0,
      transactionId: creditTx?.id ?? null,
      alreadyBilled: false,
      insufficient: false,
      amount: amount.toNumber(),
      fromEarnings: earningsApplied.toNumber(),
      ...(allowanceAvailable !== null
        ? {
            fromAllowance: fromAllowance.toNumber(),
            allowanceRemaining: allowanceAvailable.minus(fromAllowance).toNumber(),
            fundingReservationId,
            creditCachesStale,
          }
        : {}),
    };
  }
}

export const containerBillingRepository = new ContainerBillingRepository();
