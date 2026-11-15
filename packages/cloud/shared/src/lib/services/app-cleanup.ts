/** All app teardown is owned by the original durable app-delete job. */

import type { AppDeletionProgress } from "./app-deletion-authority";
import { appsService } from "./apps";

interface CleanupOptions {
  deleteGitHubRepo?: boolean;
  /** Retained for account-erasure callers. Pending work is always incomplete. */
  continueOnError?: boolean;
  requireContainerTeardownCompletion?: boolean;
}

export interface AppCleanupResult {
  success: boolean;
  errors: string[];
  deletion?: AppDeletionProgress;
}

export async function deleteAppWithCleanup(
  appId: string,
  options: CleanupOptions = {},
): Promise<AppCleanupResult> {
  const deletion = await appsService.delete(appId, {
    deleteGitHubRepo: options.deleteGitHubRepo ?? true,
  });
  if (!deletion) return { success: false, errors: ["App not found"] };
  return {
    success: deletion.state === "completed",
    errors:
      deletion.state === "completed" ? [] : ["App deletion is pending; follow the original job"],
    deletion,
  };
}

export const appCleanupService = { deleteAppWithCleanup };
