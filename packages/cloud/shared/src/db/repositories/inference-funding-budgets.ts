/** Canonical funding holds backing durable admission budgets. No debit occurs on consumption. */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";
import { enqueueCollectedAffiliatePayout } from "../../lib/services/affiliate-payout-outbox";
import { billingHoldService } from "../../lib/services/billing-hold";
import { creditsService } from "../../lib/services/credits";
import {
  budgetConsumptionPayload,
  budgetRequestDigest,
  budgetSealPayload,
  type InferenceFundingBudgetConsumption,
  type InferenceFundingBudgetGrant,
  type InferenceFundingBudgetSeal,
  verifyBudgetEffect,
} from "../../lib/services/inference-funding-budget-protocol";
import { readOrganizationQuotaPolicyInTransaction } from "../../lib/services/organization-quota-policy";
import { subscriptionFundingService } from "../../lib/services/subscription-funding";
import { sqlRows } from "../execute-helpers";
import { writeTransaction } from "../helpers";
import {
  inferenceFundingBudgetConsumptions as consumptions,
  inferenceFundingBudgetGrants as grants,
  inferenceFundingBudgetReceipts as receipts,
} from "../schemas/inference-funding-budgets";
import { organizations } from "../schemas/organizations";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { readEligibleSubscriptionAllowance } from "./subscription-allowance-eligibility";
import { microsToMoney, moneyToMicros } from "./subscription-funding-reservations";

export interface ReserveInferenceFundingBudget {
  organizationId: string;
  grantId: string;
  minimumMicros: string;
  targetMicros: string;
  policyGeneration: string;
  policyEpoch: string;
  ttlMs: number;
}
export type ReserveInferenceFundingBudgetResult =
  | { status: "granted"; grant: InferenceFundingBudgetGrant; replayed: boolean }
  | { status: "insufficient"; availableMicros: string; minimumMicros: string }
  | { status: "fenced" };
function fail(message: string, context: Record<string, unknown> = {}): never {
  throw new ElizaError(message, {
    code: "INFERENCE_FUNDING_BUDGET_CONFLICT",
    context,
    severity: "fatal",
  });
}
function micros(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) fail("Budget amounts must be integer micro-units");
  const amount = BigInt(value);
  microsToMoney(amount);
  return amount;
}
function dto(row: typeof grants.$inferSelect): InferenceFundingBudgetGrant {
  return {
    id: row.id,
    organizationId: row.organization_id,
    amountMicros: moneyToMicros(row.amount, "budget.amount").toString(),
    expiresAt: row.expires_at.getTime(),
    policyGeneration: row.policy_generation,
    policyEpoch: row.policy_epoch,
  };
}
function secret(): string {
  const value = getCloudAwareEnv().INFERENCE_FUNDING_BUDGET_SEAL_SECRET;
  if (!value) fail("Budget signing secret is not configured");
  return value;
}
const operationId = (grantId: string) => `inference-budget:${grantId}`;

export async function reserveBudget(
  input: ReserveInferenceFundingBudget,
): Promise<ReserveInferenceFundingBudgetResult> {
  const minimum = micros(input.minimumMicros),
    target = micros(input.targetMicros);
  if (minimum === 0n || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0)
    fail("Budget minimum and TTL must be positive");
  const digest = await budgetRequestDigest(
    JSON.stringify([
      input.organizationId,
      input.grantId,
      input.minimumMicros,
      input.targetMicros,
      input.policyGeneration,
      input.policyEpoch,
      input.ttlMs,
    ]),
  );
  let invalidate = false;
  const outcome = await writeTransaction(
    async (tx): Promise<ReserveInferenceFundingBudgetResult> => {
      const [org] = await tx
        .select({ credit_balance: organizations.credit_balance })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .for("update");
      if (!org) fail("Budget organization does not exist");
      const [existing] = await tx
        .select()
        .from(grants)
        .where(and(eq(grants.id, input.grantId), eq(grants.organization_id, input.organizationId)))
        .for("update");
      if (existing) {
        if (existing.request_digest !== digest)
          fail("Budget grant replay changes its original request");
        if (existing.closed_at !== null) return { status: "fenced" };
        return { status: "granted", grant: dto(existing), replayed: true };
      }
      // Serialize mint attempts before proving that an old intent has no effect.
      const [authority] = await sqlRows<{ epoch: string }>(
        tx,
        sql`SELECT epoch::text FROM inference_policy_authorities WHERE organization_id=${input.organizationId} AND enabled=true`,
      );
      if (!authority || authority.epoch !== input.policyEpoch) return { status: "fenced" };
      await billingHoldService.assertNoHold(input.organizationId, tx);
      const observedAt = await readPostLockDatabaseNow(tx);
      const policy = await readOrganizationQuotaPolicyInTransaction(
        tx,
        input.organizationId,
        observedAt,
      );
      if (!policy.subscriptionFunded || policy.authority.generation !== input.policyGeneration)
        return { status: "fenced" };
      const period = await readEligibleSubscriptionAllowance(
        tx,
        input.organizationId,
        observedAt,
        true,
        policy,
      );
      const now = await readPostLockDatabaseNow(tx);
      const deadline =
        policy.authority.effectiveUntil === null
          ? Infinity
          : Date.parse(policy.authority.effectiveUntil);
      if (now.getTime() >= deadline || (period && now >= period.expires_at))
        return { status: "fenced" };
      const available =
        moneyToMicros(Decimal.max(org.credit_balance, 0).toFixed(6), "budget.credit") +
        (period ? moneyToMicros(period.available_amount, "budget.allowance") : 0n);
      if (available < minimum)
        return {
          status: "insufficient",
          availableMicros: available.toString(),
          minimumMicros: minimum.toString(),
        };
      const desired = minimum > target ? minimum : target;
      const amount = available < desired ? available : desired;
      const expiresAt = new Date(
        Math.min(now.getTime() + input.ttlMs, deadline, period?.expires_at.getTime() ?? Infinity),
      );
      const reserved = await subscriptionFundingService.reserveInTransaction(tx, {
        organizationId: input.organizationId,
        logicalOperationId: operationId(input.grantId),
        operation: "ai_inference",
        amount: microsToMoney(amount),
        description: "Inference admission escrow",
        expiresAt,
        metadata: { type: "inference_funding_budget", budgetGrantId: input.grantId },
      });
      const [row] = await tx
        .insert(grants)
        .values({
          id: input.grantId,
          organization_id: input.organizationId,
          funding_reservation_id: reserved.reservation.id,
          request_digest: digest,
          policy_generation: input.policyGeneration,
          policy_epoch: input.policyEpoch,
          amount: microsToMoney(amount),
          expires_at: expiresAt,
          created_at: now,
        })
        .returning();
      if (!row) fail("Budget grant was not recorded");
      invalidate = reserved.purchasedCreditDebited;
      return { status: "granted", grant: dto(row), replayed: false };
    },
  );
  if (invalidate) await creditsService.invalidateCreditCaches(input.organizationId);
  return outcome;
}

export async function recordConsumption(
  input: InferenceFundingBudgetConsumption,
): Promise<{ replayed: boolean }> {
  const amount = micros(input.amountMicros);
  const lines = [...input.allocations].sort((a, b) => a.grantId.localeCompare(b.grantId));
  if (
    !input.requestId ||
    input.requestId.length > 128 ||
    new Set(lines.map((line) => line.grantId)).size !== lines.length
  )
    fail("Budget consumption identity is invalid");
  let allocated = 0n;
  for (const line of lines) {
    const value = micros(line.amountMicros);
    if (!Number.isSafeInteger(line.sequence) || line.sequence <= 0 || value === 0n)
      fail("Budget allocation sequence and amount must be positive");
    allocated += value;
  }
  if (allocated !== amount) fail("Budget consumption does not conserve its amount");
  const payload = budgetConsumptionPayload(input);
  if (!(await verifyBudgetEffect(payload, input.signature, secret())))
    fail("Budget consumption signature is invalid");
  const digest = await budgetRequestDigest(payload);
  return writeTransaction(async (tx) => {
    // Stable grant order prevents two multi-grant requests from reversing locks.
    const owned = lines.length
      ? await tx
          .select()
          .from(grants)
          .where(
            and(
              eq(grants.organization_id, input.organizationId),
              inArray(
                grants.id,
                lines.map((line) => line.grantId),
              ),
            ),
          )
          .orderBy(asc(grants.id))
          .for("update")
      : [];
    const [existing] = await tx
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.organization_id, input.organizationId),
          eq(receipts.request_id, input.requestId),
        ),
      );
    if (existing) {
      if (existing.request_digest !== digest) fail("Budget consumption replay changes its receipt");
      return { replayed: true };
    }
    if (owned.length !== lines.length || owned.some((grant) => grant.closed_at !== null))
      fail("Budget consumption requires open owned grants");
    const [inserted] = await tx
      .insert(receipts)
      .values({
        organization_id: input.organizationId,
        request_id: input.requestId,
        request_digest: digest,
        amount: microsToMoney(amount),
        metadata: input.metadata,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const [concurrent] = await tx
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.organization_id, input.organizationId),
            eq(receipts.request_id, input.requestId),
          ),
        );
      if (!concurrent || concurrent.request_digest !== digest)
        fail("Budget consumption replay conflicts");
      return { replayed: true };
    }
    if (lines.length)
      await tx.insert(consumptions).values(
        lines.map((line) => ({
          organization_id: input.organizationId,
          request_id: input.requestId,
          grant_id: line.grantId,
          sequence: line.sequence,
          amount: microsToMoney(micros(line.amountMicros)),
        })),
      );
    await enqueueCollectedAffiliatePayout(tx, {
      reservationMetadata: input.metadata,
      actualTotalCost: Number(microsToMoney(amount)),
      collectedTotalCost: Number(microsToMoney(amount)),
    });
    return { replayed: false };
  });
}

export async function closeBudget(
  input: InferenceFundingBudgetSeal,
): Promise<{ replayed: boolean; consumedMicros: string }> {
  const amount = micros(input.consumedMicros);
  if (!Number.isSafeInteger(input.lastSequence) || input.lastSequence < 0)
    fail("Budget seal sequence is invalid");
  if (!(await verifyBudgetEffect(budgetSealPayload(input), input.signature, secret())))
    fail("Budget seal signature is invalid");
  let invalidate = false;
  const outcome = await writeTransaction(async (tx) => {
    // Canonical settlement locks organization before its reservation and period.
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) fail("Budget organization does not exist");
    const [grant] = await tx
      .select()
      .from(grants)
      .where(and(eq(grants.organization_id, input.organizationId), eq(grants.id, input.grantId)))
      .for("update");
    if (!grant) fail("Budget grant does not exist");
    if (grant.closed_at !== null) {
      if (
        grant.seal_sequence !== input.lastSequence ||
        grant.seal_amount !== microsToMoney(amount) ||
        grant.seal_signature !== input.signature
      )
        fail("Budget seal replay changes its closed result");
      return { replayed: true, consumedMicros: input.consumedMicros };
    }
    const [watermark] = await sqlRows<{ count: string; last: number; amount: string }>(
      tx,
      sql`SELECT count(*)::text AS count,COALESCE(max(sequence),0) AS last,COALESCE(sum(amount),0)::text AS amount FROM inference_funding_budget_consumptions WHERE organization_id=${input.organizationId} AND grant_id=${input.grantId}`,
    );
    if (
      !watermark ||
      BigInt(watermark.count) !== BigInt(input.lastSequence) ||
      watermark.last !== input.lastSequence ||
      new Decimal(watermark.amount).toFixed(6) !== microsToMoney(amount)
    )
      fail("Budget seal does not match its complete consumption watermark");
    await tx.execute(sql`SELECT set_config('eliza.inference_budget_close',${input.grantId},true)`);
    const settled = await subscriptionFundingService.settleInTransaction(tx, {
      organizationId: input.organizationId,
      logicalOperationId: operationId(input.grantId),
      operation: "ai_inference",
      actualAmount: microsToMoney(amount),
      occurredAt: grant.created_at,
    });
    if (
      settled.collectedAmount !== microsToMoney(amount) ||
      settled.uncollectedOverageAmount !== "0.000000"
    )
      fail("Budget close did not settle its exact consumed amount");
    const now = await readPostLockDatabaseNow(tx);
    await tx
      .update(grants)
      .set({
        closed_at: now,
        seal_sequence: input.lastSequence,
        seal_amount: microsToMoney(amount),
        seal_signature: input.signature,
      })
      .where(eq(grants.id, grant.id));
    invalidate = settled.purchasedCreditRefunded;
    return { replayed: false, consumedMicros: input.consumedMicros };
  });
  if (invalidate) await creditsService.invalidateCreditCaches(input.organizationId);
  return outcome;
}
