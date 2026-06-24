/**
 * Bug 1 (apps deploy/redeploy lifecycle) — a redeploy must RETIRE the app's
 * pre-existing container row(s) so stale rows from prior deploys stop counting
 * against the per-org container quota.
 *
 * Root cause: every deploy creates a NEW `containers` row under the same project
 * key (project_name = appId) and never retired the prior row. The quota readers
 * (`checkQuota` / `createWithQuotaCheck`) count every row EXCEPT `deleting`/
 * `deleted`, so a prior `running`/`stopped`/`failed` row kept consuming a quota
 * slot forever. The fix flips each prior row to `deleting` (a non-counting state)
 * before the new row is created, and enqueues a CONTAINER_DELETE so the daemon
 * removes the old container + releases its node slot. Net effect: at most one
 * active (quota-counting) row per app.
 *
 * This test wires the real `DefaultAppDeployRunner.run()` against an in-memory
 * `containers` store, simulates a prior `running` deploy, redeploys, and asserts
 * the prior row was flipped to `deleting`, a CONTAINER_DELETE was enqueued for
 * it, and the count of quota-counting rows for the app stays ≤ 1.
 */

import { describe, expect, mock, test } from "bun:test";

const APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ORG_ID = "org-retire";
const USER_ID = "user-retire";

// A minimal in-memory `containers` store keyed by id. Only the columns the
// runner's retire step + the default createContainerRow touch are modeled.
interface Row {
  id: string;
  organization_id: string;
  project_name: string;
  status: string;
}
const rows = new Map<string, Row>();

// The set of statuses the quota readers EXCLUDE — a row in any other status
// counts toward the org cap. Mirrors `notInArray(status, ["deleting","deleted"])`.
const NON_COUNTING = new Set(["deleting", "deleted"]);
function quotaCountForApp(appId: string): number {
  let n = 0;
  for (const row of rows.values()) {
    if (row.project_name === appId && !NON_COUNTING.has(row.status)) n += 1;
  }
  return n;
}

mock.module("../../../db/repositories/containers", () => ({
  containersRepository: {
    // Mirrors the real reader: every row for (org, project_name) NOT already
    // terminal (deleting/deleted).
    findUndeletedByProjectName: async (organizationId: string, projectName: string) =>
      [...rows.values()].filter(
        (r) =>
          r.organization_id === organizationId &&
          r.project_name === projectName &&
          !NON_COUNTING.has(r.status),
      ),
    updateStatus: async (id: string, status: string) => {
      const row = rows.get(id);
      if (row) row.status = status;
      return row ?? null;
    },
    // The default createContainerRow path; inserts a fresh `pending` row.
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
            // "none" => stateless app, so ensureTenantDb is never called.
            metadata: { databaseMode: "none" },
          }
        : undefined,
    update: async () => {},
  },
}));

import { DefaultAppDeployRunner } from "../app-deploy-runner";
import type { ContainerJobInsert, ContainerJobsWriter } from "../container-job-service";
import { JOB_TYPES } from "../provisioning-job-types";

describe("DefaultAppDeployRunner — redeploy retires the prior container row (Bug 1)", () => {
  test("a redeploy flips the prior row to deleting, enqueues its delete, and keeps quota ≤1", async () => {
    rows.clear();
    // Simulate a prior deploy: one live `running` row for this app.
    rows.set("container-prior", {
      id: "container-prior",
      organization_id: ORG_ID,
      project_name: APP_ID,
      status: "running",
    });
    expect(quotaCountForApp(APP_ID)).toBe(1); // baseline: prior deploy counts

    const enqueued: ContainerJobInsert[] = [];
    const jobsWriter: ContainerJobsWriter = {
      async insertJob(job) {
        enqueued.push(job);
        return { id: `job-${enqueued.length}` };
      },
    };

    const runner = new DefaultAppDeployRunner({
      ensureTenantDb: async () => {
        throw new Error("ensureTenantDb must NOT be called for a stateless app");
      },
      jobsWriter,
      resolveImage: () => "ghcr.io/elizaos/app:test",
    });

    await runner.run(APP_ID);

    // The prior row was retired to `deleting` (a non-quota-counting state).
    expect(rows.get("container-prior")?.status).toBe("deleting");

    // A CONTAINER_DELETE was enqueued for the prior container so the daemon
    // removes it + releases its node slot.
    const deleteJob = enqueued.find(
      (j) =>
        j.type === JOB_TYPES.CONTAINER_DELETE &&
        (j.data as { containerId?: string }).containerId === "container-prior",
    );
    expect(deleteJob).toBeDefined();
    expect(deleteJob?.organizationId).toBe(ORG_ID);

    // A fresh row exists for the new deploy, AND the quota-counting rows for the
    // app stay ≤ 1 (the retired row no longer counts) — no leak across redeploys.
    expect([...rows.values()].some((r) => r.status === "pending")).toBe(true);
    expect(quotaCountForApp(APP_ID)).toBeLessThanOrEqual(1);
  });
});
