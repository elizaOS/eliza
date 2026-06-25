import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppDeploymentStatus } from "../app-deployments-helpers";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface AppRow {
  id: string;
  github_repo: string | null;
  metadata: Record<string, unknown>;
  deployment_status: AppDeploymentStatus;
  production_url: string | null;
  last_deployed_at: Date | null;
}

const appStore: { current: AppRow | undefined } = { current: undefined };
const updates: Array<Partial<AppRow>> = [];

mock.module("../apps", () => ({
  appsService: {
    getById: async (id: string) => (id === APP_ID ? appStore.current : undefined),
    update: async (id: string, data: Partial<AppRow>) => {
      if (id !== APP_ID || !appStore.current) return undefined;
      updates.push(data);
      appStore.current = { ...appStore.current, ...data };
      return appStore.current;
    },
  },
}));

import { AppDeploymentsService } from "../app-deployments";

describe("AppDeploymentsService", () => {
  beforeEach(() => {
    updates.length = 0;
    appStore.current = {
      id: APP_ID,
      github_repo: null,
      metadata: { databaseMode: "none" },
      deployment_status: "draft",
      production_url: null,
      last_deployed_at: null,
    };
  });

  test("persists deploy-body build hints before enqueueing APP_DEPLOY", async () => {
    const service = new AppDeploymentsService();
    let enqueued: { appId: string; organizationId: string; userId: string } | undefined;
    service.setDeployEnqueuer(async (payload) => {
      enqueued = payload;
    });

    const record = await service.createDeployment({
      appId: APP_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      repoUrl: "https://github.com/elizaOS/eliza.git",
      ref: "develop",
      dockerfile: "packages/examples/cloud/clone-ur-crush/Dockerfile",
    });

    expect(record.status).toBe("BUILDING");
    expect(enqueued).toEqual({ appId: APP_ID, organizationId: ORG_ID, userId: USER_ID });
    expect(updates[0]).toMatchObject({
      deployment_status: "building",
      metadata: {
        databaseMode: "none",
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "develop",
        dockerfile: "packages/examples/cloud/clone-ur-crush/Dockerfile",
      },
    });
    expect(appStore.current?.metadata.repoUrl).toBe("https://github.com/elizaOS/eliza.git");
  });
});
