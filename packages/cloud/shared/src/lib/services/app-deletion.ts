/** One original jobs-owned deletion: dispatch, confirmed children, then cascade. */

import { withAppDeletionExecution } from "../../db/repositories/app-deletion-execution";
import { prepareAppDeletionPlan } from "../../db/repositories/app-deletion-plan";
import { appsRepository } from "../../db/repositories/apps";
import { logger } from "../utils/logger";
import { finishAppDeletionCleanup } from "./app-deletion-cleanup";
import { deleteOriginalAppRepository } from "./app-deletion-github";
import { appFrontendHostingService } from "./app-frontend-hosting";
import type { JobExecutionAuthority } from "./job-execution-authority";

export async function executeAppDeletion(authority: JobExecutionAuthority): Promise<void> {
  const original = await withAppDeletionExecution(authority, async (_tx, context) => ({
    appId: context.data.appId,
    complete: context.appDeleted,
    version: context.data.version,
  }));
  if (original.complete) {
    if (original.version === 2) await finishAppDeletionCleanup(authority);
    return;
  }
  await prepareAppDeletionPlan(authority);
  await deleteOriginalAppRepository(authority);
  const receipt = await appsRepository.finalizeDelete(original.appId, authority);
  if (original.version === 2) {
    await finishAppDeletionCleanup(authority);
    return;
  }
  if (!receipt) return;
  // Only an acknowledged cascade authorizes object cleanup. A lost SQL reply
  // leaves retained bytes for later orphan reconciliation, never a live-site loss.
  for (const deployment of receipt.frontendDeployments) {
    try {
      await appFrontendHostingService.deleteArtifacts(deployment);
    } catch (error) {
      logger.warn("App deletion retained frontend artifacts after cleanup failure", {
        appId: original.appId,
        deploymentId: deployment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
