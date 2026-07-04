/**
 * ROLLBACK_FRONTEND tests covering the pure selectRollbackTarget selector and the action. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AppFrontendDeploymentDto } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setActivateAppFrontend,
  setGetApp,
  setListAppFrontendDeployments,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const {
  rollbackFrontendAction,
  listFrontendDeploymentsAction,
  selectRollbackTarget,
} = await import("../src/actions/rollback-frontend.ts");

const APP = makeApp({ id: "app_1", name: "Acme Bot", slug: "acme-bot" });

function dep(
  version: number,
  status: AppFrontendDeploymentDto["status"],
  id = `d${version}`,
): AppFrontendDeploymentDto {
  return {
    id,
    app_id: "app_1",
    version,
    status,
    r2_prefix: "p",
    content_hash: "h",
    file_count: 1,
    total_bytes: 1,
    error: null,
    created_at: "2020-01-01",
    activated_at: null,
  };
}

describe("selectRollbackTarget (pure)", () => {
  it("picks the newest non-active restorable deployment", () => {
    const deps = [
      dep(3, "active", "d3"),
      dep(2, "superseded", "d2"),
      dep(1, "superseded", "d1"),
    ];
    expect(selectRollbackTarget(deps, "d3")?.version).toBe(2);
  });
  it("honors an explicit version", () => {
    const deps = [
      dep(3, "active", "d3"),
      dep(2, "superseded", "d2"),
      dep(1, "superseded", "d1"),
    ];
    expect(selectRollbackTarget(deps, "d3", 1)?.id).toBe("d1");
  });
  it("returns null when only the active deployment exists", () => {
    expect(selectRollbackTarget([dep(1, "active", "d1")], "d1")).toBeNull();
  });
  it("skips failed deployments", () => {
    const deps = [dep(3, "active", "d3"), dep(2, "failed", "d2")];
    expect(selectRollbackTarget(deps, "d3")).toBeNull();
  });
});

describe("ROLLBACK_FRONTEND", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
    setGetApp(() => Promise.resolve({ success: true, app: APP }));
  });

  it("validate: true with key, false without", async () => {
    expect(
      await rollbackFrontendAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await rollbackFrontendAction.validate(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("activates the previous version", async () => {
    setListAppFrontendDeployments(() =>
      Promise.resolve({
        success: true,
        active_deployment_id: "d3",
        deployments: [dep(3, "active", "d3"), dep(2, "superseded", "d2")],
      }),
    );
    let activated: string | null = null;
    setActivateAppFrontend((_a, id) => {
      activated = id;
      return Promise.resolve({
        success: true,
        deployment: dep(2, "active", "d2"),
      });
    });
    const cb = captureCallback();
    const res = await rollbackFrontendAction.handler(
      keyedRuntime(),
      makeMessage("roll back Acme Bot"),
      undefined,
      { app: "Acme Bot" },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(activated).toBe("d2");
    expect((res.data as { activatedVersion?: number }).activatedVersion).toBe(
      2,
    );
  });

  it("no earlier version → no_target", async () => {
    setListAppFrontendDeployments(() =>
      Promise.resolve({
        success: true,
        active_deployment_id: "d1",
        deployments: [dep(1, "active", "d1")],
      }),
    );
    const cb = captureCallback();
    const res = await rollbackFrontendAction.handler(
      keyedRuntime(),
      makeMessage("roll back Acme Bot"),
      undefined,
      { app: "Acme Bot" },
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_target" });
  });
});

describe("LIST_FRONTEND_DEPLOYMENTS", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
    setGetApp(() => Promise.resolve({ success: true, app: APP }));
  });

  it("marks the live deployment", async () => {
    setListAppFrontendDeployments(() =>
      Promise.resolve({
        success: true,
        active_deployment_id: "d3",
        deployments: [dep(3, "active", "d3"), dep(2, "superseded", "d2")],
      }),
    );
    const cb = captureCallback();
    const res = await listFrontendDeploymentsAction.handler(
      keyedRuntime(),
      makeMessage("Acme Bot frontend versions"),
      undefined,
      { app: "Acme Bot" },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(res.userFacingText).toContain("← live");
    expect(res.userFacingText).toContain("v3");
  });
});
