/** Resolves the approved deployment-wide app ceiling for admission and billing observations. */
import { ElizaError } from "@elizaos/core";

const DEFAULT_MAX_APPS_PER_ORG = 25;
/**
 * Read-only view of the per-org app ceiling for the account-limits snapshot
 * (#19777) — the same resolution `assertCanCreateForOrganization` enforces.
 */
export function getMaxAppsPerOrg(): number {
  const raw = process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
  if (raw === undefined) return DEFAULT_MAX_APPS_PER_ORG;

  const value = raw.trim();
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ElizaError("ELIZA_CLOUD_MAX_APPS_PER_ORG must be a positive safe integer", {
      code: "INVALID_MAX_APPS_PER_ORG",
      context: {
        environmentVariable: "ELIZA_CLOUD_MAX_APPS_PER_ORG",
      },
      severity: "fatal",
    });
  }

  return parsed;
}
