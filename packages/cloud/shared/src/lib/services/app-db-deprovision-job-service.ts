/**
 * APP_DB_DEPROVISION job service (Apps / Product 2) — releases an isolated
 * per-tenant DB when its app is deleted, WITHOUT the Worker ever touching `pg`.
 *
 * The Worker delete path ENQUEUES an APP_DB_DEPROVISION job (a plain DB insert,
 * no `pg`) via {@link enqueueAppDbDeprovision}, carrying the app's *encrypted*
 * tenant-DB URI in the payload. The URI is already ciphertext at rest in
 * `app_databases`, so copying it into the job row adds no exposure — and it
 * survives the app row's cascade-delete, so the daemon can still resolve the
 * cluster after the app is gone. The provisioning-worker daemon claims the job
 * and runs the real `DROP DATABASE` / `DROP ROLE` + cluster-slot release via
 * {@link dispatchAppDbDeprovisionJob}, decrypting the URI on the node side
 * where `pg` and the cluster admin DSN live.
 *
 * Without this, a deleted isolated app strands a live Postgres DB we keep
 * paying for and permanently burns one of the cluster's finite slots (#8342) —
 * because the only in-process deprovision path (UserDatabaseService.cleanupDatabase)
 * runs on the Worker, which has no `pg` backend wired, so it silently no-ops.
 *
 * The executor backend is injected at daemon boot via {@link setAppDbDeprovisioner}
 * (see apps-deploy-backend.ts), mirroring setAppDeployRunner — so this module
 * imports no `pg`/SSH and stays safe to load on workerd.
 */

import type { ContainerJobsWriter } from "./container-job-service";
import { containerJobsWriter } from "./container-jobs-writer";
import { fieldEncryption } from "./field-encryption";
import { JOB_TYPES } from "./provisioning-job-types";
import { userDatabaseService } from "./user-database";

/** Outcome of a tenant-DB deprovision (structural subset of TenantDbDeprovisionResult). */
export interface AppDbDeprovisionOutcome {
  deprovisioned: boolean;
  reason?: string;
}

/** The node-side deprovisioner the daemon runs for APP_DB_DEPROVISION jobs. */
export interface AppDbDeprovisioner {
  deprovisionForApp(appId: string, dsn: string): Promise<AppDbDeprovisionOutcome>;
}

// ── runtime-injected executor (daemon side) ─────────────────────────────────
let appDbDeprovisioner: AppDbDeprovisioner | null = null;

/** Wire the node deprovisioner the daemon runs for APP_DB_DEPROVISION jobs. */
export function setAppDbDeprovisioner(deprovisioner: AppDbDeprovisioner): void {
  appDbDeprovisioner = deprovisioner;
}

/** Resolve the deprovisioner, or throw if the backend isn't wired yet. */
export function getAppDbDeprovisioner(): AppDbDeprovisioner {
  if (!appDbDeprovisioner) {
    throw new Error("App DB deprovisioner not configured — call setAppDbDeprovisioner()");
  }
  return appDbDeprovisioner;
}

/** Extract + validate an APP_DB_DEPROVISION job payload (throws if malformed). */
export function readAppDbDeprovisionJobData(job: { data: unknown }): {
  appId: string;
  dbUri: string;
} {
  const data = (job.data ?? {}) as Record<string, unknown>;
  if (typeof data.appId !== "string" || data.appId.length === 0) {
    throw new Error("APP_DB_DEPROVISION job missing data.appId");
  }
  if (typeof data.dbUri !== "string" || data.dbUri.length === 0) {
    throw new Error("APP_DB_DEPROVISION job missing data.dbUri");
  }
  return { appId: data.appId, dbUri: data.dbUri };
}

/**
 * Daemon: run the DROP + slot-release for a claimed APP_DB_DEPROVISION job.
 * Decrypts the carried URI node-side (passthrough if already plaintext, e.g.
 * the env-DSN mode) and delegates to the injected deprovisioner, which resolves
 * the cluster from the DSN host, DROPs the DB + ROLE, then releases the slot.
 */
export async function dispatchAppDbDeprovisionJob(job: {
  data: unknown;
}): Promise<AppDbDeprovisionOutcome> {
  const { appId, dbUri } = readAppDbDeprovisionJobData(job);
  const dsn = await fieldEncryption.decryptIfNeeded(dbUri);
  if (!dsn) {
    // Nothing to resolve a cluster from — treat as already gone (idempotent).
    return { deprovisioned: false, reason: "empty-dsn" };
  }
  return getAppDbDeprovisioner().deprovisionForApp(appId, dsn);
}

// ── enqueue (Worker / request side) ─────────────────────────────────────────
/** Enqueue an APP_DB_DEPROVISION job (pg-free) over the shared job writer. */
export function enqueueAppDbDeprovision(
  writer: ContainerJobsWriter,
  p: { appId: string; organizationId: string; userId?: string; dbUri: string },
): Promise<{ id: string }> {
  return writer.insertJob({
    type: JOB_TYPES.APP_DB_DEPROVISION,
    organizationId: p.organizationId,
    userId: p.userId,
    data: { appId: p.appId, dbUri: p.dbUri },
  });
}

/**
 * Worker boot (Apps / Product 2): wire the app-delete path to hand isolated
 * tenant-DB teardown to the daemon via an APP_DB_DEPROVISION job, over the
 * shared (pg-free) job writer. Call once in cloud-api boot — after this,
 * deleting an app that has an isolated DB enqueues the real DROP the daemon
 * runs. Safe to import on workerd (no `pg`).
 */
export function configureAppsDeprovisionTrigger(): void {
  userDatabaseService.setDeprovisionEnqueuer((p) =>
    enqueueAppDbDeprovision(containerJobsWriter, p),
  );
}
