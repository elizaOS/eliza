/** System-only original upgrade context. No dispatch permission or current-price reconstruction. */
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { organizationUpgradeReviewSchema } from "../../lib/services/organization-plan-change-contract";
import {
  organizationUpgradeIntentDigest,
  organizationUpgradeProviderBindingSchema,
} from "../../lib/services/organization-upgrade-provider-binding";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { billingSubscriptionRevisions as revisions } from "../schemas/billing-subscriptions";
import { organizationPlanChangeQuotes as quotes } from "../schemas/organization-plan-change-quotes";
import { organizationUpgradeHistoricalTargets as targets } from "../schemas/organization-upgrade-historical-targets";
import { organizationUpgradeInvoiceOrigins as origins } from "../schemas/organization-upgrade-invoice-origins";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";

function reject(): never {
  throw new ElizaError("Original upgrade recovery context is unavailable", {
    code: "SUBSCRIPTION_UPGRADE_RECOVERY_CONTEXT_UNAVAILABLE",
  });
}
export async function readOrganizationUpgradeRecoveryContext(
  input: {
    organizationId: string;
    commandId: string;
  },
  reader: Pick<DbTransaction, "select"> = dbWrite,
) {
  const [command] = await reader
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.organization_id, input.organizationId),
        eq(commands.id, input.commandId),
        isNull(commands.app_id),
        isNull(commands.billing_scope_id),
      ),
    );
  if (
    !command ||
    command.kind !== "upgrade" ||
    command.merchant_key !== "platform" ||
    (command.status !== "OUTCOME_UNKNOWN" &&
      command.status !== "APPLIED" &&
      !(command.status === "FAILED" && command.organization_upgrade_failure_evidence !== null)) ||
    command.organization_upgrade_dispatch_state !== "started" ||
    !command.subscription_id ||
    command.expected_subscription_revision === null
  )
    reject();
  const [quote] = await reader
    .select()
    .from(quotes)
    .where(
      and(
        eq(quotes.organization_id, input.organizationId),
        eq(quotes.consumed_by_command_id, command.id),
      ),
    );
  if (
    !quote ||
    quote.actor_id !== command.requested_by_user_id ||
    quote.subscription_id !== command.subscription_id ||
    quote.subscription_revision !== command.expected_subscription_revision ||
    quote.target_plan_key !== command.target_plan_key ||
    quote.review_digest !== settlementDigest(quote.review)
  )
    reject();
  const review = organizationUpgradeReviewSchema.parse(quote.review);
  const binding = organizationUpgradeProviderBindingSchema.parse(quote.provider_binding);
  if (
    command.request_digest !==
    organizationUpgradeIntentDigest({
      organizationId: input.organizationId,
      actorId: command.requested_by_user_id,
      quoteId: quote.id,
      reviewDigest: quote.review_digest,
      sourceDigest: quote.source_digest,
      providerBinding: binding,
    })
  )
    reject();
  const [source] = await reader
    .select()
    .from(revisions)
    .where(
      and(
        eq(revisions.organization_id, input.organizationId),
        eq(revisions.subscription_id, command.subscription_id),
        eq(revisions.revision, command.expected_subscription_revision),
      ),
    );
  if (
    !source ||
    source.billing_scope_id !== null ||
    source.merchant_key !== "platform" ||
    source.provider !== "stripe" ||
    binding.livemode !== (source.provider_environment === "live")
  )
    reject();
  const [origin] = await reader
    .select()
    .from(origins)
    .where(
      and(
        eq(origins.organization_id, input.organizationId),
        eq(origins.command_id, input.commandId),
      ),
    );
  const [historicalTarget] = await reader
    .select()
    .from(targets)
    .where(
      and(
        eq(targets.organization_id, input.organizationId),
        eq(targets.command_id, input.commandId),
      ),
    );
  return {
    historicalTarget: historicalTarget ?? null,
    command,
    historicalSource: source,
    quote: { ...quote, review },
    binding,
    origin: origin ?? null,
    originalRequest: {
      providerIdempotencyKey: command.provider_idempotency_key,
      customerId: source.stripe_customer_id,
      subscriptionId: source.stripe_subscription_id,
      livemode: binding.livemode,
      prorationDate: review.prorationDate,
    },
    canDispatch: false as const,
  };
}
