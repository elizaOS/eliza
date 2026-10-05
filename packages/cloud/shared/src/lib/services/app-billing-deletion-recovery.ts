/** Retires unstarted purchaser intent and reconciles dispatched commands before deletion releases live membership. Original journal identity remains immutable; cleanup never authorizes a new purchase. */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { appBillingCommandRuntimeRepository } from "../../db/repositories/app-billing-command-runtime";
import { billingSubscriptionCommands } from "../../db/schemas/subscription-billing-operations";
import type { AccountDeletionProviderContext } from "./account-deletion-saga";
import { expirePurchaserCheckoutForDeletion } from "./app-billing-deletion-checkout";
import { type GenericBillingRuntime, genericBillingRuntime } from "./generic-billing-runtime";

export type AppBillingDeletionRuntime = Pick<GenericBillingRuntime, "run">;
export type AppBillingDeletionCheckout = typeof expirePurchaserCheckoutForDeletion;

async function pendingPurchaserCommands(userId: string) {
  const rows = await dbWrite
    .select()
    .from(billingSubscriptionCommands)
    .where(
      and(
        eq(billingSubscriptionCommands.requested_by_user_id, userId),
        isNotNull(billingSubscriptionCommands.billing_scope_id),
        inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
        sql`${billingSubscriptionCommands.request_payload}->>'domain' = 'buyer'`,
      ),
    )
    .orderBy(asc(billingSubscriptionCommands.created_at), asc(billingSubscriptionCommands.id));
  return rows.filter(
    (command) =>
      !(command.status === "SUCCEEDED" && ["portal", "expire_checkout"].includes(command.kind)),
  );
}

export async function recoverAppBillingForAccountDeletion(
  context: Pick<
    AccountDeletionProviderContext,
    | "userId"
    | "requestId"
    | "requestDigest"
    | "lifecycleRevision"
    | "phaseReceiptId"
    | "phaseGeneration"
  >,
  runtime: AppBillingDeletionRuntime = genericBillingRuntime,
  expireCheckout: AppBillingDeletionCheckout = expirePurchaserCheckoutForDeletion,
): Promise<"complete" | "pending"> {
  const commands = await pendingPurchaserCommands(context.userId);
  for (const command of commands) {
    if (command.billing_scope_id === null)
      throw new ElizaError("App deletion recovery lost its command scope", {
        code: "APP_BILLING_DELETION_COMMAND_SCOPE_MISSING",
      });
    if (command.status === "PREPARED") {
      await appBillingCommandRuntimeRepository.supersedePreparedForDeletion({
        scopeId: command.billing_scope_id,
        commandId: command.id,
        expectedStateRevision: command.state_revision,
        authority: {
          kind: "account_deletion",
          requestId: context.requestId,
          requestDigest: context.requestDigest,
          lifecycleRevision: context.lifecycleRevision,
          phaseReceiptId: context.phaseReceiptId,
          phaseGeneration: context.phaseGeneration,
        },
      });
      continue;
    }
    if (command.provider_started_at === null) continue;
    if (
      command.request_payload?.action === "checkout" &&
      command.provider_result?.kind === "checkout"
    ) {
      const expired = await expireCheckout(command.id, {
        kind: "account_deletion_checkout_expiry",
        requestId: context.requestId,
        requestDigest: context.requestDigest,
        lifecycleRevision: context.lifecycleRevision,
        phaseReceiptId: context.phaseReceiptId,
        phaseGeneration: context.phaseGeneration,
      });
      if (expired === "complete") continue;
    }
    await runtime.run({
      scopeId: command.billing_scope_id,
      commandId: command.id,
      deletionAuthority: {
        kind: "account_deletion",
        requestId: context.requestId,
        requestDigest: context.requestDigest,
        lifecycleRevision: context.lifecycleRevision,
        phaseReceiptId: context.phaseReceiptId,
        phaseGeneration: context.phaseGeneration,
      },
    });
  }
  const cleanup = await dbWrite
    .select({ payload: billingSubscriptionCommands.request_payload })
    .from(billingSubscriptionCommands)
    .where(
      and(
        eq(billingSubscriptionCommands.requested_by_user_id, context.userId),
        inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN"]),
        sql`${billingSubscriptionCommands.request_payload}->>'domain' = 'account_deletion'`,
        sql`${billingSubscriptionCommands.request_payload}->>'requestId' = ${context.requestId}`,
      ),
    );
  const visited = new Set(commands.map((command) => command.id));
  for (const row of cleanup) {
    if (
      row.payload?.domain !== "account_deletion" ||
      row.payload.action !== "expire_checkout" ||
      visited.has(row.payload.sourceCommandId)
    )
      continue;
    await expireCheckout(row.payload.sourceCommandId, {
      kind: "account_deletion_checkout_expiry",
      requestId: context.requestId,
      requestDigest: context.requestDigest,
      lifecycleRevision: context.lifecycleRevision,
      phaseReceiptId: context.phaseReceiptId,
      phaseGeneration: context.phaseGeneration,
    });
  }
  const [remainingCleanup] = await dbWrite
    .select({ id: billingSubscriptionCommands.id })
    .from(billingSubscriptionCommands)
    .where(
      and(
        eq(billingSubscriptionCommands.requested_by_user_id, context.userId),
        inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN"]),
        sql`${billingSubscriptionCommands.request_payload}->>'domain' = 'account_deletion'`,
        sql`${billingSubscriptionCommands.request_payload}->>'requestId' = ${context.requestId}`,
      ),
    );
  return !remainingCleanup && (await pendingPurchaserCommands(context.userId)).length === 0
    ? "complete"
    : "pending";
}
