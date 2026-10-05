/** Resolves original refund commands under canonical deletion authority. Provider reads are committed only against unchanged command state and an expired execution lease. */
import { eq, sql } from "drizzle-orm";
import type { BillingProviderObservation } from "../../lib/services/generic-billing-provider-types";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import {
  type AppBillingRefundObservationValue,
  appBillingRefundObservations,
} from "../schemas/app-billing-refund-observations";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import { appBillingAdminFailure } from "./app-billing-admin";
import type { AppBillingDeletionRecoveryAuthority } from "./app-billing-deletion-authority";
import { lockHistoricalAppBillingRefundSource } from "./app-billing-refund-source";
import { readPostLockDatabaseNow } from "./primary-database-clock";

async function locked(
  tx: DbTransaction,
  commandId: string,
  authority: AppBillingDeletionRecoveryAuthority,
) {
  if (authority.kind !== "account_deletion")
    appBillingAdminFailure("Canonical deletion authority is required", "FORBIDDEN");
  await tx.execute(
    sql`SELECT require_app_billing_refund_recovery(${commandId}::uuid,${authority.requestId}::uuid,${authority.requestDigest},${authority.lifecycleRevision},${authority.phaseReceiptId}::uuid,${authority.phaseGeneration})`,
  );
  const [command] = await tx
    .select()
    .from(billingSubscriptionCommands)
    .where(eq(billingSubscriptionCommands.id, commandId));
  if (
    !command ||
    command.request_payload?.domain !== "admin" ||
    command.request_payload.action !== "refund" ||
    !command.app_id ||
    command.livemode === null
  )
    appBillingAdminFailure("Original refund command is unavailable");
  const payload = command.request_payload;
  const source = await lockHistoricalAppBillingRefundSource(
    tx,
    { appId: command.app_id, organizationId: command.organization_id },
    payload.source.paidPeriodId,
    command.livemode,
  );
  const identity = (value: typeof source) => ({
    paidPeriodId: value.paidPeriodId,
    merchant: value.merchant,
    scope: value.scope,
    invoice: value.invoice,
  });
  if (settlementDigest(identity(source)) !== settlementDigest(identity(payload.source)))
    appBillingAdminFailure("Original refund payment identity changed", "FORBIDDEN");
  return { command, payload, source, now: await readPostLockDatabaseNow(tx) };
}
export const appBillingDeletionRefundRepository = {
  async inspect(commandId: string, authority: AppBillingDeletionRecoveryAuthority) {
    return writeTransaction(async (tx) => {
      const value = await locked(tx, commandId, authority);
      if (value.command.status === "PREPARED") {
        await tx.execute(
          sql`SELECT supersede_app_billing_refund_for_deletion(${commandId}::uuid,${authority.requestId}::uuid,${authority.requestDigest},${authority.lifecycleRevision},${authority.phaseReceiptId}::uuid,${authority.phaseGeneration})`,
        );
        return { kind: "superseded" as const };
      }
      if (value.command.status === "SUPERSEDED") return { kind: "superseded" as const };
      if (!["OUTCOME_UNKNOWN", "SUCCEEDED"].includes(value.command.status))
        appBillingAdminFailure("Refund is not eligible for historical provider recovery");
      if (
        value.command.lease_expires_at !== null &&
        (!Number.isFinite(value.command.lease_expires_at.getTime()) ||
          value.command.lease_expires_at > value.now)
      )
        return { kind: "leased" as const };
      return { kind: "read" as const, ...value };
    });
  },
  async record(
    snapshot: Awaited<ReturnType<typeof locked>>,
    authority: AppBillingDeletionRecoveryAuthority,
    observation: BillingProviderObservation<AppBillingRefundObservationValue>,
    discovery: BillingProviderObservation<{
      status: "found";
      object: AppBillingRefundObservationValue;
    }> | null,
  ) {
    return writeTransaction(async (tx) => {
      const current = await locked(tx, snapshot.command.id, authority);
      if (
        current.command.state_revision !== snapshot.command.state_revision ||
        current.command.execution_generation !== snapshot.command.execution_generation ||
        current.command.lease_token !== snapshot.command.lease_token ||
        current.command.lease_expires_at?.getTime() !== snapshot.command.lease_expires_at?.getTime()
      )
        appBillingAdminFailure("Refund observation lost its original command snapshot");
      const [record] = await tx
        .insert(appBillingRefundObservations)
        .values({
          command_id: current.command.id,
          request_id: authority.requestId,
          request_digest: authority.requestDigest,
          lifecycle_revision: authority.lifecycleRevision,
          phase_receipt_id: authority.phaseReceiptId,
          phase_generation: authority.phaseGeneration,
          command_revision: current.command.state_revision,
          execution_generation: current.command.execution_generation,
          observation,
          discovery,
        })
        .returning();
      if (!record) appBillingAdminFailure("Refund observation was not retained");
      return record;
    });
  },
};
