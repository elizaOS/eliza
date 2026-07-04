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

describe("readAppDeployJobData", () => {
  test("extracts appId", () => {
    expect(readAppDeployJobData({ data: { appId: "app-1" } })).toEqual({ appId: "app-1" });
  });

  test("extracts deploy options", () => {
    expect(
      readAppDeployJobData({
        data: {
          appId: "app-1",
          options: {
            repoUrl: "https://github.com/elizaOS/eliza.git",
            ref: "develop",
            dockerfile: "packages/examples/cloud/edad/Dockerfile",
            env: { ELIZA_APP_ID: "app-1" },
          },
        },
      }),
    ).toEqual({
      appId: "app-1",
      options: {
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "develop",
        dockerfile: "packages/examples/cloud/edad/Dockerfile",
        env: { ELIZA_APP_ID: "app-1" },
      },
    });
  });

  test("throws when appId missing/blank", () => {
    expect(() => readAppDeployJobData({ data: {} })).toThrow(/missing data.appId/);
    expect(() => readAppDeployJobData({ data: { appId: "" } })).toThrow(/missing data.appId/);
  });

  test("throws when deploy options are malformed", () => {
    expect(() =>
      readAppDeployJobData({ data: { appId: "app-1", options: { env: { A: 1 } } } }),
    ).toThrow(/env values must be strings/);
  });
});

describe("app deploy runner injection", () => {
  test("getAppDeployRunner throws before it is wired", () => {
    expect(() => getAppDeployRunner()).toThrow(/not configured/);
  });

  test("dispatchAppDeployJob runs the injected runner with the appId and options", async () => {
    const calls: unknown[] = [];
    setAppDeployRunner({ run: async (id, options) => void calls.push([id, options]) });
    await dispatchAppDeployJob({
      data: {
        appId: "app-42",
        options: { repoUrl: "https://github.com/elizaOS/eliza.git", ref: "develop" },
      },
    });
    expect(calls).toEqual([
      ["app-42", { repoUrl: "https://github.com/elizaOS/eliza.git", ref: "develop" }],
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
      organizationId: "org-1",
      userId: "u-1",
      options: {
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "develop",
      },
    });
    expect(r.id).toBe("job-1");
    expect(inserted[0]).toEqual({
      type: "app_deploy",
      organizationId: "org-1",
      userId: "u-1",
      data: {
        appId: "app-1",
        options: {
          repoUrl: "https://github.com/elizaOS/eliza.git",
          ref: "develop",
        },
      },
    });
  });
});
