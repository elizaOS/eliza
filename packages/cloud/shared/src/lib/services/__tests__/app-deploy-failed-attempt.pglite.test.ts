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
import { containersRepository } from "../../../db/repositories/containers";
import { jobsRepository } from "../../../db/repositories/jobs";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../../db/schemas/api-keys";
import { appDeploymentStatusEnum, appReviewStatusEnum, apps } from "../../../db/schemas/apps";
import { containers } from "../../../db/schemas/containers";
import { generations } from "../../../db/schemas/generations";
import { jobExecutionLeases } from "../../../db/schemas/job-execution-leases";
import { jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import { toNewContainer } from "../app-container-record";
import {
  configureAppsDeployTrigger,
  enqueueAppDeploy,
  setAppDeployRunner,
} from "../app-deploy-job-service";
import { DefaultAppDeployRunner } from "../app-deploy-runner";
import { appDeploymentsService } from "../app-deployments";
import { appsService } from "../apps";
import { ContainerJobEnqueuer } from "../container-job-service";
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
    containers,
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

async function seedInterruptedDeployment() {
  const input = await seedApp();
  const deploy = await appDeploymentsService.createDeployment(input);
  const claimed = await appsService.updateDeploymentGeneration(
    input.appId,
    deploy.deploymentId,
    { deployment_status: "deploying" },
    ["building"],
  );
  expect(claimed?.deployment_status).toBe("deploying");
  return { ...input, deploymentGeneration: deploy.deploymentId };
}

async function persistContainerForDeployment(
  deployment: Awaited<ReturnType<typeof seedInterruptedDeployment>>,
) {
  const [row] = await dbWrite
    .insert(containers)
    .values({
      name: `fixture-${crypto.randomUUID()}`,
      project_name: deployment.appId,
      organization_id: deployment.organizationId,
      user_id: deployment.userId,
      metadata: { appId: deployment.appId, deploymentGeneration: deployment.deploymentGeneration },
    })
    .returning({ id: containers.id });
  return row.id;
}

test(
  "an interrupted deploy without an exact child retains an unresolved job and app generation",
  async () => {
    const deployment = await seedInterruptedDeployment();
    const wrongContainer = await persistContainerForDeployment({
      ...deployment,
      deploymentGeneration: crypto.randomUUID(),
    });
    await new ContainerJobEnqueuer(containerJobsWriter).enqueueProvision({
      containerId: wrongContainer,
      organizationId: deployment.organizationId,
      userId: deployment.userId,
      deploymentGeneration: deployment.deploymentGeneration,
    });

    const worker = new ProvisioningJobService();
    await worker.processPendingJobs(5, { jobTypes: [JOB_TYPES.APP_DEPLOY] });
    await worker.processPendingJobs(5, { jobTypes: [JOB_TYPES.APP_DEPLOY] });

    const parent = await readJob(deployment.deploymentGeneration);
    expect(parent?.status).toBe("failed");
    expect(parent?.error).toContain("Provision handoff is unconfirmed");
    expect(parent?.execution_quiesced_at).toBeNull();
    expect(
      await jobsRepository.findUnsettledAppDeletionCandidates(deployment.organizationId),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: parent?.id })]));
    expect((await appDeploymentsService.getLatestDeployment(deployment.appId))?.status).toBe(
      "BUILDING",
    );
    await expect(appDeploymentsService.createDeployment(deployment)).rejects.toThrow(
      "A deployment is already in progress for this app",
    );
    const children = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.CONTAINER_PROVISION));
    expect(children.map((job) => job.data.containerId)).toEqual([wrongContainer]);
  },
  TEST_TIMEOUT,
);

test(
  "a lost child insert response retains the committed child without failing the app",
  async () => {
    const input = await seedApp();
    await dbWrite
      .update(apps)
      .set({
        metadata: { imageTag: `ghcr.io/elizaos/fixture@sha256:${"a".repeat(64)}` },
      })
      .where(eq(apps.id, input.appId));
    const deploy = await appDeploymentsService.createDeployment(input);
    setAppDeployRunner(
      new DefaultAppDeployRunner({
        ensureTenantDb: async () => {
          throw new Error("stateless app cannot provision a tenant database");
        },
        // Use real container persistence and omit unrelated billing quota fixtures.
        createContainerRow: async (row) => {
          const container = await containersRepository.create(toNewContainer(row));
          return { containerId: container.id };
        },
        jobsWriter: {
          async insertJob(job) {
            await containerJobsWriter.insertJob(job);
            await dbWrite
              .update(apps)
              .set({ metadata: sql`${apps.metadata} || '{"fixturePreference":"retained"}'::jsonb` })
              .where(eq(apps.id, input.appId));
            throw new Error("child insert response lost after commit");
          },
        },
      }),
    );

    await new ProvisioningJobService().processPendingJobs(5, { jobTypes: [JOB_TYPES.APP_DEPLOY] });

    const parent = await readJob(deploy.deploymentId);
    expect(parent?.status).toBe("completed");
    expect(parent?.execution_quiesced_at).toBeInstanceOf(Date);
    expect((await appDeploymentsService.getLatestDeployment(input.appId))?.status).toBe("BUILDING");
    const children = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.CONTAINER_PROVISION));
    expect(children).toEqual([
      expect.objectContaining({
        organization_id: input.organizationId,
        user_id: input.userId,
        data: expect.objectContaining({
          containerId: expect.any(String),
          deploymentGeneration: deploy.deploymentId,
        }),
      }),
    ]);
    const linked = await appsService.findByDeploymentGeneration(input.appId, deploy.deploymentId);
    expect(linked?.metadata).toMatchObject({
      containerId: children[0]?.data.containerId,
      deploymentGeneration: deploy.deploymentId,
      fixturePreference: "retained",
    });
  },
  TEST_TIMEOUT,
);

test(
  "an interrupted deploy acknowledges its exact durable child without repeating the handoff",
  async () => {
    const deployment = await seedInterruptedDeployment();
    const containerId = await persistContainerForDeployment(deployment);
    const child = await new ContainerJobEnqueuer(containerJobsWriter).enqueueProvision({
      containerId,
      organizationId: deployment.organizationId,
      userId: deployment.userId,
      deploymentGeneration: deployment.deploymentGeneration,
    });

    await new ProvisioningJobService().processPendingJobs(5, { jobTypes: [JOB_TYPES.APP_DEPLOY] });

    const parent = await readJob(deployment.deploymentGeneration);
    expect(parent?.status).toBe("completed");
    expect(parent?.execution_quiesced_at).toBeInstanceOf(Date);
    expect((await appDeploymentsService.getLatestDeployment(deployment.appId))?.status).toBe(
      "BUILDING",
    );
    const children = await dbWrite
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.CONTAINER_PROVISION));
    expect(children).toEqual([child]);
    const linked = await appsService.findByDeploymentGeneration(
      deployment.appId,
      deployment.deploymentGeneration,
    );
    expect(linked?.metadata.containerId).toBe(containerId);
  },
  TEST_TIMEOUT,
);

test(
  "app deploy handoff recovery preserves the URL published by its ready child",
  async () => {
    const deployment = await seedInterruptedDeployment();
    const containerId = await persistContainerForDeployment(deployment);
    await new ContainerJobEnqueuer(containerJobsWriter).enqueueProvision({
      containerId,
      organizationId: deployment.organizationId,
      userId: deployment.userId,
      deploymentGeneration: deployment.deploymentGeneration,
    });
    const publishedUrl = "https://already-published.example.com";
    await appsService.updateDeploymentGeneration(
      deployment.appId,
      deployment.deploymentGeneration,
      { deployment_status: "deployed", production_url: publishedUrl },
      ["deploying"],
    );

    const previousDomain = process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
    process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = "different.example.com";
    try {
      await new ProvisioningJobService().processPendingJobs(5, {
        jobTypes: [JOB_TYPES.APP_DEPLOY],
      });
    } finally {
      if (previousDomain === undefined) delete process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
      else process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = previousDomain;
    }

    const linked = await appsService.findByDeploymentGeneration(
      deployment.appId,
      deployment.deploymentGeneration,
    );
    expect(linked?.metadata.containerId).toBe(containerId);
    expect((await readJob(deployment.deploymentGeneration))?.status).toBe("completed");
    expect(await appDeploymentsService.getLatestDeployment(deployment.appId)).toMatchObject({
      status: "READY",
      vercelUrl: publishedUrl,
    });
  },
  TEST_TIMEOUT,
);

test(
  "an exhausted deploy lease keeps an unconfirmed app generation in the deletion inventory",
  async () => {
    const deployment = await seedInterruptedDeployment();
    const [claimed] = await jobsRepository.claimPendingJobs({
      type: JOB_TYPES.APP_DEPLOY,
      limit: 1,
      executionOwnerId: crypto.randomUUID(),
    });
    const expired = new Date(Date.now() - 86_400_000);
    await dbWrite
      .update(jobs)
      .set({ attempts: 2, started_at: expired })
      .where(eq(jobs.id, claimed.id));
    await dbWrite
      .update(jobExecutionLeases)
      .set({ expires_at: expired })
      .where(eq(jobExecutionLeases.job_id, claimed.id));

    await new ProvisioningJobService().processPendingJobs(5, { jobTypes: [JOB_TYPES.APP_DEPLOY] });

    const parent = await readJob(deployment.deploymentGeneration);
    expect(parent?.status).toBe("failed");
    expect(parent?.execution_quiesced_at).toBeNull();
    expect((await appDeploymentsService.getLatestDeployment(deployment.appId))?.status).toBe(
      "BUILDING",
    );
    expect(
      await jobsRepository.findUnsettledAppDeletionCandidates(deployment.organizationId),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: parent?.id })]));
  },
  TEST_TIMEOUT,
);

test(
  "an app deletion claim does not hide its interrupted deployment from recovery",
  async () => {
    const deployment = await seedInterruptedDeployment();
    const deletion = await jobsRepository.create({
      type: JOB_TYPES.APP_DELETE,
      organization_id: deployment.organizationId,
      data: { appId: deployment.appId },
    });
    await dbWrite
      .update(apps)
      .set({ deletion_job_id: deletion.id })
      .where(eq(apps.id, deployment.appId));
    try {
      await new ProvisioningJobService().processPendingJobs(5, {
        jobTypes: [JOB_TYPES.APP_DEPLOY],
      });
      const parent = await readJob(deployment.deploymentGeneration);
      expect(parent?.status).toBe("failed");
      expect(parent?.execution_quiesced_at).toBeNull();
      expect(parent?.error).toContain("Provision handoff is unconfirmed");
      expect(
        await jobsRepository.findUnsettledAppDeletionCandidates(deployment.organizationId),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ id: parent?.id })]));
    } finally {
      await dbWrite
        .update(apps)
        .set({ deletion_job_id: null })
        .where(eq(apps.id, deployment.appId));
    }
  },
  TEST_TIMEOUT,
);

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
