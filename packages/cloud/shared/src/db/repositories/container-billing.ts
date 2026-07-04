// Persists container billing records for cloud services through the shared DB boundary.
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { containerBillingRecords, containers } from "../schemas/containers";
import { creditTransactions } from "../schemas/credit-transactions";
import { organizationBilling } from "../schemas/organization-billing";
import { organizations } from "../schemas/organizations";
import { parseContainerBillingNumber } from "./container-billing-numeric";

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
  /** Wall-clock time of this billing run (used for the row-lock period guard). */
  now: Date;
  /** UTC-day-aligned start of the period this charge covers. */
  billingPeriodStart: Date;
  /** End of the period; also written to `next_billing_at`. */
  billingPeriodEnd: Date;
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
      })
      .from(containers)
      .where(
        and(
          eq(containers.status, "running"),
          inArray(containers.billing_status, ["active", "warning", "shutdown_pending"]),
          or(isNull(containers.next_billing_at), lte(containers.next_billing_at, now)),
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
    transactionId: string | null;
    alreadyBilled: boolean;
  }> {
    return await dbWrite.transaction(async (tx) => {
      // Idempotency guard: lock the container row and re-check whether it has
      // already been billed for this period. `next_billing_at` is the end of
      // the period last charged; if it is still in the future, the period is
      // paid — skip without touching any balance. This closes the read→write
      // race between listBillableContainers and this write (e.g. two concurrent
      // cron invocations both selecting the container before either commits).
      const [locked] = await tx
        .select({ next_billing_at: containers.next_billing_at })
        .from(containers)
        .where(eq(containers.id, input.containerId))
        .for("update");

      if (locked?.next_billing_at && locked.next_billing_at > input.now) {
        const [org] = await tx
          .select({ credit_balance: organizations.credit_balance })
          .from(organizations)
          .where(eq(organizations.id, input.organizationId));
        return {
          // Row present but the NUMERIC read is corrupt → fail closed with a
          // field-named error instead of returning a NaN balance. Row absent
          // (org concurrently deleted) keeps the caller-computed fallback.
          newBalance: org
            ? parseContainerBillingNumber(org.credit_balance, "credit_balance")
            : input.newBalance,
          transactionId: null,
          alreadyBilled: true,
        };
      }

      // Atomic relative decrement — NOT an absolute write of a JS-computed
      // newBalance derived from a stale read. The net credit-balance movement
      // is -fromCredits (= dailyCost - fromEarnings; the earnings portion is
      // debited from the redeemable-earnings ledger separately and never
      // touches credit_balance), identical to the old
      // `currentBalance + fromEarnings - dailyCost`. Decrementing the LIVE
      // column instead of overwriting it with a stale-derived absolute means a
      // concurrent inference debit / top-up that lands between the caller's
      // balance read and this commit is no longer lost. The `credit_balance >= 0`
      // check constraint backstops a concurrent-overdraft race; the per-container
      // billing loop isolates the resulting error and retries next run.
      const [updatedOrg] = await tx
        .update(organizations)
        .set({
          credit_balance: sql`${organizations.credit_balance} - ${String(input.fromCredits)}`,
          updated_at: input.now,
        })
        .where(eq(organizations.id, input.organizationId))
        .returning({ credit_balance: organizations.credit_balance });

      // Record only the credit-balance movement (fromCredits). The earnings
      // portion is debited from the redeemable-earnings ledger via
      // convertToCredits, so charging the full dailyCost here would
      // double-count it and break credit_balance == sum(credit_transactions).
      const [creditTx] = await tx
        .insert(creditTransactions)
        .values({
          organization_id: input.organizationId,
          user_id: input.userId,
          amount: String(-input.fromCredits),
          type: "debit",
          description: `Daily container billing: ${input.containerName}`,
          metadata: {
            container_id: input.containerId,
            container_name: input.containerName,
            billing_type: "daily_container",
            billing_period: input.billingPeriodStart.toISOString().split("T")[0],
            daily_cost: input.dailyCost.toFixed(4),
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
          next_billing_at: input.billingPeriodEnd,
          billing_status: "active" as ContainerBillingStatus,
          shutdown_warning_sent_at: null,
          scheduled_shutdown_at: null,
          // Fail closed on a corrupt running total instead of writing "NaN"
          // back into the NUMERIC column (which would poison every future
          // billing run for this container via a rolled-back cast error).
          total_billed: String(
            parseContainerBillingNumber(input.currentTotalBilled, "total_billed") + input.dailyCost,
          ),
          updated_at: input.now,
        })
        .where(eq(containers.id, input.containerId));

      await tx.insert(containerBillingRecords).values({
        container_id: input.containerId,
        organization_id: input.organizationId,
        amount: String(input.dailyCost),
        billing_period_start: input.billingPeriodStart,
        billing_period_end: input.billingPeriodEnd,
        status: "success",
        credit_transaction_id: creditTx.id,
        created_at: input.now,
      });

      return {
        // Fail closed on a corrupt post-decrement balance read rather than
        // returning NaN (which the low-balance email would render as `$NaN`).
        // Row absent keeps the caller-computed fallback.
        newBalance: updatedOrg
          ? parseContainerBillingNumber(updatedOrg.credit_balance, "credit_balance")
          : input.newBalance,
        transactionId: creditTx.id,
        alreadyBilled: false,
      };
    });
  }
}

export const containerBillingRepository = new ContainerBillingRepository();
