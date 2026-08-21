// Exercises app deployments behavior with deterministic cloud-shared lib fixtures.
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
  last_deployed_at: Date | string | null;
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
    claimDeploymentStart: async (id: string, generation: string, data: Partial<AppRow>) => {
      if (
        id !== APP_ID ||
        !appStore.current ||
        appStore.current.deployment_status === "building" ||
        appStore.current.deployment_status === "deploying"
      ) {
        return undefined;
      }
      const update = {
        ...data,
        metadata: { ...(data.metadata ?? {}), deploymentGeneration: generation },
        deployment_status: "building" as const,
      };
      updates.push(update);
      appStore.current = { ...appStore.current, ...update };
      return appStore.current;
    },
    updateDeploymentGeneration: async (
      id: string,
      generation: string,
      data: Partial<AppRow>,
      expectedStatuses?: AppDeploymentStatus[],
    ) => {
      if (
        id !== APP_ID ||
        !appStore.current ||
        appStore.current.metadata.deploymentGeneration !== generation ||
        (expectedStatuses && !expectedStatuses.includes(appStore.current.deployment_status))
      ) {
        return undefined;
      }
      updates.push(data);
      appStore.current = { ...appStore.current, ...data };
      return appStore.current;
    },
  },
}));

import {
  AppDeployEnqueueAmbiguousError,
  type AppDeployEnqueuer,
  AppDeploymentsService,
} from "../app-deployments";

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
    let enqueued: Parameters<AppDeployEnqueuer>[0] | undefined;
    service.setDeployEnqueuer(async (payload) => {
      enqueued = payload;
    });

    const record = await service.createDeployment({
      appId: APP_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      repoUrl: "https://github.com/elizaOS/eliza.git",
      ref: "develop",
      dockerfile: "apps/example/Dockerfile",
    });

    expect(record.status).toBe("BUILDING");
    // The deploy-body build hints (repoUrl/ref/dockerfile) ride along as `options`
    // so the daemon job rebuilds from the same source the caller specified.
    expect(enqueued).toEqual({
      appId: APP_ID,
      deploymentGeneration: expect.any(String),
      organizationId: ORG_ID,
      userId: USER_ID,
      options: {
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "develop",
        dockerfile: "apps/example/Dockerfile",
      },
    });
    expect(updates[0]).toMatchObject({
      deployment_status: "building",
      metadata: {
        databaseMode: "none",
        repoUrl: "https://github.com/elizaOS/eliza.git",
        ref: "develop",
        dockerfile: "apps/example/Dockerfile",
        deploymentGeneration: expect.any(String),
      },
    });
    expect(appStore.current?.metadata.repoUrl).toBe("https://github.com/elizaOS/eliza.git");
  });

  test("returns startedAt from cached ISO-string deployment timestamps", async () => {
    appStore.current = {
      id: APP_ID,
      github_repo: null,
      metadata: {},
      deployment_status: "building",
      production_url: "https://example.vercel.app",
      last_deployed_at: "2026-05-19T15:00:00.000Z",
    };

    await expect(new AppDeploymentsService().getLatestDeployment(APP_ID)).resolves.toEqual({
      deploymentId: `${APP_ID}:2026-05-19T15:00:00.000Z`,
      status: "BUILDING",
      vercelUrl: "https://example.vercel.app",
      error: null,
      startedAt: "2026-05-19T15:00:00.000Z",
    });
  });

  test("only one concurrent request claims and enqueues the active deployment", async () => {
    const service = new AppDeploymentsService();
    const enqueued: unknown[] = [];
    service.setDeployEnqueuer(async (payload) => void enqueued.push(payload));

    const settled = await Promise.allSettled([
      service.createDeployment({ appId: APP_ID, organizationId: ORG_ID, userId: USER_ID }),
      service.createDeployment({ appId: APP_ID, organizationId: ORG_ID, userId: USER_ID }),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  test("an ambiguous enqueue terminalizes its generation so admission can recover", async () => {
    const service = new AppDeploymentsService();
    let generation = "";
    service.setDeployEnqueuer(async (payload) => {
      generation = payload.deploymentGeneration;
      throw new AppDeployEnqueueAmbiguousError(payload.deploymentGeneration, new Error("lost"));
    });

    await expect(
      service.createDeployment({ appId: APP_ID, organizationId: ORG_ID, userId: USER_ID }),
    ).rejects.toBeInstanceOf(AppDeployEnqueueAmbiguousError);

    expect(appStore.current?.deployment_status).toBe("failed");
    expect(appStore.current?.metadata.deploymentGeneration).toBe(generation);
    expect(updates).toHaveLength(2);

    service.setDeployEnqueuer(async () => undefined);
    await expect(
      service.createDeployment({ appId: APP_ID, organizationId: ORG_ID, userId: USER_ID }),
    ).resolves.toMatchObject({ status: "BUILDING" });
  });

  test("a direct runner failure terminalizes a generation that already entered deploying", async () => {
    const service = new AppDeploymentsService({
      async run() {
        if (appStore.current) appStore.current.deployment_status = "deploying";
        throw new Error("build failed after runner claim");
      },
    });

    await expect(
      service.createDeployment({ appId: APP_ID, organizationId: ORG_ID, userId: USER_ID }),
    ).rejects.toThrow("build failed after runner claim");
    expect(appStore.current?.deployment_status).toBe("failed");
  });

  test("an ambiguous enqueue cannot overwrite a worker that already claimed deploying", async () => {
    const service = new AppDeploymentsService();
    service.setDeployEnqueuer(async (payload) => {
      if (appStore.current) appStore.current.deployment_status = "deploying";
      throw new AppDeployEnqueueAmbiguousError(payload.deploymentGeneration, new Error("lost"));
    });

    await expect(
      service.createDeployment({ appId: APP_ID, organizationId: ORG_ID, userId: USER_ID }),
    ).rejects.toBeInstanceOf(AppDeployEnqueueAmbiguousError);
    expect(appStore.current?.deployment_status).toBe("deploying");
  });
});
