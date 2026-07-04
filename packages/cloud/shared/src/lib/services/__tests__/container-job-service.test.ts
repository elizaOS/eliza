// Exercises container job service behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import type { AppContainerProvider } from "../app-container-provider";
import type {
  AppContainerRow,
  AppContainerStore,
  ContainerExecutorDeps,
} from "../container-job-executors";
import {
  ContainerJobEnqueuer,
  type ContainerJobInsert,
  type ContainerJobsWriter,
  dispatchContainerJob,
  getContainerExecutorDeps,
  isContainerJobType,
  setContainerExecutorDeps,
} from "../container-job-service";
import { JOB_TYPES } from "../provisioning-job-types";

const ROW: AppContainerRow = {
  id: "container-1",
  appId: "11111111-2222-3333-4444-555555555555",
  containerName: "app-nubilio",
  image: "ghcr.io/nubs/nubilio:latest",
  port: 3000,
  organizationId: "org-1",
  userId: "user-1",
};

function fakeDeps() {
  const calls: string[] = [];
  const store: AppContainerStore = {
    async getById() {
      return ROW;
    },
    async markRunning() {},
    async markDeleted() {
      calls.push("markDeleted");
    },
    async markError() {},
  };
  const provider = {
    async provision() {
      calls.push("provision");
      return { containerId: "c", hostPort: 1, network: "n" };
    },
    async delete() {
      calls.push("delete");
    },
    async restart() {
      calls.push("restart");
    },
    async logs() {
      calls.push("logs");
      return "out";
    },
  } as unknown as AppContainerProvider;
  return { calls, deps: { provider, store } satisfies ContainerExecutorDeps };
}

describe("isContainerJobType", () => {
  test("recognizes only the CONTAINER_* types", () => {
    expect(isContainerJobType(JOB_TYPES.CONTAINER_PROVISION)).toBe(true);
    expect(isContainerJobType(JOB_TYPES.CONTAINER_LOGS)).toBe(true);
    expect(isContainerJobType(JOB_TYPES.AGENT_PROVISION)).toBe(false);
    expect(isContainerJobType("nonsense")).toBe(false);
  });
});

describe("dispatchContainerJob", () => {
  const cases: Array<[string, string]> = [
    [JOB_TYPES.CONTAINER_PROVISION, "provision"],
    [JOB_TYPES.CONTAINER_DELETE, "delete"],
    [JOB_TYPES.CONTAINER_RESTART, "restart"],
    [JOB_TYPES.CONTAINER_UPGRADE, "provision"],
    [JOB_TYPES.CONTAINER_LOGS, "logs"],
  ];
  for (const [type, expected] of cases) {
    test(`routes ${type} to ${expected}`, async () => {
      const { calls, deps } = fakeDeps();
      await dispatchContainerJob(
        {
          id: "j",
          type,
          data: { containerId: "container-1", organizationId: "org-1", userId: "user-1" },
        },
        deps,
      );
      expect(calls).toContain(expected);
    });
  }

  test("throws on a non-container job type", async () => {
    const { deps } = fakeDeps();
    await expect(
      dispatchContainerJob({ id: "j", type: JOB_TYPES.AGENT_PROVISION, data: {} }, deps),
    ).rejects.toThrow("Not a container job type");
  });
});

describe("getContainerExecutorDeps / setContainerExecutorDeps", () => {
  test("throws until the backend is wired, then returns it", () => {
    expect(() => getContainerExecutorDeps()).toThrow("not configured");
    const { deps } = fakeDeps();
    setContainerExecutorDeps(() => deps);
    expect(getContainerExecutorDeps()).toBe(deps);
  });
});

describe("ContainerJobEnqueuer", () => {
  function fakeWriter() {
    const inserts: ContainerJobInsert[] = [];
    const writer: ContainerJobsWriter = {
      async insertJob(job) {
        inserts.push(job);
        return { id: `job-${inserts.length}` };
      },
    };
    return { inserts, writer };
  }

  test("enqueues each lifecycle verb with the right type + data", async () => {
    const { inserts, writer } = fakeWriter();
    const e = new ContainerJobEnqueuer(writer);
    await e.enqueueProvision({ containerId: "c1", organizationId: "o1", userId: "u1" });
    await e.enqueueDelete({ containerId: "c1", organizationId: "o1" });
    await e.enqueueUpgrade({ containerId: "c1", organizationId: "o1", image: "ghcr.io/x:2" });

    expect(inserts.map((i) => i.type)).toEqual([
      JOB_TYPES.CONTAINER_PROVISION,
      JOB_TYPES.CONTAINER_DELETE,
      JOB_TYPES.CONTAINER_UPGRADE,
    ]);
    expect(inserts[0].data).toMatchObject({ containerId: "c1", userId: "u1" });
    expect(inserts[2].data).toMatchObject({ image: "ghcr.io/x:2" });
  });
});
