/** Reconciles every original refund implicated by canonical account deletion. Discovery selects existing commands; the refund repository independently validates payment ownership and deletion authority before any provider read. */
import { asc, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { billingSubscriptionCommands } from "../../db/schemas/subscription-billing-operations";
import { logger } from "../utils/logger";
import type { AccountDeletionProviderContext } from "./account-deletion-saga";
import { recoverAppBillingRefundForDeletion } from "./app-billing-deletion-refund";

export type AppBillingDeletionRefund = typeof recoverAppBillingRefundForDeletion;
export async function recoverAppBillingRefundsForAccountDeletion(
  context: Pick<
    AccountDeletionProviderContext,
    "requestId" | "requestDigest" | "lifecycleRevision" | "phaseReceiptId" | "phaseGeneration"
  >,
  recover: AppBillingDeletionRefund = recoverAppBillingRefundForDeletion,
): Promise<"complete" | "pending"> {
  const commands = await dbWrite
    .select({ id: billingSubscriptionCommands.id })
    .from(billingSubscriptionCommands)
    .where(
      sql`${billingSubscriptionCommands.id} IN (SELECT command_id FROM app_billing_deletion_refund_inventory(${context.requestId}::uuid))`,
    )
    .orderBy(asc(billingSubscriptionCommands.id));
  let pending = false;
  for (const command of commands) {
    try {
      const result = await recover(command.id, { kind: "account_deletion", ...context });
      if (result.status === "unresolved") pending = true;
    } catch (error) {
      // error-policy:J1 Invalid authority or ambiguous provider evidence keeps the deletion phase pending.
      logger.warn("[AppBillingRefundDeletion] Original refund remains unresolved", {
        commandId: command.id,
        error,
      });
      pending = true;
    }
  }
  return pending ? "pending" : "complete";
}
