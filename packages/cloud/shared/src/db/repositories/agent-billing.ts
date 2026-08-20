/** Persists elapsed agent-compute charges and billing lifecycle transitions. */

import Decimal from "decimal.js";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbRead, dbWrite } from "../helpers";
import {
  type AgentBillingStatus,
  type AgentSandboxStatus,
  agentSandboxes,
} from "../schemas/agent-sandboxes";
import { agentBillingRecords } from "../schemas/compute-billing";
import { creditTransactions } from "../schemas/credit-transactions";
import { organizations } from "../schemas/organizations";
import { parseOrgCreditBalance } from "./agent-billing-numeric";
import { settleComputeRateSegments } from "./compute-billing-segments";

export interface AgentBillingSandbox {
  id: string;
  agent_name: string | null;
  organization_id: string;
  user_id: string;
  agent_config: Record<string, unknown> | null;
  status: AgentSandboxStatus;
  billing_status: AgentBillingStatus;
  last_billed_at: Date | null;
  total_billed: string;
  shutdown_warning_sent_at: Date | null;
  scheduled_shutdown_at: Date | null;
  created_at: Date;
}

export interface AgentBillingOrganization {
  id: string;
  name: string;
  credit_balance: string;
  billing_email: string | null;
}

export interface AgentHourlyBillingInput {
  sandboxId: string;
  organizationId: string;
  userId: string;
  agentName: string;
  hourlyRate: number;
  billingDescription: string;
  lowCreditWarningAmount: number;
  now: Date;
}

export type AgentHourlyBillingOutcome =
  | { status: "billed"; newBalance: number; transactionId: string; amount: number }
  | { status: "already_billed_recently" }
  | { status: "insufficient_credits" };

const BILLABLE_BILLING_STATUSES: AgentBillingStatus[] = ["active", "warning", "shutdown_pending"];

export class AgentBillingRepository {
  async getOrganizationCreditBalance(organizationId: string): Promise<number | null> {
    const [org] = await dbRead
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, organizationId));

    // Fail closed on a corrupt NUMERIC read: returning `Number(...) = NaN` here
    // would masquerade as a real balance and flow into the cron billing gate
    // (`liveBalance >= hourlyCost`, where `NaN` is not caught by `?? fallback`)
    // and into user-facing warning emails/webhooks as `$NaN`. A genuinely
    // missing org still returns `null` (caller treats it as unknown).
    return org ? parseOrgCreditBalance(org.credit_balance) : null;
  }

  async listBillableSandboxes(
    now: Date,
    rebillCutoff: Date,
  ): Promise<{
    runningSandboxes: AgentBillingSandbox[];
    stoppedWithBackups: AgentBillingSandbox[];
  }> {
    const billingDueCondition = or(
      and(
        eq(agentSandboxes.billing_status, "shutdown_pending"),
        isNotNull(agentSandboxes.scheduled_shutdown_at),
        lte(agentSandboxes.scheduled_shutdown_at, now),
      ),
      isNull(agentSandboxes.last_billed_at),
      lt(agentSandboxes.last_billed_at, rebillCutoff),
    );

    const selectFields = {
      id: agentSandboxes.id,
      agent_name: agentSandboxes.agent_name,
      organization_id: agentSandboxes.organization_id,
      user_id: agentSandboxes.user_id,
      agent_config: agentSandboxes.agent_config,
      status: agentSandboxes.status,
      billing_status: agentSandboxes.billing_status,
      last_billed_at: agentSandboxes.last_billed_at,
      total_billed: agentSandboxes.total_billed,
      shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
      scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      created_at: agentSandboxes.created_at,
    };

    const [runningSandboxes, stoppedWithBackups] = await Promise.all([
      dbRead
        .select(selectFields)
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.status, "running"),
            sql`${agentSandboxes.execution_tier} <> 'shared'`,
            // Defence in depth, aligned with the six sibling predicates here.
            // The charge itself is already safe: recordHourlyBillingWithOptions
            // claims the row with this same guard on its SELECT ... FOR UPDATE,
            // so a deleting sandbox is never debited — and everything gated on
            // that claim (shutdown-warning mail, the credits.low webhook) is
            // equally unreachable for it. What IS unguarded is the cron's
            // shutdown_pending branch, which reads the selected row directly:
            // it fires the credits.depleted webhook and enqueueAgentSuspendOnce
            // without consulting the deletion state.
            //
            // The window is narrow because both deletion writers set
            // status='deletion_pending' in the same UPDATE that sets
            // deletion_attempt_id, which this predicate already excludes. It is
            // reachable when something writes 'running' back over a row whose
            // deletion attempt is still set — the pair-check permits that shape.
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
            inArray(agentSandboxes.billing_status, BILLABLE_BILLING_STATUSES),
            billingDueCondition,
          ),
        ),
      dbRead
        .select(selectFields)
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.status, "stopped"),
            sql`${agentSandboxes.execution_tier} <> 'shared'`,
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
            inArray(agentSandboxes.billing_status, BILLABLE_BILLING_STATUSES),
            isNotNull(agentSandboxes.last_backup_at),
            billingDueCondition,
          ),
        ),
    ]);

    return { runningSandboxes, stoppedWithBackups };
  }

  async listBillingOrganizations(organizationIds: string[]): Promise<AgentBillingOrganization[]> {
    if (organizationIds.length === 0) return [];

    return dbRead
      .select({
        id: organizations.id,
        name: organizations.name,
        credit_balance: organizations.credit_balance,
        billing_email: organizations.billing_email,
      })
      .from(organizations)
      .where(inArray(organizations.id, organizationIds));
  }

  async scheduleShutdownWarning(
    sandboxId: string,
    organizationId: string,
    now: Date,
    shutdownTime: Date,
  ): Promise<void> {
    await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "shutdown_pending" as AgentBillingStatus,
        shutdown_warning_sent_at: now,
        scheduled_shutdown_at: shutdownTime,
        updated_at: now,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandboxId),
          eq(agentSandboxes.organization_id, organizationId),
          sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
        ),
      );
  }

  async suspendSandboxForInsufficientCredits(
    sandboxId: string,
    organizationId: string,
    now: Date,
  ): Promise<void> {
    await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "suspended" as AgentBillingStatus,
        updated_at: now,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandboxId),
          eq(agentSandboxes.organization_id, organizationId),
          sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
        ),
      );
  }

  async reactivateSandboxBillingAfterFunding(
    sandboxId: string,
    now: Date,
    organizationId?: string,
  ): Promise<void> {
    await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "active" as AgentBillingStatus,
        shutdown_warning_sent_at: null,
        scheduled_shutdown_at: null,
        updated_at: now,
      })
      .where(
        and(
          eq(agentSandboxes.id, sandboxId),
          ...(organizationId ? [eq(agentSandboxes.organization_id, organizationId)] : []),
          ne(agentSandboxes.billing_status, "exempt"),
          sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
        ),
      );
  }

  async recordHourlyBilling(input: AgentHourlyBillingInput): Promise<AgentHourlyBillingOutcome> {
    return this.recordHourlyBillingWithOptions(input);
  }

  /** Settle all accrued debt before a lifecycle path may create provider compute. */
  async settleAccruedBillingBeforeLifecycle(
    sandboxId: string,
    organizationId: string,
    now: Date,
  ): Promise<AgentHourlyBillingOutcome> {
    return this.settleAccruedBillingBeforeLifecycleWithExecutor(
      dbWrite,
      sandboxId,
      organizationId,
      now,
    );
  }

  /** Settle accrued debt inside an existing workload-to-organization lock fence. */
  async settleAccruedBillingBeforeLifecycleInTransaction(
    tx: DbTransaction,
    sandboxId: string,
    organizationId: string,
    now: Date,
  ): Promise<AgentHourlyBillingOutcome> {
    return this.settleAccruedBillingBeforeLifecycleWithExecutor(tx, sandboxId, organizationId, now);
  }

  private async settleAccruedBillingBeforeLifecycleWithExecutor(
    executor: typeof dbWrite | DbTransaction,
    sandboxId: string,
    organizationId: string,
    now: Date,
  ): Promise<AgentHourlyBillingOutcome> {
    const [sandbox] = await executor
      .select({
        user_id: agentSandboxes.user_id,
        agent_name: agentSandboxes.agent_name,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, sandboxId),
          eq(agentSandboxes.organization_id, organizationId),
          sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
        ),
      )
      .limit(1);
    if (!sandbox) return { status: "already_billed_recently" };
    return this.recordHourlyBillingWithOptions(
      {
        sandboxId,
        organizationId,
        userId: sandbox.user_id,
        agentName: sandbox.agent_name ?? sandboxId.slice(0, 8),
        hourlyRate: 0,
        billingDescription: `Eliza agent lifecycle debt settlement: ${sandbox.agent_name ?? sandboxId}`,
        lowCreditWarningAmount: 0,
        now,
      },
      { forceLifecycleSettlement: true },
      executor === dbWrite ? undefined : (executor as DbTransaction),
    );
  }

  private async recordHourlyBillingWithOptions(
    input: AgentHourlyBillingInput,
    options: { forceLifecycleSettlement?: boolean } = {},
    existingTx?: DbTransaction,
  ): Promise<AgentHourlyBillingOutcome> {
    const settle = async (tx: DbTransaction): Promise<AgentHourlyBillingOutcome> => {
      const [claimedSandbox] = await tx
        .select({
          id: agentSandboxes.id,
          status: agentSandboxes.status,
          billing_status: agentSandboxes.billing_status,
          execution_tier: agentSandboxes.execution_tier,
          last_billed_at: agentSandboxes.last_billed_at,
          created_at: agentSandboxes.created_at,
        })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, input.sandboxId),
            eq(agentSandboxes.organization_id, input.organizationId),
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        )
        .for("update")
        .limit(1);

      if (
        !claimedSandbox ||
        claimedSandbox.execution_tier === "shared" ||
        (!options.forceLifecycleSettlement &&
          (!BILLABLE_BILLING_STATUSES.includes(claimedSandbox.billing_status) ||
            !(claimedSandbox.status === "running" || claimedSandbox.status === "stopped")))
      ) {
        return { status: "already_billed_recently" as const };
      }

      const periodStart = claimedSandbox.last_billed_at ?? claimedSandbox.created_at;
      const elapsedMs = input.now.getTime() - periodStart.getTime();
      if (elapsedMs <= 0 || (!options.forceLifecycleSettlement && elapsedMs < 55 * 60 * 1000)) {
        return { status: "already_billed_recently" as const };
      }
      const settled = await settleComputeRateSegments(tx, {
        organizationId: input.organizationId,
        workloadKind: "agent",
        workloadId: input.sandboxId,
        periodStart,
        periodEnd: input.now,
      });
      const chargeDecimal = settled.amount;
      const charge = chargeDecimal.toNumber();
      const effectiveHourlyRate = chargeDecimal
        .mul(60 * 60 * 1000)
        .div(elapsedMs)
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP);

      const [updatedOrg] = await tx
        .update(organizations)
        .set({
          credit_balance: sql`${organizations.credit_balance} - ${chargeDecimal.toFixed(6)}`,
          updated_at: input.now,
        })
        .where(
          and(
            eq(organizations.id, input.organizationId),
            gte(organizations.credit_balance, chargeDecimal.toFixed(6)),
          ),
        )
        .returning({ credit_balance: organizations.credit_balance });

      if (!updatedOrg) {
        return { status: "insufficient_credits" as const };
      }

      // Fail closed on a corrupt post-debit balance: a `NaN` here would make
      // `newBalance < lowCreditWarningAmount` always false and silently suppress
      // the low-credit "warning" status, letting the org keep billing as
      // "active" past its threshold. The debit already committed, so surfacing
      // the corruption is the safe outcome (the transaction rolls back on throw).
      const newBalance = parseOrgCreditBalance(updatedOrg.credit_balance);
      const [creditTx] = await tx
        .insert(creditTransactions)
        .values({
          organization_id: input.organizationId,
          user_id: input.userId,
          amount: chargeDecimal.negated().toFixed(6),
          type: "debit",
          description: input.billingDescription,
          metadata: {
            sandbox_id: input.sandboxId,
            agent_name: input.agentName,
            billing_type:
              settled.segments.length === 1
                ? `agent_${settled.segments[0]?.state ?? "unknown"}`
                : "agent_mixed",
            hourly_rate: effectiveHourlyRate.toFixed(6),
            rate_segments: settled.segments,
            billing_period_start: periodStart.toISOString(),
            billing_period_end: input.now.toISOString(),
          },
          created_at: input.now,
        })
        .returning();

      const nextBillingStatus: AgentBillingStatus =
        newBalance < input.lowCreditWarningAmount ? "warning" : "active";

      await tx
        .update(agentSandboxes)
        .set({
          last_billed_at: input.now,
          billing_status: nextBillingStatus,
          shutdown_warning_sent_at: null,
          scheduled_shutdown_at: null,
          hourly_rate: effectiveHourlyRate.toFixed(6),
          total_billed: sql`${agentSandboxes.total_billed} + ${chargeDecimal.toFixed(6)}`,
          updated_at: input.now,
        })
        .where(
          and(
            eq(agentSandboxes.id, input.sandboxId),
            eq(agentSandboxes.organization_id, input.organizationId),
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        );

      await tx.insert(agentBillingRecords).values({
        organization_id: input.organizationId,
        sandbox_id: input.sandboxId,
        sandbox_status:
          settled.segments.length === 1
            ? (settled.segments[0]?.state ?? claimedSandbox.status)
            : "mixed",
        billing_period_start: periodStart,
        billing_period_end: input.now,
        hourly_rate: effectiveHourlyRate.toFixed(6),
        amount: chargeDecimal.toFixed(6),
        rate_segments: settled.segments,
        credit_transaction_id: creditTx.id,
        created_at: input.now,
      });

      return { status: "billed" as const, newBalance, transactionId: creditTx.id, amount: charge };
    };
    return existingTx ? settle(existingTx) : await dbWrite.transaction(settle);
  }
}

export const agentBillingRepository = new AgentBillingRepository();
