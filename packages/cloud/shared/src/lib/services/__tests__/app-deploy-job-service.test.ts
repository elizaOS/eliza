// Exercises app deploy job service behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  dispatchAppDeployJob,
  enqueueAppDeploy,
  getAppDeployRunner,
  readAppDeployJobData,
  setAppDeployRunner,
} from "../app-deploy-job-service";
import type { ContainerJobInsert, ContainerJobsWriter } from "../container-job-service";

const GENERATION = "11111111-1111-4111-8111-111111111111";

describe("readAppDeployJobData", () => {
  test("extracts appId", () => {
    expect(
      readAppDeployJobData({ data: { appId: "app-1", deploymentGeneration: GENERATION } }),
    ).toEqual({ appId: "app-1", deploymentGeneration: GENERATION });
  });

  test("extracts deploy options", () => {
    expect(
      readAppDeployJobData({
        data: {
          appId: "app-1",
          deploymentGeneration: GENERATION,
          options: {
            repoUrl: "https://github.com/elizaOS/eliza.git",
            ref: "develop",
            dockerfile: "apps/example/Dockerfile",
            env: { ELIZA_APP_ID: "app-1" },
          },
        },
      }),
    ).toEqual({
      appId: "app-1",
      deploymentGeneration: GENERATION,
      options: {
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "develop",
        dockerfile: "apps/example/Dockerfile",
        env: { ELIZA_APP_ID: "app-1" },
      },
    });
  });

  test("throws when appId missing/blank", () => {
    expect(() => readAppDeployJobData({ data: {} })).toThrow(/missing data.appId/);
    expect(() => readAppDeployJobData({ data: { appId: "" } })).toThrow(/missing data.appId/);
    expect(() => readAppDeployJobData({ data: { appId: "app-1" } })).toThrow(
      /deploymentGeneration/,
    );
  });

  test("throws when deploy options are malformed", () => {
    expect(() =>
      readAppDeployJobData({
        data: { appId: "app-1", deploymentGeneration: GENERATION, options: { env: { A: 1 } } },
      }),
    ).toThrow(/env values must be strings/);
  });
});

describe("app deploy runner injection", () => {
  test("getAppDeployRunner throws before it is wired", () => {
    expect(() => getAppDeployRunner()).toThrow(/not configured/);
  });

  test("dispatchAppDeployJob runs the injected runner with the appId and options", async () => {
    const calls: unknown[] = [];
    setAppDeployRunner({
      run: async (id, generation, options) => void calls.push([id, generation, options]),
    });
    await dispatchAppDeployJob({
      data: {
        appId: "app-42",
        deploymentGeneration: GENERATION,
        options: { repoUrl: "https://github.com/elizaOS/eliza.git", ref: "develop" },
      },
    });
    expect(calls).toEqual([
      ["app-42", GENERATION, { repoUrl: "https://github.com/elizaOS/eliza.git", ref: "develop" }],
    ]);
  });
});

describe("enqueueAppDeploy", () => {
  test("inserts an APP_DEPLOY job carrying the appId (pg-free writer)", async () => {
    const inserted: ContainerJobInsert[] = [];
    const writer: ContainerJobsWriter = {
      insertJob: async (j) => {
        inserted.push(j);
        return { id: "job-1" };
      },
    };
    const r = await enqueueAppDeploy(writer, {
      appId: "app-1",
      deploymentGeneration: GENERATION,
      organizationId: "org-1",
      userId: "u-1",
      options: {
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "develop",
      },
    });
    expect(r.id).toBe("job-1");
    expect(inserted[0]).toEqual({
      id: GENERATION,
      type: "app_deploy",
      organizationId: "org-1",
      userId: "u-1",
      data: {
        appId: "app-1",
        deploymentGeneration: GENERATION,
        options: {
          repoUrl: "https://github.com/elizaOS/eliza.git",
          ref: "develop",
        },
      },
    });
  });

  test("reconstructs a committed insert after the caller loses its response", async () => {
    const inserted = new Map<string, ContainerJobInsert>();
    let calls = 0;
    const writer: ContainerJobsWriter = {
      insertJob: async (job) => {
        calls += 1;
        if (!job.id) throw new Error("missing deterministic id");
        const existing = inserted.get(job.id);
        if (existing) return { id: job.id };
        inserted.set(job.id, job);
        throw new Error("response lost after commit");
      },
    };

    await expect(
      enqueueAppDeploy(writer, {
        appId: "app-1",
        deploymentGeneration: GENERATION,
        organizationId: "org-1",
        userId: "u-1",
      }),
    ).resolves.toEqual({ id: GENERATION });
    expect(calls).toBe(2);
    expect(inserted.size).toBe(1);
  });
});
