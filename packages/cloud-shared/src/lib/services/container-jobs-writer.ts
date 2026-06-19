/**
 * ContainerJobsWriter (Apps / Product 2) — the integration backing for the
 * {@link ContainerJobsWriter} insert seam declared in `container-job-service.ts`.
 *
 * `ContainerJobEnqueuer` (in container-job-service.ts) builds the typed
 * CONTAINER_* job payloads and delegates persistence to this writer, which wraps
 * the existing `jobsRepository.create` (no second queue, no advisory-lock dance —
 * the agent enqueue path advisory-locks `agent_sandboxes`, but containers have no
 * agent row, so they take this plain insert path).
 *
 * Maps `ContainerJobInsert` -> `NewJob`:
 *   - type            -> jobs.type            (e.g. "container_provision")
 *   - organizationId  -> jobs.organization_id (NOT NULL FK; required)
 *   - userId          -> jobs.user_id         (nullable FK; null when absent)
 *   - data            -> jobs.data            (jsonb; the typed container payload)
 *
 * `agent_id` / `character_id` stay NULL: the indexed-field extractor in
 * `jobs.ts` reads them from `data.agentId` / `data.characterId`, and container
 * job data carries neither (see `container-jobs-data.ts`), so both index columns
 * are correctly null. The daemon claims these rows by `type` alongside the
 * agent jobs (`claimPendingJobs` has no org/agent filter in cron mode), and the
 * `executeJob` switch routes CONTAINER_* to `dispatchContainerJob`.
 *
 * Server-only (node + Worker both fine — this is a plain DB insert, no `pg`).
 */

import { jobsRepository } from "../../db/repositories/jobs";
import type { ContainerJobInsert, ContainerJobsWriter } from "./container-job-service";

/** Real writer over `jobsRepository`. Construct once; inject into ContainerJobEnqueuer. */
export class JobsRepositoryContainerJobsWriter implements ContainerJobsWriter {
  async insertJob(job: ContainerJobInsert): Promise<{ id: string }> {
    const created = await jobsRepository.create({
      type: job.type,
      organization_id: job.organizationId,
      // user_id is a nullable FK; container jobs may be enqueued without a user
      // (e.g. system-driven delete/restart). Pass null rather than undefined so
      // the column is explicitly cleared rather than relying on insert defaults.
      user_id: job.userId ?? null,
      data: job.data,
    });
    return { id: created.id };
  }
}

/** Singleton — the cloud-api route side and the daemon both reuse this instance. */
export const containerJobsWriter: ContainerJobsWriter = new JobsRepositoryContainerJobsWriter();
