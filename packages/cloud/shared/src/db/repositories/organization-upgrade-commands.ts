/** Admits an explicitly confirmed organization quote into the existing command journal. No provider I/O. */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { organizationUpgradeIntentDigest } from "../../lib/services/organization-upgrade-provider-binding";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { writeTransaction } from "../helpers";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import {
  type BillingSubscriptionCommand,
  billingSubscriptionCommands,
} from "../schemas/subscription-billing-operations";
import { lockOrganizationPlanChangeSource } from "./organization-plan-change";
import {
  lockOrganizationSubscriptionManager,
  type OrganizationSubscriptionIdentity,
} from "./organization-subscription-manager";
import { assertCurrentOrganizationUpgradeQuote } from "./organization-upgrade-quotes";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export interface ConfirmOrganizationUpgradeInput extends OrganizationSubscriptionIdentity {
  quoteId: string;
  idempotencyKey: string;
}
function reject(reason: string): never {
  throw new ElizaError("Organization upgrade confirmation requires its original current review", {
    code:
      reason === "current_manager_required" || reason === "organization_authority_unavailable"
        ? "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN"
        : "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    context: { reason },
  });
}
/** Same quote always returns its original command, including after expiry or a changed retry key. */
export async function prepareOrganizationUpgrade(
  input: ConfirmOrganizationUpgradeInput,
): Promise<{ command: BillingSubscriptionCommand; created: boolean }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey))
    reject("invalid_idempotency_key");
  return writeTransaction(async (tx) => {
    await lockOrganizationSubscriptionManager(tx, input, reject);
    const [quote] = await tx
      .select()
      .from(organizationPlanChangeQuotes)
      .where(
        and(
          eq(organizationPlanChangeQuotes.id, input.quoteId),
          eq(organizationPlanChangeQuotes.organization_id, input.organizationId),
          eq(organizationPlanChangeQuotes.actor_id, input.actorId),
        ),
      )
      .for("update");
    if (!quote || quote.review_digest !== settlementDigest(quote.review))
      reject("quote_unavailable");
    const digest = organizationUpgradeIntentDigest({
      organizationId: input.organizationId,
      actorId: input.actorId,
      quoteId: quote.id,
      reviewDigest: quote.review_digest,
      sourceDigest: quote.source_digest,
      providerBinding: quote.provider_binding,
    });
    const [existing] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          isNull(billingSubscriptionCommands.app_id),
          isNull(billingSubscriptionCommands.billing_scope_id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.idempotency_key, input.idempotencyKey),
        ),
      )
      .for("update");
    function assertOriginal(command: BillingSubscriptionCommand | undefined) {
      if (
        !command ||
        command.kind !== "upgrade" ||
        command.app_id !== null ||
        command.billing_scope_id !== null ||
        command.requested_by_user_id !== input.actorId ||
        command.organization_id !== input.organizationId ||
        command.subscription_id !== quote.subscription_id ||
        command.expected_subscription_revision !== quote.subscription_revision ||
        command.target_plan_key !== quote.target_plan_key ||
        command.request_digest !== digest ||
        command.id !== quote.consumed_by_command_id
      )
        reject("idempotency_intent_changed");
      return command;
    }
    if (existing) return { command: assertOriginal(existing), created: false };
    if (quote.consumed_by_command_id !== null) {
      const [original] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, quote.consumed_by_command_id),
            eq(billingSubscriptionCommands.organization_id, input.organizationId),
          ),
        )
        .for("update");
      return { command: assertOriginal(original), created: false };
    }
    const captured = await lockOrganizationPlanChangeSource(tx, {
      ...input,
      subscriptionId: quote.subscription_id,
      expectedSubscriptionRevision: quote.subscription_revision,
    });
    const now = await readPostLockDatabaseNow(tx);
    assertCurrentOrganizationUpgradeQuote(quote, captured, now);
    const id = randomUUID();
    const [command] = await tx
      .insert(billingSubscriptionCommands)
      .values({
        id,
        organization_id: input.organizationId,
        requested_by_user_id: input.actorId,
        subscription_id: quote.subscription_id,
        expected_subscription_revision: quote.subscription_revision,
        kind: "upgrade",
        organization_upgrade_dispatch_state: "ready",
        target_plan_key: quote.target_plan_key,
        idempotency_key: input.idempotencyKey,
        provider_idempotency_key: `organization-upgrade:${id}`,
        request_digest: digest,
        created_at: now,
        updated_at: now,
      })
      .returning();
    if (!command) reject("command_insert_failed");
    await tx
      .update(organizationPlanChangeQuotes)
      .set({ consumed_by_command_id: command.id, consumed_at: now })
      .where(eq(organizationPlanChangeQuotes.id, quote.id));
    return { command, created: true };
  });
}
