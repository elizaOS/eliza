/** Interactive confirmation composes the original single-dispatch and read-only recovery owners. */
import type { OrganizationSubscriptionUpgradeCommandDto } from "@elizaos/cloud-sdk/contracts";
import { ElizaError } from "@elizaos/core";
import {
  type ConfirmOrganizationUpgradeInput,
  prepareOrganizationUpgrade,
} from "../../db/repositories/organization-upgrade-commands";
import {
  claimOrganizationUpgrade,
  finishOrganizationUpgradeAttempt,
} from "../../db/repositories/organization-upgrade-execution";
import { readOrganizationUpgradeCommand } from "../../db/repositories/organization-upgrade-status";
import type { BillingSubscriptionCommand } from "../../db/schemas/subscription-billing-operations";
import { logger } from "../utils/logger";
import { dispatchOrganizationUpgrade } from "./organization-upgrade-dispatch";
import { reconcileOriginalOrganizationUpgrade } from "./organization-upgrade-recovery";

export function projectOrganizationSubscriptionUpgradeCommand(
  command: BillingSubscriptionCommand,
): OrganizationSubscriptionUpgradeCommandDto {
  if (
    !command.subscription_id ||
    command.expected_subscription_revision === null ||
    !["plus_monthly", "pro_monthly"].includes(command.target_plan_key ?? "") ||
    !command.organization_upgrade_dispatch_state ||
    command.status === "SUCCEEDED" ||
    (command.status === "FAILED" &&
      command.organization_upgrade_dispatch_state === "started" &&
      !command.organization_upgrade_failure_evidence)
  )
    throw new ElizaError("Organization upgrade status is unavailable", {
      code: "SUBSCRIPTION_UPGRADE_STATUS_UNAVAILABLE",
    });
  return {
    commandId: command.id,
    subscriptionId: command.subscription_id,
    targetPlanKey: command.target_plan_key as "plus_monthly" | "pro_monthly",
    status: command.status,
    dispatchState: command.organization_upgrade_dispatch_state,
    expectedSubscriptionRevision: String(command.expected_subscription_revision),
    resultSubscriptionRevision:
      command.result_subscription_revision === null
        ? null
        : String(command.result_subscription_revision),
    failure:
      command.status === "FAILED" || command.status === "SUPERSEDED"
        ? command.organization_upgrade_failure_evidence
          ? "invoice_void"
          : "review_required"
        : null,
  };
}
export async function readOrganizationSubscriptionUpgrade(
  input: { organizationId: string; actorId: string; commandId: string },
  verifySession: () => Promise<void>,
) {
  const command = await readOrganizationUpgradeCommand(input);
  await verifySession();
  return projectOrganizationSubscriptionUpgradeCommand(command);
}
export async function confirmOrganizationSubscriptionUpgrade(
  input: ConfirmOrganizationUpgradeInput,
  verifySession: () => Promise<void>,
) {
  let sessionFailure: unknown;
  let sessionFailed = false;
  async function verify() {
    try {
      await verifySession();
    } catch (error) {
      // error-policy:J2 preserve the authentication failure after original-lease cleanup.
      sessionFailed = true;
      sessionFailure = error;
      throw error;
    }
  }
  await verify();
  const prepared = await prepareOrganizationUpgrade(input);
  const identity = {
    organizationId: input.organizationId,
    actorId: input.actorId,
    commandId: prepared.command.id,
  };
  const status = () => readOrganizationSubscriptionUpgrade(identity, verify);
  if (prepared.command.status !== "PREPARED" && prepared.command.status !== "OUTCOME_UNKNOWN")
    return status();
  if (prepared.command.organization_upgrade_dispatch_state === "started") {
    try {
      await reconcileOriginalOrganizationUpgrade(identity);
    } catch (error) {
      // error-policy:J1 durable original uncertainty is returned; provider details remain private.
      logger.warn("[Organization Upgrade] Original recovery remains unconfirmed", {
        commandId: identity.commandId,
        code: error instanceof ElizaError ? error.code : "PROVIDER_OUTCOME_UNKNOWN",
      });
    }
    return status();
  }
  const claim = await claimOrganizationUpgrade(identity);
  if (!claim) return status();
  try {
    if (claim.canDispatch) await dispatchOrganizationUpgrade(identity, claim, verify);
    else {
      await finishOrganizationUpgradeAttempt(identity, claim);
      await reconcileOriginalOrganizationUpgrade(identity);
    }
  } catch (error) {
    // error-policy:J1 only original ready evidence can become failure; started effects stay unknown.
    try {
      await finishOrganizationUpgradeAttempt(identity, claim);
    } catch (cleanupError) {
      throw new ElizaError("Upgrade attempt cleanup is unavailable", {
        code: "SUBSCRIPTION_UPGRADE_STATUS_UNAVAILABLE",
        cause: new AggregateError([error, cleanupError]),
      });
    }
    if (sessionFailed) throw sessionFailure;
    logger.warn("[Organization Upgrade] Attempt was not confirmed", {
      commandId: identity.commandId,
      code: error instanceof ElizaError ? error.code : "PROVIDER_OUTCOME_UNKNOWN",
    });
  }
  return status();
}
