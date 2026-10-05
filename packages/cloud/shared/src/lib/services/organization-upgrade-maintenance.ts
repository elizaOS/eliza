/** Bounded cron owner for due upgrade observations; never sends a provider mutation. */
import { ElizaError } from "@elizaos/core";
import { listOrganizationUpgradeRecovery } from "../../db/repositories/organization-upgrade-observation-lease";
import { recordOrganizationUpgradeRecoveryOutcome } from "../../db/repositories/organization-upgrade-recovery-incidents";
import { reconcileOriginalOrganizationUpgrade } from "./organization-upgrade-recovery";
export async function recoverOrganizationUpgrades(limit = 5) {
  const result = { inspected: 0, applied: 0, failed: 0, pending: 0, unavailable: 0, deferred: 0 };
  const due = await listOrganizationUpgradeRecovery(limit);
  for (let index = 0; index < due.length; index++) {
    const command = due[index]!;
    const identity = { organizationId: command.organization_id, commandId: command.id };
    result.inspected++;
    let observed: Awaited<ReturnType<typeof reconcileOriginalOrganizationUpgrade>>;
    try {
      observed = await reconcileOriginalOrganizationUpgrade(identity);
    } catch (error) {
      // error-policy:J4 Per-command uncertainty is retained in the durable journal;
      // a failure to record it fails the maintenance lane rather than hiding loss.
      const code =
        error instanceof ElizaError && /^[A-Z][A-Z0-9_]{0,119}$/.test(error.code)
          ? error.code
          : "UPGRADE_RECOVERY_UNAVAILABLE";
      await recordOrganizationUpgradeRecoveryOutcome({ ...identity, issueCode: code });
      result.unavailable++;
      continue;
    }
    if (observed.status === "applied") {
      await recordOrganizationUpgradeRecoveryOutcome({ ...identity, issueCode: null });
      result.applied++;
    } else if (observed.status === "failed") {
      await recordOrganizationUpgradeRecoveryOutcome({ ...identity, issueCode: null });
      result.failed++;
    } else {
      if (observed.reason === "requires_reconciliation")
        await recordOrganizationUpgradeRecoveryOutcome({
          ...identity,
          issueCode: "UPGRADE_INVOICE_REQUIRES_RECONCILIATION",
        });
      result.pending++;
    }
  }
  return result;
}
