/**
 * CONTAINER_* job service (Apps / Product 2) — the glue between the daemon's
 * job switch and the executor logic, plus enqueue helpers. Kept OUT of the
 * agent-coupled `provisioning-jobs.ts` (whose enqueue path advisory-locks
 * `agent_sandboxes`): containers have no agent row, so they get their own
 * enqueue path here over an injected jobs writer. The only edit to
 * `provisioning-jobs.ts` is appending CONTAINER_* switch cases that call
 * {@link dispatchContainerJob} — additive, never touching the AGENT_* arms.
 *
 * The executor backend (real provider + container store) is provided at runtime
 * via {@link setContainerExecutorDeps} (wired in U3c / on the stack), so this
 * module imports no DB/SSH and stays unit-testable.
 */

import {
  type ContainerExecutorDeps,
  executeContainerDelete,
  executeContainerLogs,
  executeContainerProvision,
  executeContainerRestart,
  executeContainerStop,
  executeContainerUpgrade,
} from "./container-job-executors";
import {
  containerDeleteJobDataToRecord,
  containerLogsJobDataToRecord,
  containerProvisionJobDataToRecord,
  containerRestartJobDataToRecord,
  containerStopJobDataToRecord,
  containerUpgradeJobDataToRecord,
  type JobLike,
} from "./container-jobs-data";
import { JOB_TYPES } from "./provisioning-job-types";

const CONTAINER_JOB_TYPES: ReadonlySet<string> = new Set([
  JOB_TYPES.CONTAINER_PROVISION,
  JOB_TYPES.CONTAINER_STOP,
  JOB_TYPES.CONTAINER_DELETE,
  JOB_TYPES.CONTAINER_RESTART,
  JOB_TYPES.CONTAINER_UPGRADE,
  JOB_TYPES.CONTAINER_LOGS,
]);

/** True for the CONTAINER_* job types this service owns. */
export function isContainerJobType(type: string): boolean {
  return CONTAINER_JOB_TYPES.has(type);
}

/** Route a CONTAINER_* job to its executor. */
export async function dispatchContainerJob(
  job: JobLike & { type: string },
  deps: ContainerExecutorDeps,
): Promise<void> {
  switch (job.type) {
    case JOB_TYPES.CONTAINER_PROVISION:
      await executeContainerProvision(job, deps);
      return;
    case JOB_TYPES.CONTAINER_STOP:
      await executeContainerStop(job, deps);
      return;
    case JOB_TYPES.CONTAINER_DELETE:
      await executeContainerDelete(job, deps);
      return;
    case JOB_TYPES.CONTAINER_RESTART:
      await executeContainerRestart(job, deps);
      return;
    case JOB_TYPES.CONTAINER_UPGRADE:
      await executeContainerUpgrade(job, deps);
      return;
    case JOB_TYPES.CONTAINER_LOGS:
      await executeContainerLogs(job, deps);
      return;
    default:
      throw new Error(`Not a container job type: ${job.type}`);
  }
}

// ── runtime-injected executor backend ────────────────────────────────────────

let depsFactory: (() => ContainerExecutorDeps) | null = null;

/** Wire the real executor backend (provider + store). Called in U3c / on boot. */
export function setContainerExecutorDeps(factory: () => ContainerExecutorDeps): void {
  depsFactory = factory;
}

/** Resolve the executor backend, or throw if it hasn't been wired yet. */
export function getContainerExecutorDeps(): ContainerExecutorDeps {
  if (!depsFactory) {
    throw new Error("Container executor backend not configured — call setContainerExecutorDeps()");
  }
  return depsFactory();
}

// ── enqueue ──────────────────────────────────────────────────────────────────

export interface ContainerJobInsert {
  type: string;
  organizationId: string;
  userId?: string;
  data: Record<string, unknown>;
}

/** Insert seam — the real writer wraps jobsRepository/dbWrite (integration). */
export interface ContainerJobsWriter {
  insertJob(job: ContainerJobInsert): Promise<{ id: string }>;
}

export class ContainerJobEnqueuer {
  private readonly writer: ContainerJobsWriter;

  constructor(writer: ContainerJobsWriter) {
    this.writer = writer;
  }

  enqueueProvision(p: {
    containerId: string;
    organizationId: string;
    userId: string;
  }): Promise<{ id: string }> {
    return this.writer.insertJob({
      type: JOB_TYPES.CONTAINER_PROVISION,
      organizationId: p.organizationId,
      userId: p.userId,
      data: containerProvisionJobDataToRecord(p),
    });
  }

  enqueueStop(p: { containerId: string; organizationId: string }): Promise<{ id: string }> {
    return this.writer.insertJob({
      type: JOB_TYPES.CONTAINER_STOP,
      organizationId: p.organizationId,
      data: containerStopJobDataToRecord(p),
    });
  }

  enqueueDelete(p: { containerId: string; organizationId: string }): Promise<{ id: string }> {
    return this.writer.insertJob({
      type: JOB_TYPES.CONTAINER_DELETE,
      organizationId: p.organizationId,
      data: containerDeleteJobDataToRecord(p),
    });
  }

  enqueueRestart(p: { containerId: string; organizationId: string }): Promise<{ id: string }> {
    return this.writer.insertJob({
      type: JOB_TYPES.CONTAINER_RESTART,
      organizationId: p.organizationId,
      data: containerRestartJobDataToRecord(p),
    });
  }

  enqueueUpgrade(p: {
    containerId: string;
    organizationId: string;
    image?: string;
  }): Promise<{ id: string }> {
    return this.writer.insertJob({
      type: JOB_TYPES.CONTAINER_UPGRADE,
      organizationId: p.organizationId,
      data: containerUpgradeJobDataToRecord(p),
    });
  }

  enqueueLogs(p: {
    containerId: string;
    organizationId: string;
    tail?: number;
  }): Promise<{ id: string }> {
    return this.writer.insertJob({
      type: JOB_TYPES.CONTAINER_LOGS,
      organizationId: p.organizationId,
      data: containerLogsJobDataToRecord(p),
    });
  }
}
