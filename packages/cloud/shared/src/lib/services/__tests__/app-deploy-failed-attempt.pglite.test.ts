import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("app-deploy-failed-attempt.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { ProvisioningJobService } from "@elizaos/cloud-shared/node";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../../db/schemas/api-keys";
import { appDeploymentStatusEnum, appReviewStatusEnum, apps } from "../../../db/schemas/apps";
import { generations } from "../../../db/schemas/generations";
import { jobExecutionLeases } from "../../../db/schemas/job-execution-leases";
import { jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import {
  configureAppsDeployTrigger,
  enqueueAppDeploy,
  setAppDeployRunner,
} from "../app-deploy-job-service";
import { DefaultAppDeployRunner } from "../app-deploy-runner";
import { appDeploymentsService } from "../app-deployments";
import { appsService } from "../apps";
import { containerJobsWriter } from "../container-jobs-writer";
import { JOB_TYPES } from "../provisioning-job-types";

const TEST_TIMEOUT = 300_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const schema = {
    organizations,
    users,
    userCharacters,
    agentSandboxes,
    apiKeys,
    generations,
    appDeploymentStatusEnum,
    appReviewStatusEnum,
    apps,
    jobs,
    jobExecutionLeases,
    usageRecords,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
}, TEST_TIMEOUT);

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  configureAppsDeployTrigger();
  setAppDeployRunner(
    new DefaultAppDeployRunner({
      ensureTenantDb: async () => {
        throw new Error("tenant DB must not be reached without an image");
      },
      jobsWriter: containerJobsWriter,
    }),
  );
});

afterEach(async () => {
  await dbWrite.delete(jobs);
});

async function seedApp() {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: `org-${crypto.randomUUID()}`, credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: `steward-${crypto.randomUUID()}`,
      organization_id: organization.id,
    })
    .returning();
  const [app] = await dbWrite
    .insert(apps)
    .values({
      name: "My App",
      slug: `app-${crypto.randomUUID()}`,
      organization_id: organization.id,
      created_by_user_id: user.id,
      app_url: "https://example.com",
      github_repo: "https://github.com/someone/app",
    })
    .returning();

  return {
    appId: app.id,
    organizationId: organization.id,
    userId: user.id,
  };
}

async function readJob(id: string) {
  const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, id));
  return job;
}

test(
  "a deploy attempt that fails after the runner claims it leaves the app redeployable",
  async () => {
    const input = await seedApp();
    const first = await appDeploymentsService.createDeployment(input);
    expect(first.status).toBe("BUILDING");

    const worker = new ProvisioningJobService();
    for (let pass = 0; pass < 3; pass++) {
      await dbWrite.execute(
        sql`UPDATE jobs SET scheduled_for = now() - interval '1 second' WHERE status = 'pending'`,
      );
      await worker.processPendingJobs(5, { jobTypes: [JOB_TYPES.APP_DEPLOY] });
    }

    const [afterFailure] = await dbWrite
      .select({ status: apps.deployment_status })
      .from(apps)
      .where(eq(apps.id, input.appId));
    expect(afterFailure.status).toBe("failed");
    expect((await appDeploymentsService.getLatestDeployment(input.appId))?.status).toBe("ERROR");
    const failedJob = await readJob(first.deploymentId);
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.attempts).toBe(1);
    expect(failedJob?.error).toContain("build-from-repo is disabled");

    await dbWrite
      .update(apps)
      .set({ metadata: { imageTag: "ghcr.io/elizaos/app:latest" } })
      .where(eq(apps.id, input.appId));
    const retry = await appDeploymentsService.createDeployment(input);
    expect(retry.status).toBe("BUILDING");
    expect(retry.deploymentId).not.toBe(first.deploymentId);
  },
  TEST_TIMEOUT,
);

test(
  "a worker that sees an already failed current generation settles it failed",
  async () => {
    const input = await seedApp();
    const deploy = await appDeploymentsService.createDeployment(input);
    await appsService.updateDeploymentGeneration(
      input.appId,
      deploy.deploymentId,
      { deployment_status: "deploying" },
      ["building"],
    );
    await appsService.updateDeploymentGeneration(
      input.appId,
      deploy.deploymentId,
      { deployment_status: "failed" },
      ["deploying"],
    );
    await dbWrite
      .update(jobs)
      .set({ error: "Original deployment error", attempts: 1 })
      .where(eq(jobs.id, deploy.deploymentId));

    await new ProvisioningJobService().processPendingJobs(5, { jobTypes: [JOB_TYPES.APP_DEPLOY] });

    const job = await readJob(deploy.deploymentId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("Original deployment error");
    expect((await appDeploymentsService.getLatestDeployment(input.appId))?.status).toBe("ERROR");
  },
  TEST_TIMEOUT,
);

test(
  "an older queued generation cannot change a newer deployment",
  async () => {
    const input = await seedApp();
    const older = await appDeploymentsService.createDeployment(input);
    await appsService.updateDeploymentGeneration(
      input.appId,
      older.deploymentId,
      { deployment_status: "failed" },
      ["building"],
    );
    const newer = await appDeploymentsService.createDeployment(input);
    await dbWrite
      .update(jobs)
      .set({ scheduled_for: sql`now() + interval '1 minute'` })
      .where(eq(jobs.id, newer.deploymentId));

    await new ProvisioningJobService().processPendingJobs(5, { jobTypes: [JOB_TYPES.APP_DEPLOY] });

    expect((await readJob(older.deploymentId))?.status).toBe("completed");
    expect((await readJob(newer.deploymentId))?.status).toBe("pending");
    expect(await appDeploymentsService.getLatestDeployment(input.appId)).toMatchObject({
      deploymentId: newer.deploymentId,
      status: "BUILDING",
    });
  },
  TEST_TIMEOUT,
);

test(
  "concurrent deploy admission and a lost enqueue response leave one job for the winning generation",
  async () => {
    const input = await seedApp();
    let writes = 0;
    appDeploymentsService.setDeployEnqueuer((payload) =>
      enqueueAppDeploy(
        {
          insertJob: async (job) => {
            const result = await containerJobsWriter.insertJob(job);
            if (++writes === 1) throw new Error("Lost job insert response after commit");
            return result;
          },
        },
        payload,
      ),
    );
    const outcomes = await Promise.allSettled([
      appDeploymentsService.createDeployment(input),
      appDeploymentsService.createDeployment(input),
    ]);
    const [admitted] = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(admitted?.value.status).toBe("BUILDING");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 409 });
    expect(writes).toBe(2);

    const [job, ...duplicates] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.APP_DEPLOY));
    expect(duplicates).toHaveLength(0);
    expect(job).toMatchObject({
      id: admitted?.value.deploymentId,
      status: "pending",
      data: { appId: input.appId, deploymentGeneration: admitted?.value.deploymentId },
    });
  },
  TEST_TIMEOUT,
);
