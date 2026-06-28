/**
 * #8342 (reopened) — env-DSN deploy mode must not leak the per-tenant DB/role/
 * cluster slot on app delete.
 *
 * In env-DSN mode (`APPS_TENANT_ADMIN_DSN` set → `makeDirectAppDeployRunner`),
 * provision happens DIRECTLY through `TenantDbProvisioning.provisionForApp` and
 * historically never wrote the canonical `app_databases` row. App delete tears
 * down by reading that row (`findStateByAppIdForWrite`) and returns early when
 * it's missing — so no APP_DB_DEPROVISION job, no DROP, and `releaseSlot` never
 * runs (the cluster's finite slots drift up until they exhaust).
 *
 * The fix persists the teardown-readable row at provision time, keyed by appId,
 * carrying the per-tenant DSN as plaintext (this mode has no master key; the
 * teardown path's `decryptIfNeeded` passes plaintext through). This test wires
 * the REAL seams end-to-end through the public deploy `run()` → row persist →
 * Worker delete enqueue → daemon dispatch — and asserts the DROP + `releaseSlot`
 * actually fire so the slot returns to baseline (no leak).
 */

import { describe, expect, mock, test } from "bun:test";
import type { AppDatabaseState } from "../../../db/repositories/app-databases";

// In-memory app_databases store shared by provision (updateState) and the
// Worker delete read (findStateByAppIdForWrite) — the row must survive across
// both for the teardown to resolve the DSN.
const appDatabasesStore = new Map<string, AppDatabaseState>();
// Toggle so a single test can simulate the canonical-row persist failing AFTER
// the tenant DB is already provisioned (Bug 4 — the compensating-teardown case).
const persistControl = { failUpdateState: false };
mock.module("../../../db/repositories/app-databases", () => ({
  appDatabasesRepository: {
    updateState: async (
      appId: string,
      data: Partial<AppDatabaseState>,
    ): Promise<AppDatabaseState> => {
      if (persistControl.failUpdateState) {
        throw new Error("app_databases updateState failed");
      }
      const next: AppDatabaseState = {
        app_id: appId,
        user_database_uri: null,
        user_database_region: "aws-us-east-1",
        user_database_status: "none",
        user_database_error: null,
        source: "app_databases",
        ...appDatabasesStore.get(appId),
        ...data,
      };
      appDatabasesStore.set(appId, next);
      return next;
    },
    findStateByAppIdForWrite: async (appId: string) => appDatabasesStore.get(appId),
  },
}));

const APP_ID = "11111111-2222-3333-4444-555555555555";
const ORG_ID = "org-env-dsn";
const USER_ID = "user-env-dsn";
const CLUSTER_HOST = "tenant-cluster.internal";
const ADMIN_DSN = `postgresql://admin:pw@${CLUSTER_HOST}/postgres`;

// The deploy runner loads the app via appsService.getById (twice: once to
// resolve the image, once in linkContainerToApp). databaseMode "isolated" is
// what makes the orchestrator call ensureTenantDb.
mock.module("../apps", () => ({
  appsService: {
    getById: async (id: string) =>
      id === APP_ID
        ? {
            id: APP_ID,
            name: "my-app",
            organization_id: ORG_ID,
            created_by_user_id: USER_ID,
            github_repo: null,
            metadata: { databaseMode: "isolated" },
          }
        : undefined,
    update: async () => {},
  },
}));

// The container row write is a real-schema seam in production; here we only need
// it to return a stable id so the orchestrator can enqueue + link.
mock.module("../../../db/repositories/containers", () => ({
  containersRepository: {
    create: async () => ({ id: "container-1" }),
    // The default createContainerRow enforces quota via createWithQuotaCheck.
    createWithQuotaCheck: async () => ({ id: "container-1" }),
    // No prior deploy for this app — the redeploy-retire step finds nothing.
    findUndeletedByProjectName: async () => [],
    updateStatus: async () => null,
  },
}));

import {
  dispatchAppDbDeprovisionJob,
  enqueueAppDbDeprovision,
  readAppDbDeprovisionJobData,
  setAppDbDeprovisioner,
} from "../app-db-deprovision-job-service";
import { makeDirectAppDeployRunner } from "../app-deploy-runner";
import type { ContainerJobInsert, ContainerJobsWriter } from "../container-job-service";
import { JOB_TYPES } from "../provisioning-job-types";
import type { TenantDbSqlExecutor } from "../tenant-db/tenant-db-provisioner";
import { SqlTenantDbProvisioner } from "../tenant-db/tenant-db-provisioner";
import { SqlTenantDbProvisioning } from "../tenant-db/tenant-db-provisioning";
import { UserDatabaseService } from "../user-database";

/** Fake executor that tracks the DDL it ran and which databases are live. */
function makeFakeExecutor(): { executor: TenantDbSqlExecutor; live: Set<string> } {
  const live = new Set<string>();
  const executor: TenantDbSqlExecutor = {
    async execAdmin(statements) {
      for (const stmt of statements) {
        const create = stmt.match(/CREATE DATABASE "([^"]+)"/);
        if (create) live.add(create[1]);
        const drop = stmt.match(/DROP DATABASE IF EXISTS "([^"]+)"/);
        if (drop) live.delete(drop[1]);
      }
    },
    async execInDatabase() {},
    async databaseExists(dbName) {
      return live.has(dbName);
    },
  };
  return { executor, live };
}

/**
 * Build the real provisioning seam in env-DSN mode (passthrough decrypt), with a
 * captured cluster + a `releaseSlot` spy. `database_count` is tracked so we can
 * assert the slot is claimed on provision and released on teardown.
 */
function makeProvisioning() {
  const { executor, live } = makeFakeExecutor();
  let databaseCount = 0;
  const released: string[] = [];

  const provisioning = new SqlTenantDbProvisioning({
    pool: {
      async allocate() {
        databaseCount += 1; // the real store's tryClaimSlot increments here
        return { id: "cluster-1", host: CLUSTER_HOST, adminDsnEncrypted: ADMIN_DSN };
      },
    },
    // env-DSN mode: the admin DSN is env-sourced, so decrypt is a passthrough.
    decrypt: async (value) => value,
    makeProvisioner: (cluster) =>
      new SqlTenantDbProvisioner({
        cluster,
        executor,
        genPassword: () => "deterministic-password",
      }),
    resolveClusterByHost: async (host) =>
      host === CLUSTER_HOST ? { id: "cluster-1", adminDsnEncrypted: ADMIN_DSN } : null,
    releaseSlot: async (clusterId) => {
      released.push(clusterId);
      databaseCount = Math.max(0, databaseCount - 1);
    },
  });

  return { provisioning, live, released, slotCount: () => databaseCount };
}

describe("env-DSN deploy mode — per-tenant DB teardown (#8342)", () => {
  test("deploy persists app_databases row; delete DROPs the DB and releases the slot", async () => {
    appDatabasesStore.clear();
    const { provisioning, live, released, slotCount } = makeProvisioning();

    const enqueued: ContainerJobInsert[] = [];
    const jobsWriter: ContainerJobsWriter = {
      async insertJob(job) {
        enqueued.push(job);
        return { id: `job-${enqueued.length}` };
      },
    };

    // ── DEPLOY (daemon, env-DSN mode) ─────────────────────────────────────
    const runner = makeDirectAppDeployRunner({
      tenantDbProvisioning: provisioning,
      jobsWriter,
      resolveImage: () => "ghcr.io/elizaos/app:test",
    });
    await runner.run(APP_ID);

    // The per-tenant DB is live and a cluster slot is claimed.
    expect(live.size).toBe(1);
    expect(slotCount()).toBe(1);

    // The canonical row is now persisted (the fix — previously absent in env-DSN
    // mode, which is exactly what stranded the teardown).
    const persisted = appDatabasesStore.get(APP_ID);
    expect(persisted?.user_database_status).toBe("ready");
    expect(persisted?.user_database_uri).toContain(CLUSTER_HOST);
    const dsn = persisted?.user_database_uri as string;

    // ── DELETE (Worker, no pg backend, enqueuer wired) ────────────────────
    const workerSvc = new UserDatabaseService(); // no provisioning backend == Worker
    workerSvc.setDeprovisionEnqueuer((p) => enqueueAppDbDeprovision(jobsWriter, p));
    await workerSvc.cleanupDatabase(APP_ID, { organizationId: ORG_ID, userId: USER_ID });

    // An APP_DB_DEPROVISION job was enqueued carrying the per-tenant DSN.
    const deprovJob = enqueued.find((j) => j.type === JOB_TYPES.APP_DB_DEPROVISION);
    expect(deprovJob).toBeDefined();
    expect(deprovJob?.organizationId).toBe(ORG_ID);
    const { appId, dbUri } = readAppDbDeprovisionJobData({ data: deprovJob?.data });
    expect(appId).toBe(APP_ID);
    expect(dbUri).toBe(dsn);

    // ── DAEMON dispatch — the real DROP + releaseSlot ─────────────────────
    setAppDbDeprovisioner(provisioning);
    const outcome = await dispatchAppDbDeprovisionJob({ data: deprovJob?.data });

    expect(outcome.deprovisioned).toBe(true);
    expect(live.size).toBe(0); // DB dropped
    expect(released).toEqual(["cluster-1"]); // slot released exactly once
    expect(slotCount()).toBe(0); // database_count back to baseline — no leak
  });

  // Bug 4 — env-DSN mode: if the canonical app_databases row fails to persist
  // AFTER the tenant DB is provisioned, the DB + cluster slot must NOT leak.
  // The compensating teardown DROPs the just-provisioned DB and releases the slot
  // before rethrowing, so a failed persist self-heals.
  test("updateState failure after provision triggers a compensating deprovision (no leak)", async () => {
    appDatabasesStore.clear();
    const { provisioning, live, released, slotCount } = makeProvisioning();

    const jobsWriter: ContainerJobsWriter = {
      async insertJob() {
        return { id: "job-x" };
      },
    };

    const runner = makeDirectAppDeployRunner({
      tenantDbProvisioning: provisioning,
      jobsWriter,
      resolveImage: () => "ghcr.io/elizaos/app:test",
    });

    persistControl.failUpdateState = true;
    try {
      // The deploy fails (the persist throws) and the error surfaces.
      await expect(runner.run(APP_ID)).rejects.toThrow("app_databases updateState failed");
    } finally {
      persistControl.failUpdateState = false;
    }

    // The just-provisioned DB was torn back down and the slot released — both
    // back to baseline, no orphaned DB and no leaked cluster slot.
    expect(live.size).toBe(0);
    expect(released).toEqual(["cluster-1"]);
    expect(slotCount()).toBe(0);
  });
});
