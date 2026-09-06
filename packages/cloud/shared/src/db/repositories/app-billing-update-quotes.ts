/** Stores reviewed provider prices and consumes them under the same scope lock as subscription changes. */
import { and, eq, isNull } from "drizzle-orm";
import type { BillingProviderUpdatePreview } from "../../lib/services/generic-billing-provider-types";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { appBillingSeats } from "../schemas/app-billing";
import { appBillingQuotes } from "../schemas/app-billing-quotes";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import type { AppCommandLease } from "./app-billing-command-runtime";
import {
  type AppBillingDeletionRecoveryAuthority,
  requireAppBillingDeletionRecovery,
} from "./app-billing-deletion-authority";
import {
  appBillingConflict,
  lockAppBillingScope,
  planForScope,
  requireAppBillingAdministrator,
} from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export class AppBillingUpdateQuotesRepository {
  async save(input: {
    scopeId: string;
    actorUserId: string;
    subscriptionId: string;
    subscriptionRevision: number;
    planRevisionId: string;
    quantity: number;
    preview: BillingProviderUpdatePreview;
  }) {
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, input.scopeId);
      await requireAppBillingAdministrator(tx, scope, input.actorUserId);
      const plan = await planForScope(tx, scope, input.planRevisionId);
      const [subscription] = await tx
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.id, input.subscriptionId),
            eq(billingSubscriptions.billing_scope_id, scope.scopeId),
          ),
        )
        .for("update");
      const seats = await tx
        .select({ id: appBillingSeats.id })
        .from(appBillingSeats)
        .where(
          and(
            eq(appBillingSeats.billing_scope_id, scope.scopeId),
            isNull(appBillingSeats.revoked_at),
          ),
        );
      if (
        !subscription ||
        subscription.lifecycle_revision !== input.subscriptionRevision ||
        input.quantity < Math.max(plan.minimum_quantity, seats.length) ||
        input.quantity > plan.maximum_quantity
      )
        appBillingConflict("Subscription or assigned seats changed while reviewing this quote");
      const now = await readPostLockDatabaseNow(tx);
      const [quote] = await tx
        .insert(appBillingQuotes)
        .values({
          app_id: scope.appId,
          billing_scope_id: scope.scopeId,
          actor_user_id: input.actorUserId,
          subscription_id: subscription.id,
          subscription_revision: input.subscriptionRevision,
          plan_revision_id: plan.id,
          quantity: input.quantity,
          merchant_id: scope.merchantId,
          livemode: scope.livemode,
          provider_preview: input.preview,
          digest: settlementDigest(input.preview),
          created_at: now,
          expires_at: new Date(now.getTime() + 300_000),
        })
        .returning();
      if (!quote) appBillingConflict("Reviewed billing quote was not persisted");
      return quote;
    });
  }

  /** Recovers the immutable quote consumed by this execution without transferring its original actor. */
  async getForCommand(
    lease: AppCommandLease & { deletionAuthority?: AppBillingDeletionRecoveryAuthority },
  ) {
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, lease.scopeId, true);
      const [command] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, lease.commandId),
            eq(billingSubscriptionCommands.billing_scope_id, lease.scopeId),
          ),
        )
        .for("update");
      const now = await readPostLockDatabaseNow(tx);
      if (
        !command ||
        command.app_id !== scope.appId ||
        command.livemode !== scope.livemode ||
        command.lease_token !== lease.token ||
        command.state_revision !== lease.stateRevision ||
        command.execution_generation !== lease.executionGeneration ||
        command.lease_expires_at === null ||
        command.lease_expires_at <= now ||
        !["OUTCOME_UNKNOWN", "SUCCEEDED"].includes(command.status) ||
        command.request_payload?.domain !== "buyer" ||
        command.request_payload.action !== "update"
      )
        appBillingConflict("Reviewed quote lost its original update execution lease");
      if (lease.deletionAuthority)
        await requireAppBillingDeletionRecovery(tx, lease.deletionAuthority, command);
      else await requireAppBillingAdministrator(tx, scope, command.requested_by_user_id);
      const [quote] = await tx
        .select()
        .from(appBillingQuotes)
        .where(
          and(
            eq(appBillingQuotes.id, command.request_payload.quoteId),
            eq(appBillingQuotes.billing_scope_id, scope.scopeId),
          ),
        );
      if (
        !quote ||
        quote.actor_user_id !== command.requested_by_user_id ||
        quote.consumed_by_command_id !== command.id ||
        quote.subscription_id !== command.subscription_id ||
        quote.subscription_revision !== command.expected_subscription_revision ||
        quote.plan_revision_id !== command.target_plan_revision_id ||
        quote.quantity !== command.target_quantity ||
        quote.app_id !== scope.appId ||
        quote.merchant_id !== scope.merchantId ||
        quote.livemode !== scope.livemode ||
        settlementDigest(quote.provider_preview) !== quote.digest
      )
        appBillingConflict("Reviewed billing quote no longer matches its original update command");
      return quote;
    });
  }

  async get(scopeId: string, quoteId: string, actorUserId: string) {
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, scopeId, true);
      await requireAppBillingAdministrator(tx, scope, actorUserId);
      const [quote] = await tx
        .select()
        .from(appBillingQuotes)
        .where(
          and(
            eq(appBillingQuotes.id, quoteId),
            eq(appBillingQuotes.billing_scope_id, scopeId),
            eq(appBillingQuotes.actor_user_id, actorUserId),
          ),
        );
      if (!quote || settlementDigest(quote.provider_preview) !== quote.digest)
        appBillingConflict("Reviewed billing quote is unavailable or inconsistent");
      return quote;
    });
  }
}

export async function consumeAppBillingQuote(
  tx: DbTransaction,
  input: {
    quoteId: string;
    scopeId: string;
    actorUserId: string;
    commandId: string;
    subscriptionId: string;
    subscriptionRevision: number;
    planRevisionId: string;
    quantity: number;
  },
) {
  const [quote] = await tx
    .select()
    .from(appBillingQuotes)
    .where(
      and(
        eq(appBillingQuotes.id, input.quoteId),
        eq(appBillingQuotes.billing_scope_id, input.scopeId),
      ),
    )
    .for("update");
  const now = await readPostLockDatabaseNow(tx);
  if (
    !quote ||
    quote.actor_user_id !== input.actorUserId ||
    quote.subscription_id !== input.subscriptionId ||
    quote.subscription_revision !== input.subscriptionRevision ||
    quote.plan_revision_id !== input.planRevisionId ||
    quote.quantity !== input.quantity ||
    quote.expires_at <= now ||
    quote.consumed_by_command_id !== null ||
    settlementDigest(quote.provider_preview) !== quote.digest
  )
    appBillingConflict("Review a fresh subscription quote before confirming this change");
  const seats = await tx
    .select({ id: appBillingSeats.id })
    .from(appBillingSeats)
    .where(
      and(eq(appBillingSeats.billing_scope_id, input.scopeId), isNull(appBillingSeats.revoked_at)),
    );
  if (input.quantity < seats.length)
    appBillingConflict("Remove assigned seats before reducing subscription quantity");
  await tx
    .update(appBillingQuotes)
    .set({ consumed_by_command_id: input.commandId, consumed_at: now })
    .where(eq(appBillingQuotes.id, quote.id));
}

export const appBillingUpdateQuotesRepository = new AppBillingUpdateQuotesRepository();
