/** Internal downgrade admission only. No public confirmation endpoint or provider dispatch. */
import {
  type ConfirmOrganizationPlanChangeInput,
  prepareOrganizationPlanChange,
} from "./organization-plan-change-commands";
export type ConfirmOrganizationDowngradeInput = ConfirmOrganizationPlanChangeInput;
export function prepareOrganizationDowngrade(input: ConfirmOrganizationDowngradeInput) {
  return prepareOrganizationPlanChange(input, "downgrade");
}
