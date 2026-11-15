/** Real jobs, lease, placement and route SQL. Only external providers/auth are controlled. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
const database = await import("../../../db/client");
const { dbWrite, getPgliteClientForTests } = database;
const schema = {
  ...(await import("../../../db/schemas/apps")),
  ...(await import("../../../db/schemas/api-keys")),
  ...(await import("../../../db/schemas/mobile-app-auth-grants")),
  ...(await import("../../../db/schemas/jobs")),
  ...(await import("../../../db/schemas/job-execution-leases")),
  ...(await import("../../../db/schemas/app-databases")),
  ...(await import("../../../db/schemas/tenant-db-clusters")),
  ...(await import("../../../db/schemas/containers")),
  ...(await import("../../../db/schemas/docker-nodes")),
  ...(await import("../../../db/schemas/app-frontend-deployments")),
  ...(await import("../../../db/schemas/managed-domains")),
  ...(await import("../../../db/schemas/app-domains")),
  ...(await import("../../../db/schemas/secrets")),
};
const { apps, jobs, appDatabases, tenantDbClusters, containers, jobExecutionLeases, dockerNodes } =
  schema;
const { appDeletionOperations } = await import("../../../db/repositories/app-deletion-operations");
const { appsRepository } = await import("../../../db/repositories/apps");
const { jobsRepository } = await import("../../../db/repositories/jobs");
const { executeAppDeletion } = await import("../app-deletion");
const { dispatchAppDeletionDatabase } = await import("../app-deletion-database");
const { dispatchAppDeletionContainer } = await import("../app-deletion-container");
const { setAppDbDeprovisioner } = await import("../app-db-deprovision-job-service");
const { SqlTenantDbProvisioning } = await import("../tenant-db/tenant-db-provisioning");
const { ContainerRepoAppContainerStore } = await import("../app-container-store");
const { containersRepository } = await import("../../../db/repositories/containers");
const { githubReposService } = await import("../github-repos");
const { appsService } = await import("../apps");

import type { ContainerExecutorDeps } from "../container-job-executors";
import type { JobExecutionAuthority } from "../job-execution-authority";

let organizationId: string, appId: string, userId: string;
let providerCalls: string[], releaseCalls: string[];
const spies: Array<{ mockRestore(): void }> = [];
let currentPrincipal: string;
const realAuth = await import("@elizaos/cloud-shared/auth");
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({ id: userId, organization_id: currentPrincipal }),
}));
const { default: appRoute } = await import("../../../../../api/v1/apps/[id]/route");
const { default: jobRoute } = await import("../../../../../api/v1/jobs/[jobId]/route");
const router = new Hono();
router.route("/api/v1/apps/:id", appRoute);
router.route("/api/v1/jobs/:jobId", jobRoute);
const request = () => ({ appId, organizationId, userId, deleteGitHubRepo: false });
async function claim(type: string): Promise<JobExecutionAuthority> {
  const owner = randomUUID();
  const [job] = await jobsRepository.claimPendingJobs({
    type,
    limit: 1,
    executionOwnerId: owner,
    executionLeaseMs: 60_000,
  });
  if (!job?.execution_generation) throw new Error(`No claimed ${type}`);
  return {
    jobId: job.id,
    organizationId,
    executionGeneration: job.execution_generation,
    executionOwnerId: owner,
  };
}
async function settle(authority: JobExecutionAuthority) {
  const job = await jobsRepository.findByIdForWrite(authority.jobId);
  if (!job) throw new Error("Missing job");
  await jobsRepository.settleExecution(job, "completed", undefined, authority.executionOwnerId);
}
async function start() {
  await appsService.requestDeletion(request());
  return claim("app_delete");
}
async function addDatabase() {
  const clusterId = randomUUID();
  await dbWrite.insert(tenantDbClusters).values({
    id: clusterId,
    host: "original.invalid",
    admin_dsn_encrypted: "test-admin",
    database_count: 2,
  });
  await dbWrite.insert(appDatabases).values({
    app_id: appId,
    user_database_uri: "postgres://app:secret@original.invalid/app",
    tenant_db_cluster_id: clusterId,
    user_database_status: "ready",
  });
  return clusterId;
}
function provider(clusterId: string, effect: () => Promise<void> = async () => {}) {
  setAppDbDeprovisioner(
    new SqlTenantDbProvisioning({
      pool: {
        allocate: async () => {
          throw new Error("No allocation during teardown");
        },
      },
      decrypt: async (value) => value,
      resolveClusterByHost: async () => ({ id: clusterId, adminDsnEncrypted: "test-admin" }),
      makeProvisioner: () => ({
        provision: async () => {
          throw new Error("No new database");
        },
        deprovision: async (id) => {
          providerCalls.push(id);
          await effect();
          return { existed: providerCalls.length === 1 };
        },
      }),
      releaseSlot: async (id) => {
        releaseCalls.push(id);
      },
      clearPlacement: async () => {
        throw new Error("Placement must be released in the receipt transaction");
      },
    }),
  );
}
async function count() {
  return (await dbWrite.select().from(tenantDbClusters))[0]?.database_count;
}

beforeAll(async () => {
  for (let statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema),
  )) {
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    if (statement.startsWith('CREATE TABLE "apps"'))
      statement = statement.replace(/\n\s*"deletion_job_id" uuid,/, "");
    await dbWrite.execute(statement);
  }
  for (const statement of readFileSync(
    new URL("../../../db/migrations/0566_app_deletion_authority.sql", import.meta.url),
    "utf8",
  ).split("--> statement-breakpoint"))
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  for (const statement of readFileSync(
    new URL("../../../db/migrations/0568_app_cleanup_manifest.sql", import.meta.url),
    "utf8",
  ).split("--> statement-breakpoint"))
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  await getPgliteClientForTests().exec(
    "ALTER TABLE app_frontend_deployments ADD CONSTRAINT fixture_frontend_app FOREIGN KEY(app_id) REFERENCES apps(id) ON DELETE CASCADE; ALTER TABLE app_databases ADD CONSTRAINT fixture_database_app FOREIGN KEY(app_id) REFERENCES apps(id) ON DELETE CASCADE;",
  );
}, 120_000);
beforeEach(async () => {
  await getPgliteClientForTests().exec(
    "TRUNCATE apps CASCADE; TRUNCATE jobs CASCADE; TRUNCATE api_keys CASCADE; TRUNCATE mobile_app_auth_grants, containers, job_execution_leases, tenant_db_clusters, docker_nodes CASCADE",
  );
  organizationId = randomUUID();
  appId = randomUUID();
  userId = randomUUID();
  currentPrincipal = organizationId;
  providerCalls = [];
  releaseCalls = [];
  await dbWrite.insert(apps).values({
    id: appId,
    organization_id: organizationId,
    name: "Teardown fixture",
    slug: appId,
    app_url: "https://app.example",
    is_active: true,
  });
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
afterAll(database.closeDatabaseConnectionsForTests);

test("the actual DELETE route returns 202 until the original root has a confirmed completion receipt", async () => {
  const pending = await router.request(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
    method: "DELETE",
  });
  expect(pending.status).toBe(202);
  const body = await pending.json();
  expect(body.success).toBe(false);
  expect(body.state).toBe("pending");
  const root = await claim("app_delete");
  expect(root.jobId).toBe(body.jobId);
  await executeAppDeletion(root);
  await settle(root);
  expect(await appsRepository.findByIdForWrite(appId)).toBeUndefined();
  const complete = await router.request(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
    method: "DELETE",
  });
  expect(complete.status).toBe(200);
  expect((await complete.json()).jobId).toBe(root.jobId);
  await executeAppDeletion({ ...root, executionGeneration: randomUUID() }).then(
    () => {
      throw new Error("Stale execution accepted");
    },
    (error) => expect(error.name).toBe("StaleJobExecutionError"),
  );
  expect(await dbWrite.select().from(jobs)).toHaveLength(1);
});

test("foreign and invalid DELETE requests cannot create a root or revoke the app", async () => {
  currentPrincipal = randomUUID();
  expect((await router.request(`/api/v1/apps/${appId}`, { method: "DELETE" })).status).toBe(403);
  currentPrincipal = organizationId;
  expect(
    (await router.request(`/api/v1/apps/${appId}?deleteGitHubRepo=invalid`, { method: "DELETE" }))
      .status,
  ).toBe(400);
  expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  expect((await appsRepository.findByIdForWrite(appId))?.is_active).toBe(true);
  expect((await router.request("/api/v1/apps/invalid-id", { method: "DELETE" })).status).toBe(400);
});

test("public job status and failure receipts never expose the retained database URI", async () => {
  const foreignOrg = randomUUID(),
    foreignKey = randomUUID();
  await dbWrite.insert(schema.apiKeys).values({
    id: foreignKey,
    name: "foreign mobile",
    key_hash: foreignKey,
    key_prefix: "eliza_mobile_",
    user_id: randomUUID(),
    organization_id: foreignOrg,
    source_app_id: appId,
  });
  await addDatabase();
  const root = await start();
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  const rootStatus = await router.request(`/api/v1/jobs/${root.jobId}`);
  expect(rootStatus.status).toBe(200);
  const publicRoot = await rootStatus.text();
  expect(publicRoot).not.toContain(foreignOrg);
  expect(publicRoot).not.toContain(foreignKey);
  expect(publicRoot).not.toContain("revokedKeys");
  const child = (await dbWrite.select().from(jobs)).find(
    (row) => row.type === "app_db_deprovision",
  )!;
  expect(JSON.stringify(child.data)).not.toContain("postgres://");
  expect(JSON.stringify(child.data)).not.toContain("secret");
  await dbWrite
    .update(jobs)
    .set({ error: "Connection failed: postgres://app:secret@original.invalid/app" })
    .where(eq(jobs.id, child.id));
  const response = await router.request(`/api/v1/jobs/${child.id}`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain("secret");
  expect(body).not.toContain("postgres://");
  expect(body).not.toContain("original.invalid");
});

test("a retry with different deletion options conflicts without another root", async () => {
  await appDeletionOperations.admit(request());
  const response = await router.request(`/api/v1/apps/${appId}?deleteGitHubRepo=true`, {
    method: "DELETE",
  });
  expect(response.status).toBe(409);
  expect(await dbWrite.select().from(jobs)).toHaveLength(1);
});

test("original database child confirmation releases capacity once and gates the final cascade", async () => {
  const cluster = await addDatabase();
  provider(cluster);
  const root = await start();
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  expect((await appsRepository.findByIdForWrite(appId))?.deletion_job_id).toBe(root.jobId);
  const child = await claim("app_db_deprovision");
  await dispatchAppDeletionDatabase(child);
  await dispatchAppDeletionDatabase(child);
  expect(providerCalls).toEqual([appId]);
  expect(releaseCalls).toEqual([]);
  expect(await count()).toBe(1);
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  await settle(child);
  await executeAppDeletion(root);
  await settle(root);
  expect(await appsRepository.findByIdForWrite(appId)).toBeUndefined();
  expect(await count()).toBe(1);
});

test("a provider DROP with a lost response is recoverable without double releasing capacity", async () => {
  const cluster = await addDatabase();
  let first = true;
  provider(cluster, async () => {
    if (first) {
      first = false;
      throw new Error("Controlled response loss after DROP");
    }
  });
  const root = await start();
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  const child = await claim("app_db_deprovision");
  await expect(dispatchAppDeletionDatabase(child)).rejects.toThrow("Controlled response loss");
  expect(await count()).toBe(2);
  await dispatchAppDeletionDatabase(child);
  expect(await count()).toBe(1);
  expect(providerCalls).toHaveLength(2);
  expect(releaseCalls).toEqual([]);
  await settle(child);
  await executeAppDeletion(root);
  expect(await appsRepository.findByIdForWrite(appId)).toBeUndefined();
});

test("a changed cluster or expired child lease cannot dispatch an original database DROP", async () => {
  await addDatabase();
  provider(randomUUID());
  const root = await start();
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  const child = await claim("app_db_deprovision");
  await expect(dispatchAppDeletionDatabase(child)).rejects.toThrow("cluster identity changed");
  expect(providerCalls).toEqual([]);
  await dbWrite
    .update(jobExecutionLeases)
    .set({ expires_at: sql`(clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'` })
    .where(eq(jobExecutionLeases.job_id, child.jobId));
  await expect(dispatchAppDeletionDatabase(child)).rejects.toMatchObject({
    name: "StaleJobExecutionError",
  });
  expect(providerCalls).toEqual([]);
  expect(await count()).toBe(2);
});

test("receipt write failure rolls back both placement release and capacity decrement", async () => {
  const cluster = await addDatabase();
  provider(cluster);
  const root = await start();
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  const child = await claim("app_db_deprovision");
  await getPgliteClientForTests().exec(
    "CREATE FUNCTION fail_child_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result->>'appDeletionConfirmed'='true' THEN RAISE EXCEPTION 'controlled receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_child_receipt BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION fail_child_receipt();",
  );
  try {
    await expect(dispatchAppDeletionDatabase(child)).rejects.toThrow();
  } finally {
    await getPgliteClientForTests().exec(
      "DROP TRIGGER fail_child_receipt ON jobs; DROP FUNCTION fail_child_receipt()",
    );
  }
  expect(await count()).toBe(2);
  expect((await dbWrite.select().from(appDatabases))[0]?.tenant_db_cluster_id).toBe(cluster);
  await dispatchAppDeletionDatabase(child);
  expect(await count()).toBe(1);
});

async function containerFixture() {
  const containerId = randomUUID();
  await dbWrite
    .insert(dockerNodes)
    .values({ node_id: "original-node", hostname: "original-node.invalid" });
  await dbWrite.insert(containers).values({
    id: containerId,
    organization_id: organizationId,
    user_id: userId,
    name: `app-${appId}`,
    project_name: appId,
    port: 3000,
    status: "running",
    node_id: "original-node",
    metadata: {
      appId,
      hostContainerId: "original-docker-id",
      hostname: "original-node.invalid",
      slotReleasedAt: "already-released-fixture",
    },
  });
  const store = new ContainerRepoAppContainerStore({
    readDatabase: dbWrite,
    writeDatabase: dbWrite,
    repository: containersRepository,
    errorFactory: (message, options) => Object.assign(new Error(message), options),
  });
  const deps = {
    store,
    provider: {
      targetNodeId: "original-node",
      deleteById: async (id: string) => {
        providerCalls.push(id);
      },
      deletePrimaryById: async (id: string) => {
        providerCalls.push(id);
      },
    },
  } as unknown as ContainerExecutorDeps;
  return { containerId, deps };
}

test("container teardown confirms the captured Docker identity and node before the app can disappear", async () => {
  const { containerId, deps } = await containerFixture();
  const root = await start();
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  const child = await claim("container_delete");
  await dispatchAppDeletionContainer(child, deps);
  await dispatchAppDeletionContainer(child, deps);
  expect(providerCalls).toEqual(["original-docker-id"]);
  expect(
    (await dbWrite.select().from(containers).where(eq(containers.id, containerId)))[0]?.status,
  ).toBe("deleted");
  await settle(child);
  await executeAppDeletion(root);
  expect(await appsRepository.findByIdForWrite(appId)).toBeUndefined();
});

test("a backend for a different node cannot falsely confirm container removal", async () => {
  const { deps } = await containerFixture();
  const root = await start();
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  const child = await claim("container_delete");
  Object.assign(deps.provider, { targetNodeId: "rotated-default-node" });
  await expect(dispatchAppDeletionContainer(child, deps)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  expect(providerCalls).toEqual([]);
});

test("unconfirmed legacy containers and direct app deletion remain fenced", async () => {
  const { containerId } = await containerFixture();
  await dbWrite.update(containers).set({ metadata: {} }).where(eq(containers.id, containerId));
  const root = await start();
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  await expect(appsRepository.finalizeDelete(appId)).rejects.toMatchObject({
    code: "APP_DELETION_IN_PROGRESS",
  });
  await expect(
    getPgliteClientForTests().query("DELETE FROM apps WHERE id=$1", [appId]),
  ).rejects.toMatchObject({ code: "23514" });
  expect(providerCalls).toEqual([]);
  expect(await dbWrite.select().from(jobs)).toHaveLength(1);
});

test("a GitHub dispatch with an unknown outcome is never repeated or treated as successful", async () => {
  await dbWrite
    .update(apps)
    .set({ github_repo: "original-owner/original-repo" })
    .where(eq(apps.id, appId));
  spies.push(
    spyOn(githubReposService, "observeAppRepoForDeletion").mockResolvedValue({
      owner: "original-owner",
      name: "original-repo",
      id: 123,
    }),
  );
  const remove = spyOn(githubReposService, "deleteObservedAppRepo").mockImplementation(async () => {
    throw new Error("controlled unknown repository result");
  });
  spies.push(remove);
  await appsService.requestDeletion({ ...request(), deleteGitHubRepo: true });
  const root = await claim("app_delete");
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_OPERATOR_RECONCILIATION_REQUIRED",
  });
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_OPERATOR_RECONCILIATION_REQUIRED",
  });
  expect(remove).toHaveBeenCalledTimes(1);
  expect((await appsRepository.findByIdForWrite(appId))?.is_active).toBe(false);
});

test("original job replay after ownership changes remains a read without another policy mutation", async () => {
  const first = await appDeletionOperations.admit(request());
  await dbWrite.update(apps).set({ created_by_user_id: randomUUID() }).where(eq(apps.id, appId));
  const replay = await appDeletionOperations.admit(request());
  expect(replay?.job.id).toBe(first?.job.id);
  expect(await dbWrite.select().from(jobs)).toHaveLength(1);
  expect((await appsService.delete(appId))?.jobId).toBe(first?.job.id);
});

test("a legacy deleted container status is not accepted without original provider identity", async () => {
  await dbWrite.insert(containers).values({
    organization_id: organizationId,
    user_id: userId,
    name: "legacy-deleted",
    project_name: appId,
    port: 3000,
    status: "deleted",
    metadata: {},
  });
  const root = await start();
  await expect(executeAppDeletion(root)).rejects.toMatchObject({
    code: "APP_DELETION_RECOVERY_PENDING",
  });
  expect((await appsRepository.findByIdForWrite(appId))?.deletion_job_id).toBe(root.jobId);
  expect(providerCalls).toEqual([]);
});

async function suppressUpdate(table: string, condition: string, operation: () => Promise<void>) {
  await getPgliteClientForTests().exec(
    `CREATE FUNCTION suppress_deletion_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER suppress_deletion_write BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_deletion_write();`,
  );
  try {
    await operation();
  } finally {
    await getPgliteClientForTests().exec(
      `DROP TRIGGER suppress_deletion_write ON ${table}; DROP FUNCTION suppress_deletion_write();`,
    );
  }
}

test("suppressed resource-plan publication rolls back child creation before dispatch", async () => {
  await addDatabase();
  const root = await start();
  await suppressUpdate("jobs", "NEW.result ? 'deletionPlan'", async () => {
    await expect(executeAppDeletion(root)).rejects.toMatchObject({
      code: "APP_DELETION_RECOVERY_PENDING",
    });
  });
  expect(await dbWrite.select().from(jobs)).toHaveLength(1);
  expect(providerCalls).toEqual([]);
});

test("suppressed GitHub dispatch publication cannot authorize a provider DELETE", async () => {
  await dbWrite
    .update(apps)
    .set({ github_repo: "original-owner/original-repo" })
    .where(eq(apps.id, appId));
  spies.push(
    spyOn(githubReposService, "observeAppRepoForDeletion").mockResolvedValue({
      owner: "original-owner",
      name: "original-repo",
      id: 123,
    }),
  );
  const remove = spyOn(githubReposService, "deleteObservedAppRepo").mockResolvedValue(undefined);
  spies.push(remove);
  await appsService.requestDeletion({ ...request(), deleteGitHubRepo: true });
  const root = await claim("app_delete");
  await suppressUpdate("jobs", "NEW.result->'githubDeletion'->>'dispatched' = 'true'", async () => {
    await expect(executeAppDeletion(root)).rejects.toMatchObject({
      code: "APP_DELETION_RECOVERY_PENDING",
    });
  });
  expect(remove).not.toHaveBeenCalled();
  expect(
    (await jobsRepository.findByIdForWrite(root.jobId))?.result?.githubDeletion,
  ).toBeUndefined();
});

for (const target of ["placement", "receipt"] as const)
  test(`suppressed database ${target} write rolls back capacity release`, async () => {
    const cluster = await addDatabase();
    provider(cluster);
    const root = await start();
    await expect(executeAppDeletion(root)).rejects.toMatchObject({
      code: "APP_DELETION_RECOVERY_PENDING",
    });
    const child = await claim("app_db_deprovision");
    await suppressUpdate(
      target === "placement" ? "app_databases" : "jobs",
      target === "placement"
        ? "NEW.user_database_uri IS NULL"
        : "NEW.result->>'appDeletionConfirmed' = 'true'",
      async () => {
        await expect(dispatchAppDeletionDatabase(child)).rejects.toMatchObject({
          code: "APP_DELETION_RECOVERY_PENDING",
        });
      },
    );
    expect(await count()).toBe(2);
    expect((await dbWrite.select().from(appDatabases))[0]?.tenant_db_cluster_id).toBe(cluster);
    expect(
      (await jobsRepository.findByIdForWrite(child.jobId))?.result?.appDeletionConfirmed,
    ).not.toBe(true);
  });

test("suppressed final completion receipt retains the original app", async () => {
  const root = await start();
  await suppressUpdate("jobs", "NEW.result->>'appDeleted' = 'true'", async () => {
    await expect(executeAppDeletion(root)).rejects.toMatchObject({
      code: "APP_DELETION_COMPLETION_UNCONFIRMED",
    });
  });
  expect((await appsRepository.findByIdForWrite(appId))?.deletion_job_id).toBe(root.jobId);
});

test("failed revocation delivery blocks teardown and original replay retries the same targets", async () => {
  const key = randomUUID();
  await dbWrite.insert(schema.apiKeys).values({
    id: key,
    name: "mobile",
    key_hash: key,
    key_prefix: "eliza_mobile_",
    user_id: userId,
    organization_id: organizationId,
    source_app_id: appId,
  });
  const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");
  let fail = true;
  const deliveries: string[] = [];
  const run = <T>(operation: () => Promise<T>) =>
    runWithCloudBindingsAsync(
      {
        DATABASE_URL: "pglite://memory",
        TEST_DATABASE_URL: "pglite://memory",
        NODE_ENV: "test",
        MOCK_REDIS: "1",
        INFERENCE_ADMISSION_GATES: {
          getByName: () => ({
            fetch: async (request: Request) => {
              const body = (await request.json()) as { credentialId: string };
              deliveries.push(body.credentialId);
              return fail
                ? new Response("unavailable", { status: 503 })
                : Response.json({ committed: true });
            },
          }),
        },
      },
      operation,
    );
  await expect(run(() => appsService.requestDeletion(request()))).rejects.toMatchObject({
    code: "INFERENCE_CREDENTIAL_REVOCATION_UNAVAILABLE",
  });
  const original = await appDeletionOperations.admit(request());
  if (!original) throw new Error("No original deletion");
  const expectUnclaimed = async () => {
    expect(await jobsRepository.claimPendingJobs({ type: "app_delete", limit: 1 })).toEqual([]);
    expect(
      await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
        type: "app_delete",
        sharedTypes: ["app_delete"],
        maxRunning: 1,
        limit: 1,
      }),
    ).toEqual([]);
    const [pending] = await dbWrite.select().from(jobs).where(eq(jobs.id, original.job.id));
    expect(pending?.status).toBe("pending");
    expect(pending?.execution_generation).toBeNull();
    expect(pending?.retryable_requeues).toBe(0);
  };
  await expectUnclaimed();
  // Opaque storage and malformed acknowledgements cannot authorize execution.
  await dbWrite
    .update(jobs)
    .set({ result_storage: "r2", result_key: "unknown-revocation", result: null })
    .where(eq(jobs.id, original.job.id));
  await expectUnclaimed();
  for (const revocationsConfirmed of [false, "true"]) {
    await dbWrite
      .update(jobs)
      .set({ result_storage: "inline", result_key: null, result: { revocationsConfirmed } })
      .where(eq(jobs.id, original.job.id));
    await expectUnclaimed();
  }
  fail = false;
  expect((await run(() => appsService.requestDeletion(request())))?.jobId).toBe(original.job.id);
  expect(deliveries).toEqual([key, key]);
  const root = await claim("app_delete");
  expect(root.jobId).toBe(original.job.id);
  await executeAppDeletion(root);
  expect(await appsRepository.findByIdForWrite(appId)).toBeUndefined();
});

test("a complete credential list above the normal offload ceiling remains replayable inline", async () => {
  const keys = Array.from({ length: 11_000 }, () => {
    const id = randomUUID();
    return {
      id,
      name: "mobile",
      key_hash: id,
      key_prefix: "eliza_mobile_",
      user_id: userId,
      organization_id: organizationId,
      source_app_id: appId,
    };
  });
  for (let offset = 0; offset < keys.length; offset += 200)
    await dbWrite.insert(schema.apiKeys).values(keys.slice(offset, offset + 200));
  const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");
  const { setRuntimeR2Bucket } = await import("../../storage/r2-runtime-binding");
  let puts = 0,
    deliveries = 0;
  setRuntimeR2Bucket({
    put: async () => {
      puts++;
      throw new Error("Authority must not be offloaded");
    },
    get: async () => null,
    delete: async () => {},
  });
  try {
    await runWithCloudBindingsAsync(
      {
        DATABASE_URL: "pglite://memory",
        TEST_DATABASE_URL: "pglite://memory",
        NODE_ENV: "test",
        MOCK_REDIS: "1",
        SQL_HEAVY_PAYLOAD_STORAGE: "r2",
        SQL_HEAVY_PAYLOAD_MIN_BYTES: "1024",
        INFERENCE_ADMISSION_GATES: {
          getByName: () => ({
            fetch: async () => {
              deliveries++;
              return Response.json({ committed: true });
            },
          }),
        },
      },
      async () => {
        const admitted = await appDeletionOperations.admit(request());
        expect(admitted?.job.data_storage).toBe("inline");
        expect(Buffer.byteLength(JSON.stringify(admitted?.job.data))).toBeGreaterThan(1_048_576);
        const replay = await appDeletionOperations.admit(request());
        expect(replay?.revokedKeys.map((key) => key.id).sort()).toEqual(
          keys.map((key) => key.id).sort(),
        );
        expect((await appsService.requestDeletion(request()))?.jobId).toBe(admitted?.job.id);
        expect(deliveries).toBe(keys.length);
        expect(puts).toBe(0);
        expect(
          (await jobsRepository.findByIdForWrite(admitted!.job.id))?.result?.revocationsConfirmed,
        ).toBe(true);
      },
    );
  } finally {
    setRuntimeR2Bucket(null);
  }
}, 120_000);

test("a known other-app offloaded job does not block original app teardown", async () => {
  const { setRuntimeR2Bucket } = await import("../../storage/r2-runtime-binding");
  const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");
  const { prepareJobInsertData } = await import("../../../db/repositories/jobs");
  const values = new Map<string, string>();
  let reads = 0;
  setRuntimeR2Bucket({
    put: async (key, body) => {
      const value = await new Response(body as BodyInit).text();
      values.set(key, value);
      return { etag: key, size: value.length };
    },
    get: async (key) => {
      reads++;
      const value = values.get(key);
      return value === undefined
        ? null
        : {
            text: async () => value,
            arrayBuffer: async () => new TextEncoder().encode(value).buffer,
          };
    },
    delete: async (key) => {
      values.delete(key);
    },
  });
  try {
    await runWithCloudBindingsAsync(
      {
        DATABASE_URL: "pglite://memory",
        TEST_DATABASE_URL: "pglite://memory",
        NODE_ENV: "test",
        MOCK_REDIS: "1",
        SQL_HEAVY_PAYLOAD_STORAGE: "r2",
        SQL_HEAVY_PAYLOAD_MIN_BYTES: "1024",
      },
      async () => {
        const otherApp = randomUUID();
        await dbWrite.insert(apps).values({
          id: otherApp,
          organization_id: organizationId,
          name: "Other",
          slug: otherApp,
          app_url: "https://other.example",
        });
        const other = await prepareJobInsertData({
          type: "app_deploy",
          organization_id: organizationId,
          data: { appId: otherApp, completePayload: "x".repeat(2048) },
        });
        expect(other.data_storage).toBe("r2");
        await dbWrite.insert(jobs).values(other);
        const root = await start();
        await executeAppDeletion(root);
        expect(await appsRepository.findByIdForWrite(appId)).toBeUndefined();
        expect(await appsRepository.findByIdForWrite(otherApp)).toBeDefined();
        expect(reads).toBeGreaterThan(0);
      },
    );
  } finally {
    setRuntimeR2Bucket(null);
  }
});

test("a job target changed after full restoration cannot pass final quiescence", async () => {
  const { prepareAppDeletionPlan } = await import("../../../db/repositories/app-deletion-plan");
  const { restoreAppDeletionQuiescence } = await import(
    "../../../db/repositories/app-deletion-quiescence"
  );
  const { withAppDeletionExecution } = await import(
    "../../../db/repositories/app-deletion-execution"
  );
  const { assertAppDeletionReady } = await import(
    "../../../db/repositories/app-deletion-finalization"
  );
  const other = randomUUID();
  await dbWrite.insert(jobs).values({
    id: other,
    type: "app_deploy",
    organization_id: organizationId,
    data: { appId: randomUUID() },
  });
  const root = await start();
  await prepareAppDeletionPlan(root);
  const observed = await restoreAppDeletionQuiescence(organizationId);
  await dbWrite
    .update(jobs)
    .set({ data: { appId }, updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'` })
    .where(eq(jobs.id, other));
  await expect(
    withAppDeletionExecution(root, (tx, context) => assertAppDeletionReady(tx, context, observed)),
  ).rejects.toMatchObject({ code: "APP_DELETION_RECOVERY_PENDING" });
  expect(await appsRepository.findByIdForWrite(appId)).toBeDefined();
});

test("suppressed GitHub completion receipt retains an explicit operator recovery state", async () => {
  await dbWrite
    .update(apps)
    .set({ github_repo: "original-owner/original-repo" })
    .where(eq(apps.id, appId));
  spies.push(
    spyOn(githubReposService, "observeAppRepoForDeletion").mockResolvedValue({
      owner: "original-owner",
      name: "original-repo",
      id: 123,
    }),
  );
  const remove = spyOn(githubReposService, "deleteObservedAppRepo").mockResolvedValue(undefined);
  spies.push(remove);
  await appsService.requestDeletion({ ...request(), deleteGitHubRepo: true });
  const root = await claim("app_delete");
  await suppressUpdate("jobs", "NEW.result->'githubDeletion'->>'confirmed' = 'true'", async () => {
    await expect(executeAppDeletion(root)).rejects.toMatchObject({
      code: "APP_DELETION_OPERATOR_RECONCILIATION_REQUIRED",
    });
  });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(
    (await jobsRepository.findByIdForWrite(root.jobId))?.result?.operatorReconciliationRequired,
  ).toBe(true);
  expect(await appsRepository.findByIdForWrite(appId)).toBeDefined();
});

test("the real apps worker completes the API's original deletion job before success replay", async () => {
  const { ProvisioningJobService } = await import("../../../node/provisioning-worker");
  const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");
  const key = randomUUID();
  await dbWrite.insert(schema.apiKeys).values({
    id: key,
    name: "mobile",
    key_hash: key,
    key_prefix: "eliza_mobile_",
    user_id: userId,
    organization_id: organizationId,
    source_app_id: appId,
  });
  const revocationStarted = Promise.withResolvers<void>();
  const revocationDelivery = Promise.withResolvers<void>();
  const responsePromise = runWithCloudBindingsAsync(
    {
      DATABASE_URL: "pglite://memory",
      TEST_DATABASE_URL: "pglite://memory",
      NODE_ENV: "test",
      MOCK_REDIS: "1",
      INFERENCE_ADMISSION_GATES: {
        getByName: () => ({
          fetch: async () => {
            revocationStarted.resolve();
            await revocationDelivery.promise;
            return Response.json({ committed: true });
          },
        }),
      },
    },
    () =>
      router.request(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
        method: "DELETE",
      }),
  );
  const service = new ProvisioningJobService();
  try {
    await revocationStarted.promise;
    // Admission has committed, but the external revocation is still in flight.
    await service.processPendingJobs(1, { jobTypes: ["app_delete"] });
  } finally {
    revocationDelivery.resolve();
  }
  const response = await responsePromise;
  expect(response.status).toBe(202);
  const body = await response.json();
  const ready = await jobsRepository.findByIdForWrite(body.jobId);
  expect(ready?.status).toBe("pending");
  expect(ready?.execution_generation).toBeNull();
  expect(ready?.retryable_requeues).toBe(0);
  expect(ready?.result?.revocationsConfirmed).toBe(true);
  await service.processPendingJobs(1, { jobTypes: ["app_delete"] });
  const job = await jobsRepository.findByIdForWrite(body.jobId);
  expect(job?.status).toBe("completed");
  expect(job?.result?.appDeleted).toBe(true);
  expect(job?.execution_quiesced_at).toBeInstanceOf(Date);
  expect(
    (await router.request(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, { method: "DELETE" }))
      .status,
  ).toBe(200);
});

test("completed deletion replay does not depend on the current revocation gate", async () => {
  const key = randomUUID();
  await dbWrite.insert(schema.apiKeys).values({
    id: key,
    name: "mobile",
    key_hash: key,
    key_prefix: "eliza_mobile_",
    user_id: userId,
    organization_id: organizationId,
    source_app_id: appId,
  });
  const { runWithCloudBindingsAsync } = await import("../../runtime/cloud-bindings");
  let unavailable = false,
    deliveries = 0;
  const run = <T>(operation: () => Promise<T>) =>
    runWithCloudBindingsAsync(
      {
        DATABASE_URL: "pglite://memory",
        TEST_DATABASE_URL: "pglite://memory",
        NODE_ENV: "test",
        MOCK_REDIS: "1",
        INFERENCE_ADMISSION_GATES: {
          getByName: () => ({
            fetch: async () => {
              deliveries++;
              return unavailable
                ? new Response("unavailable", { status: 503 })
                : Response.json({ committed: true });
            },
          }),
        },
      },
      operation,
    );
  const original = await run(() => appsService.requestDeletion(request()));
  const root = await claim("app_delete");
  await executeAppDeletion(root);
  await settle(root);
  unavailable = true;
  await expect(run(() => appsService.requestDeletion(request()))).resolves.toMatchObject({
    state: "completed",
    jobId: original!.jobId,
  });
  expect(deliveries).toBe(1);
});

test("app deletion receipt guards do not freeze unrelated job result fields", async () => {
  const id = randomUUID();
  await dbWrite.insert(jobs).values({
    id,
    type: "other_job",
    organization_id: organizationId,
    data: {},
    result: { appDeleted: true },
  });
  const [updated] = await dbWrite
    .update(jobs)
    .set({ result: { appDeleted: false, ordinaryResult: "updated" } })
    .where(eq(jobs.id, id))
    .returning();
  expect(updated?.result).toEqual({ appDeleted: false, ordinaryResult: "updated" });
});

test("public job status omits the retained private frontend cleanup manifest", async () => {
  const { setRuntimeR2Bucket } = await import("../../storage/r2-runtime-binding");
  const privatePrefix = `private-storage/${appId}/original-deployment/`;
  await dbWrite.insert(schema.appFrontendDeployments).values({
    app_id: appId,
    version: 1,
    status: "active",
    r2_prefix: privatePrefix,
    manifest: {
      entrypoint: "private-entry.html",
      spaFallback: false,
      files: [
        { path: "private-entry.html", hash: "a".repeat(64), contentType: "text/html", size: 1 },
      ],
    },
  });
  setRuntimeR2Bucket({
    get: async () => null,
    put: async () => {
      throw new Error("No upload");
    },
    delete: async () => {},
  });
  try {
    const authority = await start();
    await executeAppDeletion(authority);
    await settle(authority);
    const stored = await jobsRepository.findByIdForWrite(authority.jobId);
    expect(JSON.stringify(stored?.data)).toContain(privatePrefix);
    const response = await router.request(`/api/v1/jobs/${authority.jobId}`);
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(serialized).not.toContain("frontendCleanupPlan");
    expect(serialized).not.toContain(privatePrefix);
    expect(serialized).not.toContain("private-entry.html");
    expect(JSON.parse(serialized).data.result.cleanupConfirmed).toBe(true);
  } finally {
    setRuntimeR2Bucket(null);
  }
});

test("the DELETE route stays pending after metadata cascade until original artifact cleanup is acknowledged", async () => {
  const { setRuntimeR2Bucket } = await import("../../storage/r2-runtime-binding");
  await dbWrite.insert(schema.appFrontendDeployments).values({
    app_id: appId,
    version: 1,
    status: "active",
    r2_prefix: `original/${appId}/`,
    manifest: {
      entrypoint: "index.html",
      spaFallback: false,
      files: [{ path: "index.html", hash: "b".repeat(64), contentType: "text/html", size: 1 }],
    },
  });
  let unavailable = true;
  setRuntimeR2Bucket({
    get: async () => null,
    put: async () => {
      throw new Error("No upload");
    },
    delete: async () => {
      if (unavailable) throw new Error("controlled unavailable");
    },
  });
  try {
    const first = await router.request(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
      method: "DELETE",
    });
    expect(first.status).toBe(202);
    const authority = await claim("app_delete");
    await expect(executeAppDeletion(authority)).rejects.toMatchObject({
      code: "APP_DELETION_RECOVERY_PENDING",
    });
    expect(await appsRepository.findByIdForWrite(appId)).toBeUndefined();
    const pending = await router.request(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
      method: "DELETE",
    });
    expect(pending.status).toBe(202);
    expect((await pending.json()).success).toBe(false);
    unavailable = false;
    await executeAppDeletion(authority);
    await settle(authority);
    expect(
      (await router.request(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, { method: "DELETE" }))
        .status,
    ).toBe(200);
  } finally {
    setRuntimeR2Bucket(null);
  }
});
