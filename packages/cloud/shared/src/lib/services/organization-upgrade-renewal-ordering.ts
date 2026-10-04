/** Finish original upgrade authority before a renewal captures its source and catalog. */
import { listUnsettledOrganizationUpgrades } from "../../db/repositories/organization-upgrade-renewal-ordering";
import { reconcileOriginalOrganizationUpgrade } from "./organization-upgrade-recovery";
import { renewalUnavailable } from "./stripe-paid-renewal-validation";

export async function reconcileOrganizationUpgradesBeforeRenewal(input: {
  organizationId: string;
  subscriptionId: string;
}) {
  const unsettled = await listUnsettledOrganizationUpgrades(input);
  for (const original of unsettled) {
    const outcome = await reconcileOriginalOrganizationUpgrade(original);
    if (outcome.status !== "applied" && outcome.status !== "failed")
      renewalUnavailable("original_upgrade_unsettled");
  }
}
