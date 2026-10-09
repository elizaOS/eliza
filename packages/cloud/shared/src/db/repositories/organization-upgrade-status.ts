/** Primary current-manager status read; no provider requests or dispatch permission. */
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { writeTransaction } from "../helpers";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import {
  lockOrganizationSubscriptionManager,
  type OrganizationSubscriptionIdentity,
} from "./organization-subscription-manager";
export async function readOrganizationUpgradeCommand(
  input: OrganizationSubscriptionIdentity & { commandId: string },
) {
  return writeTransaction(async (tx) => {
    await lockOrganizationSubscriptionManager(tx, input, () => {
      throw new ElizaError("Current organization billing manager required", {
        code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN",
      });
    });
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
      );
    if (!command)
      throw new ElizaError("Organization upgrade command not found", {
        code: "SUBSCRIPTION_UPGRADE_NOT_FOUND",
      });
    return command;
  });
}
