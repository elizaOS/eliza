/** Atomically publishes a paid original upgrade, allowance adjustment, entitlement and immutable command result. */

import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { assertOrganizationSubscription } from "../../lib/services/organization-subscription-source";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { proratedAllowanceIncrease } from "../../lib/services/subscription-allowance-proration";
import { resolveSubscriptionPlanDefinition } from "../../lib/services/subscription-catalog";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { organizationUpgradeInvoiceOrigins } from "../schemas/organization-upgrade-invoice-origins";
import { organizations } from "../schemas/organizations";
import { subscriptionAllowancePeriods as periods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions as ledger } from "../schemas/subscription-allowance-transactions";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import { projectUpgradeAllowanceAdjustment } from "./organization-upgrade-allowance-posting";
import {
  type OrganizationUpgradeSettlementIdentity,
  upgradeSettlementConflict as reject,
} from "./organization-upgrade-paid-authority";
import { resolveAppliedUpgradeIncidentsInTransaction } from "./organization-upgrade-recovery-incidents";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";

/** System recovery can observe an already dispatched, attributed effect. It never receives dispatch authority. */
export async function claimOrganizationUpgradePaidReconciliation(input: {
  organizationId: string;
  commandId: string;
}) {
  return writeTransaction(async (tx) => {
    const [org] = await tx
      .select({
        id: organizations.id,
        active: organizations.is_active,
        state: organizations.account_lifecycle_state,
        deletion: organizations.account_deletion_request_id,
        fenced: organizations.paid_work_fenced_at,
      })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (
      !org ||
      !org.active ||
      org.state !== "active" ||
      org.deletion !== null ||
      org.fenced !== null
    )
      return null;
    const [command] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.organization_id, input.organizationId),
          eq(commands.id, input.commandId),
          isNull(commands.app_id),
          isNull(commands.billing_scope_id),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (
      !command ||
      command.kind !== "upgrade" ||
      command.merchant_key !== "platform" ||
      command.status !== "OUTCOME_UNKNOWN" ||
      command.organization_upgrade_dispatch_state !== "started" ||
      (command.lease_expires_at !== null && command.lease_expires_at > now)
    )
      return null;
    const [origin] = await tx
      .select()
      .from(organizationUpgradeInvoiceOrigins)
      .where(
        and(
          eq(organizationUpgradeInvoiceOrigins.organization_id, input.organizationId),
          eq(organizationUpgradeInvoiceOrigins.command_id, input.commandId),
        ),
      );
    if (!origin) return null;
    const [claimed] = await tx
      .update(commands)
      .set({
        lease_token: randomUUID(),
        lease_expires_at: new Date(now.getTime() + 60000),
        execution_generation: command.execution_generation + 1,
        attempt_count: command.attempt_count + 1,
        state_revision: command.state_revision + 1,
        updated_at: now,
      })
      .where(eq(commands.id, command.id))
      .returning();
    if (!claimed) reject("reconciliation_claim_failed");
    return { command: claimed, origin, canDispatch: false as const };
  });
}

type Verified = Awaited<
  ReturnType<typeof subscriptionAuthorityRepository.advancePaidOrganizationUpgradeInTransaction>
>;
async function postAllowance(tx: DbTransaction, verified: Verified) {
  const { source, subscription, quote, origin, command } = verified;
  assertOrganizationSubscription(source);
  assertOrganizationSubscription(subscription);
  if (!source.current_period_start || !source.current_period_end) reject("source_period_missing");
  const amount = proratedAllowanceIncrease({
    previousUsd: resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version)
      .allowance.amountUsd,
    targetUsd: resolveSubscriptionPlanDefinition(
      subscription.plan_key,
      subscription.catalog_version,
    ).allowance.amountUsd,
    periodStartMs: source.current_period_start.getTime(),
    periodEndMs: source.current_period_end.getTime(),
    effectiveAtMs: quote.review.prorationDate * 1000,
  });
  if (amount !== quote.review.additionalAllowanceUsd) reject("reviewed_allowance_changed");
  const [period] = await tx
    .select()
    .from(periods)
    .where(
      and(
        eq(periods.organization_id, source.organization_id),
        eq(periods.subscription_id, source.id),
        eq(periods.period_start, source.current_period_start),
        eq(periods.period_end, source.current_period_end),
        isNull(periods.billing_scope_id),
      ),
    )
    .for("update");
  if (
    !period ||
    period.merchant_key !== "platform" ||
    period.grant_source !== "paid_invoice" ||
    period.provider_environment !== source.provider_environment
  )
    reject("paid_allowance_period_unavailable");
  const [existing] = await tx
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(eq(ledger.merchant_key, "platform"), eq(ledger.source_invoice_id, origin.invoice_id)),
    );
  if (existing) reject("invoice_already_posted_without_applied_command");
  const now = await readPostLockDatabaseNow(tx);
  const posting = projectUpgradeAllowanceAdjustment(period, amount, now);
  const [last] = await tx
    .select({ sequence: ledger.sequence })
    .from(ledger)
    .where(eq(ledger.allowance_period_id, period.id))
    .orderBy(desc(ledger.sequence))
    .limit(1);
  let sequence = last?.sequence ?? 0;
  const digest = settlementDigest({
    commandId: command.id,
    invoiceId: origin.invoice_id,
    paid: verified.paid,
    reviewDigest: quote.review_digest,
  });
  for (const entry of posting.entries) {
    const adjustment = entry.kind === "grant_adjustment";
    await tx.insert(ledger).values({
      organization_id: source.organization_id,
      allowance_period_id: period.id,
      sequence: ++sequence,
      kind: entry.kind,
      amount: entry.amount,
      available_before: entry.before.available_amount,
      available_after: entry.after.available_amount,
      reserved_before: entry.before.reserved_amount,
      reserved_after: entry.after.reserved_amount,
      settled_before: entry.before.settled_amount,
      settled_after: entry.after.settled_amount,
      expired_before: entry.before.expired_amount,
      expired_after: entry.after.expired_amount,
      clawed_back_before: entry.before.clawed_back_amount,
      clawed_back_after: entry.after.clawed_back_amount,
      source_subscription_id: adjustment ? source.id : null,
      source_subscription_revision: adjustment ? subscription.lifecycle_revision : null,
      source_invoice_id: adjustment ? origin.invoice_id : null,
      source_plan_key: adjustment ? subscription.plan_key : null,
      source_catalog_version: adjustment ? subscription.catalog_version : null,
      idempotency_key:
        entry.reason === "period_ended"
          ? `expire.${period.id}`
          : `upgrade:${origin.invoice_id}:${entry.reason}`,
      request_digest: digest,
      metadata: { commandId: command.id, reason: entry.reason },
      occurred_at: now,
    });
  }
  await tx
    .update(periods)
    .set({ ...posting.periodChanges, updated_at: now })
    .where(and(eq(periods.id, period.id), eq(periods.organization_id, source.organization_id)));
  return { amount, periodId: period.id, expired: posting.expired };
}

/** Provider objects are authenticated server reads, never renderer-supplied financial state. */
export async function finalizePaidOrganizationUpgrade(
  input: OrganizationUpgradeSettlementIdentity & { rawInvoice: unknown; rawSubscription: unknown },
) {
  return writeTransaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) reject("organization_missing");
    const [command] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.organization_id, input.organizationId),
          eq(commands.id, input.commandId),
          isNull(commands.app_id),
          isNull(commands.billing_scope_id),
        ),
      )
      .for("update");
    if (
      !command ||
      command.kind !== "upgrade" ||
      command.organization_upgrade_dispatch_state !== "started"
    )
      reject("original_command_missing");
    if (command.status === "APPLIED") {
      await resolveAppliedUpgradeIncidentsInTransaction(tx, input);
      return { command, replayed: true };
    }
    const verified =
      await subscriptionAuthorityRepository.advancePaidOrganizationUpgradeInTransaction(tx, input);
    const allowance = await postAllowance(tx, verified);
    await subscriptionEntitlementsRepository.rebuildInTransaction(tx, {
      organizationId: input.organizationId,
      sourceSubscriptionId: verified.source.id,
      sourceSubscriptionRevision: verified.subscription.lifecycle_revision,
      expectedProjectionRevision: verified.projection.projection_revision,
    });
    const [applied] = await tx
      .update(commands)
      .set({
        status: "APPLIED",
        state_revision: command.state_revision + 1,
        lease_token: null,
        lease_expires_at: null,
        organization_upgrade_settlement_evidence: verified.historicalEvidence,
        provider_response_digest: settlementDigest({
          paid: verified.paid,
          target: verified.target,
          historicalEvidence: verified.historicalEvidence,
          allowance,
        }),
        result_subscription_id: verified.source.id,
        result_subscription_revision: verified.subscription.lifecycle_revision,
        completed_at: sql`clock_timestamp()`,
        applied_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(commands.id, command.id),
          eq(commands.organization_id, input.organizationId),
          eq(commands.status, "OUTCOME_UNKNOWN"),
          eq(commands.lease_token, input.leaseToken),
          eq(commands.execution_generation, input.executionGeneration),
          gt(commands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!applied) reject("lease_lost_before_commit");
    await resolveAppliedUpgradeIncidentsInTransaction(tx, input);
    return { command: applied, replayed: false };
  });
}
