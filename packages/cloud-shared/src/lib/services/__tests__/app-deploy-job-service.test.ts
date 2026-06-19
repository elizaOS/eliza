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
  test("throws when appId missing/blank", () => {
    expect(() => readAppDeployJobData({ data: {} })).toThrow(/missing data.appId/);
    expect(() => readAppDeployJobData({ data: { appId: "" } })).toThrow(/missing data.appId/);
  });
});

describe("app deploy runner injection", () => {
  test("getAppDeployRunner throws before it is wired", () => {
    expect(() => getAppDeployRunner()).toThrow(/not configured/);
  });

  test("dispatchAppDeployJob runs the injected runner with the appId", async () => {
    const calls: string[] = [];
    setAppDeployRunner({ run: async (id) => void calls.push(id) });
    await dispatchAppDeployJob({ data: { appId: "app-42" } });
    expect(calls).toEqual(["app-42"]);
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
    });
    expect(r.id).toBe("job-1");
    expect(inserted[0]).toEqual({
      type: "app_deploy",
      organizationId: "org-1",
      userId: "u-1",
      data: { appId: "app-1" },
    });
  });
});
