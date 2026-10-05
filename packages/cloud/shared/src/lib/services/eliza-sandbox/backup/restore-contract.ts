/** Defines explicit reviewed backup and fresh-boot restore selections for sandbox provisioning. */
import { type ProvisioningAdmissionCapture } from "../../../../db/repositories/agent-sandboxes";
import { type PersonalDedicatedReviewedBackupChainEntry } from "../../personal-dedicated-adoption-provenance";

/**
 * Restore-source override for `provision()`. `from-backup` restores a specific
 * backup instead of the latest; manual restore additionally sets
 * `requireRestoreEndpoint` and binds its exact admission capture. `fresh-boot`
 * skips restore entirely after explicit data-loss consent. Callers that omit an
 * override keep latest-backup auto-restore. No lane degrades a known-backup
 * failure to a fresh boot.
 */
export type ProvisionRestoreOverride =
  | {
      kind: "from-backup";
      backupId: string;
      requireRestoreEndpoint?: false;
      expectedAdmission?: never;
    }
  | {
      kind: "from-backup";
      backupId: string;
      requireRestoreEndpoint: true;
      expectedAdmission: ProvisioningAdmissionCapture;
    }
  | {
      kind: "from-reviewed-backup";
      selectionId: string;
      backupId: string;
      expectedContentHash: string;
      expectedBackupChain: PersonalDedicatedReviewedBackupChainEntry[];
    }
  | { kind: "reviewed-fresh-boot"; selectionId: string }
  | { kind: "fresh-boot" };

export type ReviewedProvisionRestoreOverride = Extract<
  ProvisionRestoreOverride,
  { kind: "from-reviewed-backup" }
>;

export type ReviewedProvisionAuthorityOverride = Extract<
  ProvisionRestoreOverride,
  { kind: "from-reviewed-backup" | "reviewed-fresh-boot" }
>;

export function isExplicitBackupRestore(
  override: ProvisionRestoreOverride | undefined,
): override is Extract<ProvisionRestoreOverride, { kind: "from-backup" | "from-reviewed-backup" }> {
  return override?.kind === "from-backup" || override?.kind === "from-reviewed-backup";
}
