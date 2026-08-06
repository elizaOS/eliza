import semverGt from "semver/functions/gt.js";
import semverValid from "semver/functions/valid.js";
import { fetchLatestReleaseVersion, runScriptManagedUpdate } from "./install-manager";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
}

export interface UpdateRunResult {
  success: boolean;
  output: string;
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult | null> {
  try {
    const latestVersion = await fetchLatestReleaseVersion();
    if (!latestVersion || !semverValid(latestVersion)) return null;

    const normalizedCurrent = semverValid(currentVersion);
    if (!normalizedCurrent) return null;

    const hasUpdate = semverGt(latestVersion, normalizedCurrent);
    return { currentVersion: normalizedCurrent, latestVersion, hasUpdate };
  } catch {
    return null;
  }
}

export function runUpdate(currentVersion: string): Promise<UpdateRunResult> {
  return runScriptManagedUpdate(currentVersion);
}
