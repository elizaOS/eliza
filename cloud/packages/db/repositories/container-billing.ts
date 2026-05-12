import { and, eq, inArray } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { containerBillingRecords, containers } from "../schemas/containers";
import { creditTransactions } from "../schemas/credit-transactions";
import { organizationBilling } from "../schemas/organization-billing";
import { organizations } from "../schemas/organizations";

export type ContainerBillingStatus = "active" | "warning" | "suspended" | "shutdown_pending";

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
}

export interface ContainerBillingOrganization {
  id: string;
  name: string;
  credit_balance: string;
  billing_email: string | null;
  pay_as_you_go_from_earnings: boolean;
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
  currentTotalBilled: string;
  dailyCost: number;
  newBalance: number;
  fromEarnings: number;
  fromCredits: number;
  now: Date;
}

export class ContainerBillingRepository {
  async listBillableContainers(): Promise<BillableContainer[]> {
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
      })
      .from(containers)
      .where(
        and(
          eq(containers.status, "running"),
          inArray(containers.billing_status, ["active", "warning", "shutdown_pending"]),
        ),
      );
  }

  async listBillingOrganizations(
    organizationIds: string[],
  ): Promise<ContainerBillingOrganization[]> {
    if (organizationIds.length === 0) return [];

    const [orgRows, billingRows] = await Promise.all([
      dbRead
        .select({
          id: organizations.id,
          name: organizations.name,
          credit_balance: organizations.credit_balance,
          pay_as_you_go_from_earnings: organizations.pay_as_you_go_from_earnings,
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

    const billingEmailByOrg = new Map(
      billingRows.map((row) => [row.organization_id, row.billing_email]),
    );

    return orgRows.map((org) => ({
      ...org,
      billing_email: billingEmailByOrg.get(org.id) ?? null,
    }));
  }

  async suspendContainer(containerId: string, now: Date): Promise<void> {
    await dbWrite
      .update(containers)
      .set({
        status: "stopped",
        billing_status: "suspended" as ContainerBillingStatus,
        updated_at: now,
      })
      .where(eq(containers.id, containerId));
  }

  async scheduleShutdownWarning(containerId: string, now: Date, shutdownTime: Date): Promise<void> {
    await dbWrite
      .update(containers)
      .set({
        billing_status: "shutdown_pending" as ContainerBillingStatus,
        shutdown_warning_sent_at: now,
        scheduled_shutdown_at: shutdownTime,
        updated_at: now,
      })
      .where(eq(containers.id, containerId));
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

  async recordSuccessfulDailyBilling(input: RecordSuccessfulBillingInput): Promise<{
    newBalance: number;
    transactionId: string;
  }> {
    return await dbWrite.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({
          credit_balance: String(input.newBalance),
          updated_at: input.now,
        })
        .where(eq(organizations.id, input.organizationId));

      const [creditTx] = await tx
        .insert(creditTransactions)
        .values({
          organization_id: input.organizationId,
          user_id: input.userId,
          amount: String(-input.dailyCost),
          type: "debit",
          description: `Daily container billing: ${input.containerName}`,
          metadata: {
            container_id: input.containerId,
            container_name: input.containerName,
            billing_type: "daily_container",
            billing_period: input.now.toISOString().split("T")[0],
            paid_from_earnings: input.fromEarnings.toFixed(4),
            paid_from_credits: input.fromCredits.toFixed(4),
          },
          created_at: input.now,
        })
        .returning();

      await tx
        .update(containers)
        .set({
          last_billed_at: input.now,
          next_billing_at: new Date(input.now.getTime() + 24 * 60 * 60 * 1000),
          billing_status: "active" as ContainerBillingStatus,
          shutdown_warning_sent_at: null,
          scheduled_shutdown_at: null,
          total_billed: String(Number(input.currentTotalBilled) + input.dailyCost),
          updated_at: input.now,
        })
        .where(eq(containers.id, input.containerId));

      await tx.insert(containerBillingRecords).values({
        container_id: input.containerId,
        organization_id: input.organizationId,
        amount: String(input.dailyCost),
        billing_period_start: input.now,
        billing_period_end: new Date(input.now.getTime() + 24 * 60 * 60 * 1000),
        status: "success",
        credit_transaction_id: creditTx.id,
        created_at: input.now,
      });

      return { newBalance: input.newBalance, transactionId: creditTx.id };
    });
  }
}

export const containerBillingRepository = new ContainerBillingRepository();
