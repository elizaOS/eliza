/**
 * App-delete container teardown (Blocker #7).
 *
 * On app delete the deployed container was orphaned: never stopped, never
 * removed, and STILL metered by the daily container-billing cron — a perpetual
 * overcharge to the org. `stopAppContainers` closes that leak by (1) marking the
 * row stopped/suspended so the cron stops metering immediately and (2) enqueuing
 * a CONTAINER_DELETE job for the daemon to do the real `docker stop`/remove. It
 * must be a clean no-op when the app never deployed a container.
 */

import { describe, expect, test } from "bun:test";
import {
  type AppContainerTeardownDeps,
  stopAppContainers,
  type TeardownApp,
  type TeardownContainer,
} from "../app-container-teardown";
import type { ContainerJobInsert } from "../container-job-service";
import { JOB_TYPES } from "../provisioning-job-types";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const APP_ID = "22222222-2222-2222-2222-222222222222";

function fakeApp(): TeardownApp {
  return { id: APP_ID, organization_id: ORG_ID };
}

function fakeContainer(id = "container-1"): TeardownContainer {
  return { id };
}

/** Records every interaction so assertions can prove the leak is closed. */
function recordingDeps(containers: TeardownContainer[]): {
  deps: AppContainerTeardownDeps;
  marked: Array<{ containerId: string; organizationId: string }>;
  jobs: ContainerJobInsert[];
} {
  const marked: Array<{ containerId: string; organizationId: string }> = [];
  const jobs: ContainerJobInsert[] = [];
  const deps: AppContainerTeardownDeps = {
    async findContainers(organizationId, appId) {
      expect(organizationId).toBe(ORG_ID);
      expect(appId).toBe(APP_ID);
      return containers;
    },
    async markStoppedForBilling(containerId, organizationId) {
      marked.push({ containerId, organizationId });
    },
    jobsWriter: {
      async insertJob(job) {
        jobs.push(job);
        return { id: `job-${jobs.length}` };
      },
    },
  };
  return { deps, marked, jobs };
}

describe("stopAppContainers — app-delete container teardown (Blocker #7)", () => {
  test("stops metering AND enqueues CONTAINER_DELETE for an app with a container", async () => {
    const { deps, marked, jobs } = recordingDeps([fakeContainer()]);

    const result = await stopAppContainers(fakeApp(), deps);

    expect(result.errors).toEqual([]);
    expect(result.tornDown).toBe(1);

    // (1) Billing cron stops metering immediately (status=stopped/suspended).
    expect(marked).toEqual([{ containerId: "container-1", organizationId: ORG_ID }]);

    // (2) Daemon-side stop + remove is enqueued (mirrors the suspend path).
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe(JOB_TYPES.CONTAINER_DELETE);
    expect(jobs[0].organizationId).toBe(ORG_ID);
    expect(jobs[0].data).toMatchObject({ containerId: "container-1", organizationId: ORG_ID });
  });

  test("tears down every undeleted container row for the app", async () => {
    const { deps, marked, jobs } = recordingDeps([
      fakeContainer("container-1"),
      fakeContainer("container-2"),
    ]);

    const result = await stopAppContainers(fakeApp(), deps);

    expect(result.tornDown).toBe(2);
    expect(marked.map((m) => m.containerId)).toEqual(["container-1", "container-2"]);
    expect(jobs.map((j) => j.data.containerId)).toEqual(["container-1", "container-2"]);
    expect(jobs.every((j) => j.type === JOB_TYPES.CONTAINER_DELETE)).toBe(true);
  });

  test("is a clean no-op when the app never deployed a container", async () => {
    const { deps, marked, jobs } = recordingDeps([]);

    const result = await stopAppContainers(fakeApp(), deps);

    expect(result.errors).toEqual([]);
    expect(result.tornDown).toBe(0);
    expect(marked).toEqual([]);
    expect(jobs).toEqual([]);
  });

  test("collects a per-container error without aborting the others", async () => {
    const failing: AppContainerTeardownDeps = {
      async findContainers() {
        return [fakeContainer("bad"), fakeContainer("good")];
      },
      async markStoppedForBilling(containerId) {
        if (containerId === "bad") throw new Error("db down");
      },
      jobsWriter: {
        async insertJob() {
          return { id: "job" };
        },
      },
    };

    const result = await stopAppContainers(fakeApp(), failing);

    expect(result.tornDown).toBe(1); // "good" still torn down
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bad");
  });
});
