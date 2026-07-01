/**
 * Wire shapes + codecs for the CONTAINER_* (Apps / Product 2) job lane.
 *
 * Mirrors the AGENT_* job-data codecs in `provisioning-jobs.ts` (an interface
 * per job type + an `is*` runtime guard + a `read*` that validates a job row's
 * `data` + a `*ToRecord` for persistence), but for the generic app-container
 * lifecycle. Kept in its own module so the apps lane never touches the agent
 * codecs, and intentionally dependency-free: it reads from a structural
 * `JobLike` rather than importing the `Job`/queue types, so the whole contract
 * is unit-testable with no DB/queue/docker imports.
 */

/** Minimal structural view of a queue job row — the real `Job` is assignable. */
export interface JobLike {
  id: string;
  data: unknown;
}

export interface ContainerProvisionJobData {
  containerId: string;
  organizationId: string;
  userId: string;
}

export interface ContainerDeleteJobData {
  containerId: string;
  organizationId: string;
}

export interface ContainerRestartJobData {
  containerId: string;
  organizationId: string;
}

export interface ContainerUpgradeJobData {
  containerId: string;
  organizationId: string;
  /** Optional new image reference; omit to re-pull the current tag. */
  image?: string;
}

export interface ContainerLogsJobData {
  containerId: string;
  organizationId: string;
  /** Number of trailing log lines to fetch. */
  tail?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasStrings(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  return keys.every((k) => typeof value[k] === "string");
}

export function isContainerProvisionJobData(value: unknown): value is ContainerProvisionJobData {
  return hasStrings(value, ["containerId", "organizationId", "userId"]);
}

export function isContainerDeleteJobData(value: unknown): value is ContainerDeleteJobData {
  return hasStrings(value, ["containerId", "organizationId"]);
}

export function isContainerRestartJobData(value: unknown): value is ContainerRestartJobData {
  return hasStrings(value, ["containerId", "organizationId"]);
}

export function isContainerUpgradeJobData(value: unknown): value is ContainerUpgradeJobData {
  return (
    hasStrings(value, ["containerId", "organizationId"]) &&
    (!isRecord(value) || value.image === undefined || typeof value.image === "string")
  );
}

export function isContainerLogsJobData(value: unknown): value is ContainerLogsJobData {
  return (
    hasStrings(value, ["containerId", "organizationId"]) &&
    (!isRecord(value) || value.tail === undefined || typeof value.tail === "number")
  );
}

export function readContainerProvisionJobData(job: JobLike): ContainerProvisionJobData {
  if (!isContainerProvisionJobData(job.data)) {
    throw new Error(`Invalid container provision job data for job ${job.id}`);
  }
  return job.data;
}

export function readContainerDeleteJobData(job: JobLike): ContainerDeleteJobData {
  if (!isContainerDeleteJobData(job.data)) {
    throw new Error(`Invalid container delete job data for job ${job.id}`);
  }
  return job.data;
}

export function readContainerRestartJobData(job: JobLike): ContainerRestartJobData {
  if (!isContainerRestartJobData(job.data)) {
    throw new Error(`Invalid container restart job data for job ${job.id}`);
  }
  return job.data;
}

export function readContainerUpgradeJobData(job: JobLike): ContainerUpgradeJobData {
  if (!isContainerUpgradeJobData(job.data)) {
    throw new Error(`Invalid container upgrade job data for job ${job.id}`);
  }
  return job.data;
}

export function readContainerLogsJobData(job: JobLike): ContainerLogsJobData {
  if (!isContainerLogsJobData(job.data)) {
    throw new Error(`Invalid container logs job data for job ${job.id}`);
  }
  return job.data;
}

export function containerProvisionJobDataToRecord(
  data: ContainerProvisionJobData,
): Record<string, unknown> {
  return { ...data };
}

export function containerDeleteJobDataToRecord(
  data: ContainerDeleteJobData,
): Record<string, unknown> {
  return { ...data };
}

export function containerRestartJobDataToRecord(
  data: ContainerRestartJobData,
): Record<string, unknown> {
  return { ...data };
}

export function containerUpgradeJobDataToRecord(
  data: ContainerUpgradeJobData,
): Record<string, unknown> {
  return { ...data };
}

export function containerLogsJobDataToRecord(data: ContainerLogsJobData): Record<string, unknown> {
  return { ...data };
}
