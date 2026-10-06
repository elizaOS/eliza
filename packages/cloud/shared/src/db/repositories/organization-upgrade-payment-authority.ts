/** Current-manager gate for ephemeral original-invoice continuation. Never admits a new command. */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { OrganizationUpgradeReview } from "../../lib/services/organization-plan-change-contract";
import type { OrganizationUpgradeProviderBinding } from "../../lib/services/organization-upgrade-provider-binding";
import { writeTransaction } from "../helpers";
import type { BillingSubscription } from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import type { organizationUpgradeInvoiceOrigins } from "../schemas/organization-upgrade-invoice-origins";
import {
  type BillingSubscriptionCommand,
  billingSubscriptionCommands as commands,
} from "../schemas/subscription-billing-operations";
import {
  lockCurrentOrganizationSubscription,
  lockOrganizationSubscriptionManager,
  type OrganizationSubscriptionIdentity,
} from "./organization-subscription-manager";
import { readOrganizationUpgradeRecoveryContext } from "./organization-upgrade-recovery-context";
import { readPostLockDatabaseNow } from "./primary-database-clock";

function reject(reason: string): never {
  throw new ElizaError("Original upgrade payment authority is unavailable", {
    code:
      reason === "current_manager_required" || reason === "organization_authority_unavailable"
        ? "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN"
        : "SUBSCRIPTION_UPGRADE_PAYMENT_UNAVAILABLE",
    context: { reason },
  });
}
export type OrganizationUpgradePaymentAuthority = {
  command: BillingSubscriptionCommand;
  pending: {
    source: BillingSubscription;
    review: OrganizationUpgradeReview;
    binding: OrganizationUpgradeProviderBinding;
    origin: typeof organizationUpgradeInvoiceOrigins.$inferSelect;
    observedAt: Date;
  } | null;
};
/** The synchronous projection runs under the authority locks. Provider I/O belongs outside this transaction. */
export async function withOrganizationUpgradePaymentAuthority<T>(
  input: OrganizationSubscriptionIdentity & { commandId: string },
  project: (authority: OrganizationUpgradePaymentAuthority) => T,
): Promise<T> {
  return writeTransaction(async (tx) => {
    const locked = await lockOrganizationSubscriptionManager(tx, input, reject);
    const [command] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.organization_id, input.organizationId),
          eq(commands.id, input.commandId),
          isNull(commands.app_id),
          isNull(commands.billing_scope_id),
          eq(commands.merchant_key, "platform"),
          eq(commands.kind, "upgrade"),
        ),
      )
      .for("update");
    if (!command)
      throw new ElizaError("Organization upgrade command not found", {
        code: "SUBSCRIPTION_UPGRADE_NOT_FOUND",
      });
    if (
      command.status !== "OUTCOME_UNKNOWN" ||
      command.organization_upgrade_dispatch_state !== "started"
    )
      return project({ command, pending: null });
    const context = await readOrganizationUpgradeRecoveryContext(input, tx);
    if (
      !context.origin ||
      context.historicalTarget ||
      !command.subscription_id ||
      command.expected_subscription_revision === null
    )
      reject("missing_origin_or_conflicting_target");
    const source = await lockCurrentOrganizationSubscription(
      tx,
      {
        ...input,
        subscriptionId: command.subscription_id,
        expectedSubscriptionRevision: command.expected_subscription_revision,
      },
      locked,
      reject,
    );
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
    const [conflict] = await tx
      .select({ id: commands.id })
      .from(commands)
      .where(
        and(
          eq(commands.organization_id, input.organizationId),
          isNull(commands.app_id),
          isNull(commands.billing_scope_id),
          ne(commands.id, command.id),
          inArray(commands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
        ),
      )
      .limit(1);
    if (
      conflict ||
      !projection ||
      projection.source_subscription_id !== source.id ||
      projection.source_subscription_revision !== source.lifecycle_revision
    )
      reject("conflicting_command_or_projection");
    return project({
      command,
      pending: {
        source,
        review: context.quote.review,
        binding: context.binding,
        origin: context.origin,
        observedAt: await readPostLockDatabaseNow(tx),
      },
    });
  });
}
