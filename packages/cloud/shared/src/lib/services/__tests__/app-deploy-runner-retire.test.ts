/**
 * Exercises redeploy retirement through an atomic persistence seam, including
 * ambiguous post-commit failures and a worker transition racing the response.
 */

import { describe, expect, mock, test } from "bun:test";

const APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ORG_ID = "org-retire";
const USER_ID = "user-retire";

interface Row {
  id: string;
  organization_id: string;
  project_name: string;
  status: string;
}

const rows = new Map<string, Row>();
const NON_COUNTING = new Set(["deleting", "deleted"]);

function quotaCountForApp(appId: string): number {
  return [...rows.values()].filter(
    (row) => row.project_name === appId && !NON_COUNTING.has(row.status),
  ).length;
}

mock.module("../../../db/repositories/containers", () => ({
  containersRepository: {
    findUndeletedByProjectName: async (organizationId: string, projectName: string) =>
      [...rows.values()].filter(
        (row) =>
          row.organization_id === organizationId &&
          row.project_name === projectName &&
          !NON_COUNTING.has(row.status),
      ),
    createWithQuotaCheck: async () => {
      const id = `container-new-${rows.size + 1}`;
      rows.set(id, {
        id,
        organization_id: ORG_ID,
        project_name: APP_ID,
        status: "pending",
      });
      return { id };
    },
  },
}));

mock.module("../apps", () => ({
  appsService: {
    getById: async (id: string) =>
      id === APP_ID
        ? {
            id: APP_ID,
            name: "retire-app",
            organization_id: ORG_ID,
            created_by_user_id: USER_ID,
            github_repo: null,
            metadata: { databaseMode: "none" },
          }
        : undefined,
    update: async () => {},
  },
}));

import { DefaultAppDeployRunner } from "../app-deploy-runner";
import type { ContainerJobsWriter } from "../container-job-service";
import type { ContainerRetirementResult } from "../container-retirement";
import { JOB_TYPES } from "../provisioning-job-types";

function seedPrior(status = "running"): void {
  rows.clear();
  rows.set("container-prior", {
    id: "container-prior",
    organization_id: ORG_ID,
    project_name: APP_ID,
    status,
  });
}

function setRowStatus(containerId: string, status: string): void {
  const row = rows.get(containerId);
  if (!row) throw new Error(`Missing test container ${containerId}`);
  row.status = status;
}

function makeRunner(
  retireContainer: (
    containerId: string,
    organizationId: string,
  ) => Promise<ContainerRetirementResult>,
): { runner: DefaultAppDeployRunner; provisionJobs: string[] } {
  const provisionJobs: string[] = [];
  const jobsWriter: ContainerJobsWriter = {
    async insertJob(job) {
      if (job.type === JOB_TYPES.CONTAINER_PROVISION) provisionJobs.push(job.type);
      return { id: `job-${provisionJobs.length}` };
    },
  };
  return {
    runner: new DefaultAppDeployRunner({
      ensureTenantDb: async () => {
        throw new Error("ensureTenantDb must not run for a stateless app");
      },
      jobsWriter,
      retireContainer,
      resolveImage: () => "ghcr.io/elizaos/app:test",
    }),
    provisionJobs,
  };
}

describe("DefaultAppDeployRunner prior-container retirement", () => {
  test("retires the prior row before creating the replacement", async () => {
    seedPrior();
    const deleteJobs: string[] = [];
    const { runner } = makeRunner(async (containerId) => {
      setRowStatus(containerId, "deleting");
      deleteJobs.push(containerId);
      return { containerId, jobId: "delete-1", outcome: "retired" };
    });

    await runner.run(APP_ID);

    expect(rows.get("container-prior")?.status).toBe("deleting");
    expect(deleteJobs).toEqual(["container-prior"]);
    expect([...rows.values()].some((row) => row.status === "pending")).toBe(true);
    expect(quotaCountForApp(APP_ID)).toBeLessThanOrEqual(1);
  });

  test("a pre-commit retirement failure leaves the prior row untouched", async () => {
    seedPrior();
    const { runner, provisionJobs } = makeRunner(async () => {
      throw new Error("transaction rolled back");
    });

    await runner.run(APP_ID);

    expect(rows.get("container-prior")?.status).toBe("running");
    expect(provisionJobs).toEqual([JOB_TYPES.CONTAINER_PROVISION]);
  });

  test("a commit-then-throw response never compensates a durable retirement", async () => {
    seedPrior();
    const durableDeleteJobs: string[] = [];
    const { runner } = makeRunner(async (containerId) => {
      setRowStatus(containerId, "deleting");
      durableDeleteJobs.push(containerId);
      throw new Error("connection lost after commit");
    });

    await runner.run(APP_ID);

    expect(rows.get("container-prior")?.status).toBe("deleting");
    expect(durableDeleteJobs).toEqual(["container-prior"]);
  });

  test("an ambiguous response cannot overwrite a terminal worker transition", async () => {
    seedPrior();
    const { runner } = makeRunner(async (containerId) => {
      setRowStatus(containerId, "deleting");
      setRowStatus(containerId, "deleted");
      throw new Error("response lost after worker completion");
    });

    await runner.run(APP_ID);

    expect(rows.get("container-prior")?.status).toBe("deleted");
  });
});
