import { afterAll, beforeAll, expect, test } from "bun:test";

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
import { configureAppsDeployTrigger, setAppDeployRunner } from "../app-deploy-job-service";
import { DefaultAppDeployRunner } from "../app-deploy-runner";
import { appDeploymentsService } from "../app-deployments";
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

test(
  "a deploy attempt that fails after the runner claims it leaves the app redeployable",
  async () => {
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

    configureAppsDeployTrigger();
    setAppDeployRunner(
      new DefaultAppDeployRunner({
        ensureTenantDb: async () => {
          throw new Error("tenant DB must not be reached without an image");
        },
        jobsWriter: containerJobsWriter,
      }),
    );

    const first = await appDeploymentsService.createDeployment({
      appId: app.id,
      organizationId: organization.id,
      userId: user.id,
    });
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
      .where(eq(apps.id, app.id));
    expect(afterFailure.status).toBe("failed");
    expect((await appDeploymentsService.getLatestDeployment(app.id))?.status).toBe("ERROR");

    await dbWrite
      .update(apps)
      .set({ metadata: { imageTag: "ghcr.io/elizaos/app:latest" } })
      .where(eq(apps.id, app.id));
    const retry = await appDeploymentsService.createDeployment({
      appId: app.id,
      organizationId: organization.id,
      userId: user.id,
    });
    expect(retry.status).toBe("BUILDING");
  },
  TEST_TIMEOUT,
);
