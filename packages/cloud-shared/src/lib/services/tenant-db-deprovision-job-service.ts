/**
 * TENANT_DB_DEPROVISION job service (Apps / Product 2) — lets the cloud-api
 * Worker tear down isolated per-tenant databases on app delete without loading
 * node-`pg`.
 *
 * The Worker enqueues a TENANT_DB_DEPROVISION job (plain DB insert, no `pg`);
 * the provisioning-worker daemon claims it and runs
 * `makeTenantDbProvisioning().deprovisionForApp()` (DROP DATABASE/ROLE + release
 * cluster slot). Safe to import on workerd.
 */

import type { ContainerJobsWriter } from "./container-job-service";
import { containerJobsWriter } from "./container-jobs-writer";
import { JOB_TYPES } from "./provisioning-job-types";

/** Extract appId + clusterId from a TENANT_DB_DEPROVISION job payload. */
export function readTenantDbDeprovisionJobData(job: { data: unknown }): {
  appId: string;
  clusterId: string;
} {
  const data = (job.data ?? {}) as Record<string, unknown>;
  if (typeof data.appId !== "string" || data.appId.length === 0) {
    throw new Error("TENANT_DB_DEPROVISION job missing data.appId");
  }
  if (typeof data.clusterId !== "string" || data.clusterId.length === 0) {
    throw new Error("TENANT_DB_DEPROVISION job missing data.clusterId");
  }
  return { appId: data.appId, clusterId: data.clusterId };
}

/** Daemon: run DDL deprovision for a claimed TENANT_DB_DEPROVISION job. */
export async function dispatchTenantDbDeprovisionJob(job: { data: unknown }): Promise<void> {
  const { appId, clusterId } = readTenantDbDeprovisionJobData(job);
  const { makeTenantDbProvisioning } = await import("./tenant-db/make-tenant-db-provisioning");
  await makeTenantDbProvisioning().deprovisionForApp(appId, clusterId);
}

/** Enqueue a TENANT_DB_DEPROVISION job (pg-free) over the shared job writer. */
export function enqueueTenantDbDeprovision(
  writer: ContainerJobsWriter,
  p: { appId: string; clusterId: string; organizationId: string },
): Promise<{ id: string }> {
  return writer.insertJob({
    type: JOB_TYPES.TENANT_DB_DEPROVISION,
    organizationId: p.organizationId,
    data: { appId: p.appId, clusterId: p.clusterId },
  });
}

/** Shared writer singleton used by Worker-side enqueue paths. */
export function enqueueTenantDbDeprovisionOnce(p: {
  appId: string;
  clusterId: string;
  organizationId: string;
}): Promise<{ id: string }> {
  return enqueueTenantDbDeprovision(containerJobsWriter, p);
}
