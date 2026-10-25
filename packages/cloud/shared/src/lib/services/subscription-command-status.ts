/** Exposes primary pending-command observations without performing provider work or changing command authority. */
import {
  readPendingOrganizationPlanChangeCommands,
  readPendingSubscriptionCommands,
} from "../../db/repositories/subscription-command-status";
export function listPendingOrganizationSubscriptionCommands(
  input: Parameters<typeof readPendingSubscriptionCommands>[0],
) {
  return readPendingSubscriptionCommands(input);
}

export function listPendingOrganizationPlanChangeCommands(
  input: Parameters<typeof readPendingOrganizationPlanChangeCommands>[0],
) {
  return readPendingOrganizationPlanChangeCommands(input);
}
