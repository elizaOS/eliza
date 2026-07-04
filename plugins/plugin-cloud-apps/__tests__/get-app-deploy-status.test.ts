/**
 * GET_APP_DEPLOY_STATUS tests covering the pure formatDeployStatus mapping and the action. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AppDeployStatusResponse } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setGetAppDeployStatus,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { getAppDeployStatusAction, formatDeployStatus } = await import(
  "../src/actions/get-app-deploy-status.ts"
);

const APP = makeApp({
  id: "id-acme",
  name: "Acme Bot",
  slug: "acme-bot",
  production_url: "https://acme.elizacloud.ai",
});

function status(
  overrides: Partial<AppDeployStatusResponse>,
): AppDeployStatusResponse {
  return {
    success: true,
    deploymentId: "dep_1",
    status: "DRAFT",
    vercelUrl: null,
    error: null,
    startedAt: null,
    ...overrides,
  };
}

describe("formatDeployStatus", () => {
  it("formats each public lifecycle status", () => {
    expect(formatDeployStatus(APP, status({ status: "DRAFT" }))).toContain(
      "hasn't been deployed",
    );
    expect(formatDeployStatus(APP, status({ status: "BUILDING" }))).toContain(
      "building",
    );
    expect(formatDeployStatus(APP, status({ status: "DEPLOYING" }))).toContain(
      "building",
    );
    expect(
      formatDeployStatus(
        APP,
        status({ status: "READY", vercelUrl: "https://acme.elizacloud.ai" }),
      ),
    ).toContain("live at https://acme.elizacloud.ai");
    expect(
      formatDeployStatus(APP, status({ status: "ERROR", error: "oom" })),
    ).toContain("failed: oom");
  });

  it("falls back to the app production_url for READY when status has none", () => {
    expect(formatDeployStatus(APP, status({ status: "READY" }))).toContain(
      "https://acme.elizacloud.ai",
    );
  });
});

describe("GET_APP_DEPLOY_STATUS", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(
      await getAppDeployStatusAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await getAppDeployStatusAction.validate(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("resolves the app and reports its live status", async () => {
    setGetAppDeployStatus(() =>
      status({ status: "READY", vercelUrl: "https://acme.elizacloud.ai" }),
    );
    const cb = captureCallback();
    const result = await getAppDeployStatusAction.handler(
      keyedRuntime(),
      makeMessage("is my Acme Bot app live?"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(true);
    expect((result?.data as { status: string }).status).toBe("READY");
    expect(cb.calls[0]?.text).toContain("live at https://acme.elizacloud.ai");
  });

  it("reports a building app", async () => {
    setGetAppDeployStatus(() => status({ status: "BUILDING" }));
    const cb = captureCallback();
    const result = await getAppDeployStatusAction.handler(
      keyedRuntime(),
      makeMessage("Acme Bot deploy status"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(true);
    expect(cb.calls[0]?.text).toContain("building");
  });

  it("degrades gracefully with no Cloud API key", async () => {
    const cb = captureCallback();
    const result = await getAppDeployStatusAction.handler(
      unkeyedRuntime(),
      makeMessage("is Acme live?"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  it("returns not-found for an unknown app", async () => {
    const cb = captureCallback();
    const result = await getAppDeployStatusAction.handler(
      keyedRuntime(),
      makeMessage("is Zephyr live?"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("not_found");
  });
});
