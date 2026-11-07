/** Publishes a definitive unpaid original outcome without changing financial authority. */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  observeVoidedOrganizationUpgrade,
  voidUpgradeUnavailable as reject,
} from "../../lib/services/organization-upgrade-void-observation";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { writeTransaction } from "../helpers";
import {
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import type { OrganizationUpgradeSettlementIdentity } from "./organization-upgrade-paid-authority";
import { readOrganizationUpgradeRecoveryContext } from "./organization-upgrade-recovery-context";
import { resolveVoidedUpgradeIncidentsInTransaction } from "./organization-upgrade-recovery-incidents";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export async function finalizeVoidedOrganizationUpgrade(
  input: OrganizationUpgradeSettlementIdentity & {
    rawInvoice: unknown;
    rawSubscription: unknown;
    rawPaymentIntent: unknown;
  },
) {
  return writeTransaction(async (tx) => {
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
      reject("organization_fenced");
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
    if (
      !command ||
      command.kind !== "upgrade" ||
      command.merchant_key !== "platform" ||
      command.organization_upgrade_dispatch_state !== "started"
    )
      reject("original_command_unavailable");
    if (command.status === "FAILED" && command.organization_upgrade_failure_evidence !== null) {
      await resolveVoidedUpgradeIncidentsInTransaction(tx, input);
      return { command, replayed: true };
    }
    if (
      command.status !== "OUTCOME_UNKNOWN" ||
      command.lease_token !== input.leaseToken ||
      command.execution_generation !== input.executionGeneration ||
      !command.lease_expires_at
    )
      reject("original_lease_unavailable");
    const context = await readOrganizationUpgradeRecoveryContext(input, tx);
    if (!context.origin || context.historicalTarget) reject("missing_origin_or_conflicting_target");
    if (
      !association ||
      association.state !== "current" ||
      association.subscription_id !== command.subscription_id
    )
      reject("current_association_changed");
    const [source] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.id, command.subscription_id!),
          eq(billingSubscriptions.organization_id, input.organizationId),
        ),
      )
      .for("update");
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
      !source ||
      source.lifecycle_revision !== command.expected_subscription_revision ||
      source.stripe_customer_id !== org.stripe_customer_id ||
      !projection ||
      projection.source_subscription_id !== source.id ||
      projection.source_subscription_revision !== source.lifecycle_revision
    )
      reject("current_source_or_projection_changed");
    const now = await readPostLockDatabaseNow(tx);
    if (command.lease_expires_at <= now) reject("original_lease_unavailable");
    const proof = observeVoidedOrganizationUpgrade({
      ...input,
      source,
      review: context.quote.review,
      binding: context.binding,
      origin: context.origin,
      observedAt: now,
    });
    const [failed] = await tx
      .update(commands)
      .set({
        status: "FAILED",
        error_code: "ORIGINAL_UPGRADE_INVOICE_VOID",
        organization_upgrade_failure_evidence: proof,
        provider_response_digest: settlementDigest(proof),
        lease_token: null,
        lease_expires_at: null,
        state_revision: command.state_revision + 1,
        completed_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(commands.id, command.id),
          eq(commands.organization_id, input.organizationId),
          eq(commands.status, "OUTCOME_UNKNOWN"),
          eq(commands.lease_token, input.leaseToken),
          eq(commands.execution_generation, input.executionGeneration),
          gt(commands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!failed) reject("lease_lost_before_commit");
    await resolveVoidedUpgradeIncidentsInTransaction(tx, input);
    return { command: failed, replayed: false };
  });
}
