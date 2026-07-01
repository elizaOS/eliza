/**
 * CONTAINER_STOP job service (#8342) — stop a billed container's live Docker
 * runtime when billing is suspended, WITHOUT the Worker ever touching SSH.
 *
 * The daily container-billing cron runs on the Cloudflare Worker. When an org
 * runs out of credit the cron flips the row to `status='stopped',
 * billing_status='suspended'` (ContainerBillingRepository.suspendContainer) and
 * stops charging — but the container was created with `--restart unless-stopped`
 * and KEEPS RUNNING on the Hetzner node, because the Worker cannot SSH (`ssh2`
 * is stubbed in workerd). The result is unbounded free compute: billing stopped,
 * the container did not.
 *
 * This closes that leak with the same Worker-enqueues / daemon-executes pattern
 * the agent-suspend (enqueueAgentSuspendOnce) and APP_DB_DEPROVISION (#8401)
 * paths already use: the cron ENQUEUES a CONTAINER_STOP job (a plain DB insert,
 * no SSH) and the provisioning-worker daemon claims it and runs the real
 * `docker stop` + remove via the node-only HetznerContainersClient — which also
 * decrements the node's allocated-slot count. The volume is PRESERVED
 * (`purgeVolume: false`) so the org can top up and redeploy.
 *
 * The dispatcher lazy-imports the Hetzner client so this module stays safe to
 * load on workerd (the enqueue side never pulls `ssh2`).
 */

import type { ContainerJobsWriter } from "./container-job-service";
import { JOB_TYPES } from "./provisioning-job-types";

/** Outcome of a daemon-side container stop. */
export interface ContainerStopOutcome {
  stopped: boolean;
  reason?: string;
}

/** Extract + validate a CONTAINER_STOP job payload (throws if malformed). */
export function readContainerStopJobData(job: { data: unknown }): {
  containerId: string;
  organizationId: string;
} {
  const data = (job.data ?? {}) as Record<string, unknown>;
  if (typeof data.containerId !== "string" || data.containerId.length === 0) {
    throw new Error("CONTAINER_STOP job missing data.containerId");
  }
  if (typeof data.organizationId !== "string" || data.organizationId.length === 0) {
    throw new Error("CONTAINER_STOP job missing data.organizationId");
  }
  return { containerId: data.containerId, organizationId: data.organizationId };
}

/**
 * Daemon: stop + remove the live container for a claimed CONTAINER_STOP job.
 * Preserves the volume (`purgeVolume: false`) and decrements the node's
 * allocated count (HetznerContainersClient.stopContainer does both). A
 * container whose row is already `stopped`/gone is treated as already-stopped
 * (idempotent) — the same `container_not_found` short-circuit the delete path
 * tolerates — so a re-claim after the row was finalized cannot fail the job.
 */
export async function dispatchContainerStopJob(job: {
  data: unknown;
}): Promise<ContainerStopOutcome> {
  const { containerId, organizationId } = readContainerStopJobData(job);
  // Node-only: HetznerContainersClient uses `ssh2`. Imported lazily so the
  // Worker enqueue path never loads it.
  const { getHetznerContainersClient } = await import("./containers/hetzner-client");
  try {
    await getHetznerContainersClient().stopContainer(containerId, organizationId, {
      purgeVolume: false,
    });
    return { stopped: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The row was already removed (e.g. the org deleted the container between
    // suspend and this run) — nothing left to stop. Treat as success.
    if (message.includes("not found")) {
      return { stopped: false, reason: "container-not-found" };
    }
    throw error;
  }
}

/** Enqueue a CONTAINER_STOP job (SSH-free) over the shared job writer. */
export function enqueueContainerStop(
  writer: ContainerJobsWriter,
  p: { containerId: string; organizationId: string; userId?: string },
): Promise<{ id: string }> {
  return writer.insertJob({
    type: JOB_TYPES.CONTAINER_STOP,
    organizationId: p.organizationId,
    userId: p.userId,
    data: { containerId: p.containerId, organizationId: p.organizationId },
  });
}
