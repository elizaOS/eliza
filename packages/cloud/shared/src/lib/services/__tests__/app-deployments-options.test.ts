// Exercises app deployments options behavior with deterministic cloud-shared lib fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const ORG_ID = "org-1";
const USER_ID = "user-1";

type AppRow = {
  id: string;
  name: string;
  organization_id: string;
  created_by_user_id: string;
  github_repo: string | null;
  metadata: Record<string, unknown>;
  deployment_status: "draft" | "building" | "deployed" | "failed";
  production_url: string | null;
  last_deployed_at: Date | null;
};

const baseApp = (): AppRow => ({
  id: APP_ID,
  name: "repo-built app",
  organization_id: ORG_ID,
  created_by_user_id: USER_ID,
  github_repo: null,
  metadata: {},
  deployment_status: "draft",
  production_url: null,
  last_deployed_at: null,
});

let appRow = baseApp();

mock.module("../apps", () => ({
  appsService: {
    getById: async (id: string) => (id === APP_ID ? appRow : undefined),
    update: async (id: string, data: Partial<AppRow>) => {
      if (id !== APP_ID) return undefined;
      appRow = { ...appRow, ...data };
      return appRow;
    },
  },
}));

import { AppDeploymentsService } from "../app-deployments";

describe("AppDeploymentsService deploy options", () => {
  beforeEach(() => {
    appRow = baseApp();
  });

  test("passes repo build options to the Worker APP_DEPLOY enqueuer", async () => {
    const service = new AppDeploymentsService();
    const enqueued: unknown[] = [];
    service.setDeployEnqueuer(async (payload) => void enqueued.push(payload));

    await service.createDeployment({
      appId: APP_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      repoUrl: "https://github.com/elizaOS/eliza.git",
      ref: "develop",
      dockerfile: "packages/examples/cloud/edad/Dockerfile",
      env: { ELIZA_APP_ID: APP_ID },
    });

    expect(enqueued).toEqual([
      {
        appId: APP_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        options: {
          repoUrl: "https://github.com/elizaOS/eliza.git",
          ref: "develop",
          dockerfile: "packages/examples/cloud/edad/Dockerfile",
          env: { ELIZA_APP_ID: APP_ID },
        },
      },
    ]);
  });

  test("passes repo build options to the direct runner", async () => {
    const service = new AppDeploymentsService();
    const calls: unknown[] = [];
    service.setDeployRunner({
      run: async (appId, options) => void calls.push([appId, options]),
    });

    await service.createDeployment({
      appId: APP_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      repoUrl: "https://github.com/elizaOS/eliza.git",
      ref: "develop",
      dockerfile: "packages/examples/cloud/clone-ur-crush/Dockerfile",
    });

    expect(calls).toEqual([
      [
        APP_ID,
        {
          repoUrl: "https://github.com/elizaOS/eliza.git",
          ref: "develop",
          dockerfile: "packages/examples/cloud/clone-ur-crush/Dockerfile",
        },
      ],
    ]);
  });
});
