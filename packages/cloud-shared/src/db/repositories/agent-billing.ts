import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AgentBillingStatus,
  type AgentSandboxStatus,
  agentSandboxes,
} from "../schemas/agent-sandboxes";
import { creditTransactions } from "../schemas/credit-transactions";
import { organizationBilling } from "../schemas/organization-billing";
import { organizations } from "../schemas/organizations";

export interface AgentBillingSandbox {
  id: string;
  agent_name: string | null;
  organization_id: string;
  user_id: string;
  status: AgentSandboxStatus;
  billing_status: AgentBillingStatus;
  last_billed_at: Date | null;
  total_billed: string;
  shutdown_warning_sent_at: Date | null;
  scheduled_shutdown_at: Date | null;
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
  sandboxStatus: string;
  hourlyCost: number;
  billingDescription: string;
  lowCreditWarningAmount: number;
  rebillCutoff: Date;
  now: Date;
}

export type AgentHourlyBillingOutcome =
  | { status: "billed"; newBalance: number; transactionId: string }
  | { status: "already_billed_recently" }
  | { status: "insufficient_credits" };

const BILLABLE_BILLING_STATUSES: AgentBillingStatus[] = ["active", "warning", "shutdown_pending"];

export class AgentBillingRepository {
  async getOrganizationCreditBalance(organizationId: string): Promise<number | null> {
    const [org] = await dbRead
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, organizationId));

    return org ? Number(org.credit_balance) : null;
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
      status: agentSandboxes.status,
      billing_status: agentSandboxes.billing_status,
      last_billed_at: agentSandboxes.last_billed_at,
      total_billed: agentSandboxes.total_billed,
      shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
      scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
    };

    const [runningSandboxes, stoppedWithBackups] = await Promise.all([
      dbRead
        .select(selectFields)
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.status, "running"),
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

    const [orgs, billingData] = await Promise.all([
      dbRead
        .select({
          id: organizations.id,
          name: organizations.name,
          credit_balance: organizations.credit_balance,
        })
        .from(organizations)
        .where(inArray(organizations.id, organizationIds)),
      dbRead
        .select({
          organization_id: organizationBilling.organization_id,
          billing_email: organizationBilling.billing_email,
        })
        .from(organizationBilling)
        .where(inArray(organizationBilling.organization_id, organizationIds)),
    ]);

    const billingEmailMap = new Map(
      billingData.map((row) => [row.organization_id, row.billing_email]),
    );

    return orgs.map((org) => ({
      ...org,
      billing_email: billingEmailMap.get(org.id) ?? null,
    }));
  }

  async scheduleShutdownWarning(sandboxId: string, now: Date, shutdownTime: Date): Promise<void> {
    await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "shutdown_pending" as AgentBillingStatus,
        shutdown_warning_sent_at: now,
        scheduled_shutdown_at: shutdownTime,
        updated_at: now,
      })
      .where(eq(agentSandboxes.id, sandboxId));
  }

  async suspendSandboxForInsufficientCredits(sandboxId: string, now: Date): Promise<void> {
    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "stopped",
        billing_status: "suspended" as AgentBillingStatus,
        sandbox_id: null,
        bridge_url: null,
        health_url: null,
        updated_at: now,
      })
      .where(eq(agentSandboxes.id, sandboxId));
  }

  async recordHourlyBilling(input: AgentHourlyBillingInput): Promise<AgentHourlyBillingOutcome> {
    return await dbWrite.transaction(async (tx) => {
      const [claimedSandbox] = await tx
        .update(agentSandboxes)
        .set({ updated_at: input.now })
        .where(
          and(
            eq(agentSandboxes.id, input.sandboxId),
            or(
              isNull(agentSandboxes.last_billed_at),
              lt(agentSandboxes.last_billed_at, input.rebillCutoff),
            ),
          ),
        )
        .returning({ id: agentSandboxes.id });

      if (!claimedSandbox) {
        return { status: "already_billed_recently" as const };
      }

      const [updatedOrg] = await tx
        .update(organizations)
        .set({
          credit_balance: sql`${organizations.credit_balance} - ${String(input.hourlyCost)}`,
          updated_at: input.now,
        })
        .where(
          and(
            eq(organizations.id, input.organizationId),
            gte(organizations.credit_balance, String(input.hourlyCost)),
          ),
        )
        .returning({ credit_balance: organizations.credit_balance });

      if (!updatedOrg) {
        return { status: "insufficient_credits" as const };
      }

      const newBalance = Number(updatedOrg.credit_balance);
      const [creditTx] = await tx
        .insert(creditTransactions)
        .values({
          organization_id: input.organizationId,
          user_id: input.userId,
          amount: String(-input.hourlyCost),
          type: "debit",
          description: input.billingDescription,
          metadata: {
            sandbox_id: input.sandboxId,
            agent_name: input.agentName,
            billing_type: input.sandboxStatus === "running" ? "agent_running" : "agent_idle",
            hourly_rate: input.hourlyCost,
            billing_hour: input.now.toISOString(),
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
          hourly_rate: String(input.hourlyCost),
          total_billed: sql`${agentSandboxes.total_billed} + ${String(input.hourlyCost)}`,
          updated_at: input.now,
        })
        .where(eq(agentSandboxes.id, input.sandboxId));

      return { status: "billed" as const, newBalance, transactionId: creditTx.id };
    });
  }
}

export const agentBillingRepository = new AgentBillingRepository();
