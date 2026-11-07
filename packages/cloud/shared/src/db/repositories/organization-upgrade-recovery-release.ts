/** Releases only the current system recovery lease. Never resets dispatch or publishes a result. */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { writeTransaction } from "../helpers";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import type { OrganizationUpgradeSettlementIdentity } from "./organization-upgrade-paid-authority";
export async function releaseOrganizationUpgradeRecovery(
  input: OrganizationUpgradeSettlementIdentity,
) {
  return writeTransaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) return false;
    const [released] = await tx
      .update(commands)
      .set({
        lease_token: null,
        lease_expires_at: null,
        state_revision: sql`${commands.state_revision}+1`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(commands.organization_id, input.organizationId),
          eq(commands.id, input.commandId),
          isNull(commands.app_id),
          isNull(commands.billing_scope_id),
          eq(commands.merchant_key, "platform"),
          eq(commands.kind, "upgrade"),
          eq(commands.status, "OUTCOME_UNKNOWN"),
          eq(commands.organization_upgrade_dispatch_state, "started"),
          eq(commands.lease_token, input.leaseToken),
          eq(commands.execution_generation, input.executionGeneration),
          gt(commands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: commands.id });
    return !!released;
  });
}
