/** Original paid-upgrade authority under organization-first transaction locks. No provider I/O. */
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { observePaidOrganizationUpgradeInvoice } from "../../lib/services/organization-upgrade-invoice";
import {
  organizationUpgradeIntentDigest,
  organizationUpgradeProviderBindingSchema,
} from "../../lib/services/organization-upgrade-provider-binding";
import { observeAppliedOrganizationUpgrade } from "../../lib/services/organization-upgrade-target";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import {
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import { organizationUpgradeInvoiceOrigins } from "../schemas/organization-upgrade-invoice-origins";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";
export interface OrganizationUpgradeSettlementIdentity {
  organizationId: string;
  commandId: string;
  leaseToken: string;
  executionGeneration: number;
}
export function upgradeSettlementConflict(reason: string): never {
  throw new ElizaError("Paid organization upgrade requires original current settlement authority", {
    code: "SUBSCRIPTION_UPGRADE_SETTLEMENT_CONFLICT",
    context: { reason },
  });
}
export async function lockOrganizationUpgradeSettlement(
  tx: DbTransaction,
  input: OrganizationUpgradeSettlementIdentity & { rawInvoice: unknown; rawSubscription: unknown },
) {
  const [org] = await tx
    .select({
      id: organizations.id,
      is_active: organizations.is_active,
      account_lifecycle_state: organizations.account_lifecycle_state,
      account_deletion_request_id: organizations.account_deletion_request_id,
      paid_work_fenced_at: organizations.paid_work_fenced_at,
      stripe_customer_id: organizations.stripe_customer_id,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("update");
  if (
    !org ||
    !org.is_active ||
    org.account_lifecycle_state !== "active" ||
    org.account_deletion_request_id !== null ||
    org.paid_work_fenced_at !== null
  )
    upgradeSettlementConflict("organization_fenced");
  const [association] = await tx
    .select()
    .from(organizationSubscriptionAuthorities)
    .where(eq(organizationSubscriptionAuthorities.organization_id, input.organizationId))
    .for("update");
  const [command] = await tx
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.organization_id, input.organizationId),
        eq(commands.id, input.commandId),
        isNull(commands.app_id),
        isNull(commands.billing_scope_id),
      ),
    )
    .for("update");
  const now = await readPostLockDatabaseNow(tx);
  if (
    !command ||
    command.kind !== "upgrade" ||
    command.merchant_key !== "platform" ||
    command.status !== "OUTCOME_UNKNOWN" ||
    command.organization_upgrade_dispatch_state !== "started" ||
    !command.subscription_id ||
    command.expected_subscription_revision === null ||
    command.lease_token !== input.leaseToken ||
    command.execution_generation !== input.executionGeneration ||
    !command.lease_expires_at ||
    command.lease_expires_at <= now
  )
    upgradeSettlementConflict("original_lease_unavailable");
  if (
    !association ||
    association.state !== "current" ||
    association.subscription_id !== command.subscription_id
  )
    upgradeSettlementConflict("current_association_changed");
  const [quote] = await tx
    .select()
    .from(organizationPlanChangeQuotes)
    .where(
      and(
        eq(organizationPlanChangeQuotes.organization_id, input.organizationId),
        eq(organizationPlanChangeQuotes.consumed_by_command_id, command.id),
      ),
    )
    .for("update");
  if (
    !quote ||
    quote.actor_id !== command.requested_by_user_id ||
    quote.subscription_id !== command.subscription_id ||
    quote.subscription_revision !== command.expected_subscription_revision ||
    quote.target_plan_key !== command.target_plan_key ||
    quote.review_digest !== settlementDigest(quote.review) ||
    command.request_digest !==
      organizationUpgradeIntentDigest({
        organizationId: input.organizationId,
        actorId: command.requested_by_user_id,
        quoteId: quote.id,
        reviewDigest: quote.review_digest,
        sourceDigest: quote.source_digest,
        providerBinding: quote.provider_binding,
      })
  )
    upgradeSettlementConflict("original_review_changed");
  const binding = organizationUpgradeProviderBindingSchema.parse(quote.provider_binding);
  const [origin] = await tx
    .select()
    .from(organizationUpgradeInvoiceOrigins)
    .where(
      and(
        eq(organizationUpgradeInvoiceOrigins.organization_id, input.organizationId),
        eq(organizationUpgradeInvoiceOrigins.command_id, command.id),
      ),
    );
  if (
    !origin ||
    origin.provider_idempotency_key !== command.provider_idempotency_key ||
    origin.livemode !== binding.livemode
  )
    upgradeSettlementConflict("original_invoice_unavailable");
  const [source] = await tx
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.organization_id, input.organizationId),
        eq(billingSubscriptions.id, command.subscription_id),
        isNull(billingSubscriptions.billing_scope_id),
      ),
    )
    .for("update");
  if (
    !source ||
    source.lifecycle_revision !== command.expected_subscription_revision ||
    source.stripe_customer_id !== org.stripe_customer_id ||
    source.stripe_customer_id !== origin.customer_id ||
    source.stripe_subscription_id !== origin.subscription_id
  )
    upgradeSettlementConflict("current_source_changed");
  const [projection] = await tx
    .select()
    .from(organizationEntitlements)
    .where(
      and(
        eq(organizationEntitlements.organization_id, input.organizationId),
        isNull(organizationEntitlements.billing_scope_id),
      ),
    )
    .for("update");
  if (
    !projection ||
    projection.source_subscription_id !== source.id ||
    projection.source_subscription_revision !== source.lifecycle_revision
  )
    upgradeSettlementConflict("projection_changed");
  const paid = observePaidOrganizationUpgradeInvoice({
    raw: input.rawInvoice,
    expectedInvoiceId: origin.invoice_id,
    source,
    review: quote.review,
    binding,
    observedAt: now,
  });
  const target = observeAppliedOrganizationUpgrade({
    raw: input.rawSubscription,
    source,
    review: quote.review,
    binding,
    observedAt: now,
  });
  return { command, quote, origin, source, projection, paid, target, now };
}
