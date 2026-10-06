/** Read under the caller's organization lock before publishing a new renewal period. */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";

export async function listUnsettledOrganizationUpgrades(
  input: { organizationId: string; subscriptionId: string },
  reader: Pick<DbTransaction, "select"> = dbWrite,
) {
  return reader
    .select({ organizationId: commands.organization_id, commandId: commands.id })
    .from(commands)
    .where(
      and(
        eq(commands.organization_id, input.organizationId),
        eq(commands.subscription_id, input.subscriptionId),
        isNull(commands.app_id),
        isNull(commands.billing_scope_id),
        eq(commands.merchant_key, "platform"),
        eq(commands.kind, "upgrade"),
        eq(commands.status, "OUTCOME_UNKNOWN"),
        eq(commands.organization_upgrade_dispatch_state, "started"),
      ),
    )
    .orderBy(asc(commands.expected_subscription_revision), asc(commands.id));
}
