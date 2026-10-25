/** Upgrade admission preserves its original command and digest through shared plan-change authority. */
import {
  type ConfirmOrganizationPlanChangeInput,
  prepareOrganizationPlanChange,
} from "./organization-plan-change-commands";
export type ConfirmOrganizationUpgradeInput = ConfirmOrganizationPlanChangeInput;
export function prepareOrganizationUpgrade(input: ConfirmOrganizationUpgradeInput) {
  return prepareOrganizationPlanChange(input, "upgrade");
}
