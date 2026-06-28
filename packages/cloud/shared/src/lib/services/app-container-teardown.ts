/**
 * App-delete container teardown (Blocker #7) — the pure orchestration of
 * stopping + removing the container(s) backing a deleted app.
 *
 * On app delete the per-tenant DB was deprovisioned but the live container was
 * orphaned: it kept running on the node AND kept being metered by the daily
 * container-billing cron (a cost leak + a perpetual overcharge to the org). The
 * suspend path already stops a container via an enqueued CONTAINER_STOP/DELETE
 * job; delete did not. This module mirrors that path:
 *
 *   1. mark the container row stopped/suspended so the billing cron — which only
 *      meters `status='running'` rows in an active billing state — stops
 *      charging the org IMMEDIATELY (closes the leak window before the daemon
 *      runs), and
 *   2. enqueue a CONTAINER_DELETE job (a plain DB insert; the Worker never SSHs)
 *      for the provisioning daemon to do the real `docker stop`/remove and
 *      release the node slot.
 *
 * Kept free of `db/client` imports (the real repo + jobs writer are injected via
 * {@link AppContainerTeardownDeps}) so it is unit-testable with no DB/queue.
 */

import { logger } from "../utils/logger";
import { ContainerJobEnqueuer, type ContainerJobsWriter } from "./container-job-service";

/** The minimal app shape the teardown needs (a real `App` is assignable). */
export interface TeardownApp {
  id: string;
  organization_id: string;
}

/** A container row the teardown acts on (a real `Container` is assignable). */
export interface TeardownContainer {
  id: string;
}

/**
 * Seam for the container-teardown backend so the cleanup can be unit-tested
 * without a DB or a real jobs queue. Production wiring (in `app-cleanup.ts`)
 * supplies the real containers repo + the shared container-jobs writer.
 */
export interface AppContainerTeardownDeps {
  /** All not-yet-deleted container rows for this app (org-scoped). */
  findContainers: (organizationId: string, appId: string) => Promise<TeardownContainer[]>;
  /** Stop metering a container immediately (status=stopped, billing_status=suspended). */
  markStoppedForBilling: (containerId: string, organizationId: string) => Promise<void>;
  /** Enqueue the daemon-side CONTAINER_DELETE (stops + removes the live container). */
  jobsWriter: ContainerJobsWriter;
}

/**
 * Stop + tear down the app's deployed container(s).
 *
 * The deploy orchestrator sets `containers.project_name = appId`, so the app's
 * container(s) are resolved by (organization_id, project_name=appId). Idempotent
 * and a clean no-op when the app never deployed a container; a per-container
 * failure is collected and does not abort teardown of the others.
 */
export async function stopAppContainers(
  app: TeardownApp,
  deps: AppContainerTeardownDeps,
): Promise<{ tornDown: number; errors: string[] }> {
  const errors: string[] = [];
  let tornDown = 0;

  let containers: TeardownContainer[];
  try {
    containers = await deps.findContainers(app.organization_id, app.id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    errors.push(`Failed to look up app containers: ${errorMessage}`);
    logger.error("[AppCleanup] Failed to look up app containers", {
      appId: app.id,
      error: errorMessage,
    });
    return { tornDown, errors };
  }

  if (containers.length === 0) {
    logger.info("[AppCleanup] No container to tear down", { appId: app.id });
    return { tornDown, errors };
  }

  const enqueuer = new ContainerJobEnqueuer(deps.jobsWriter);

  for (const container of containers) {
    try {
      // 1. Stop metering now (close the cost-leak window before the daemon runs).
      await deps.markStoppedForBilling(container.id, app.organization_id);
      // 2. Enqueue the daemon-side stop + remove (also releases the node slot).
      await enqueuer.enqueueDelete({
        containerId: container.id,
        organizationId: app.organization_id,
      });
      tornDown += 1;
      logger.info("[AppCleanup] Stopped + enqueued container teardown", {
        appId: app.id,
        containerId: container.id,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      errors.push(`Failed to tear down container ${container.id}: ${errorMessage}`);
      logger.error("[AppCleanup] Failed to tear down container", {
        appId: app.id,
        containerId: container.id,
        error: errorMessage,
      });
    }
  }

  return { tornDown, errors };
}
