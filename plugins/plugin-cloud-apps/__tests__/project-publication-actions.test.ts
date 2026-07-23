/**
 * Project-keyed Cloud action tests over a real temp projects.json registry.
 *
 * Only the SDK and public-URL probe boundaries are faked; project resolution,
 * atomic binding, build-directory packaging, confirmation tasks, and action
 * result shaping run through their production implementations.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AppDto,
  CreateAppInput,
  UpdateAppInput,
} from "@elizaos/cloud-sdk";
import { getProjectById, setActiveProject, upsertProject } from "@elizaos/core";
import {
  captureCallback,
  FakeElizaCloudClient,
  makeApp,
  makeMessage,
  memoryRuntime,
  resetSdk,
  setCreateApp,
  setDeployAppFrontend,
  setGetApp,
  setGetAppAnalytics,
  setGetAppEarnings,
  setListAppFrontendDeployments,
  setListAppUsers,
  setUpdateApp,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const {
  getAppAnalyticsAction,
  getPublishedProjectAction,
  listAppUsersAction,
  publishProjectAction,
  unpublishProjectAction,
} = await import("../src/index.ts");

const originalFetch = globalThis.fetch;
let stateDir = "";
let projectDir = "";
let cloudApp: AppDto;
let createInputs: CreateAppInput[] = [];
let updates: UpdateAppInput[] = [];

function installCloudState(overrides: Partial<AppDto> = {}): void {
  cloudApp = makeApp({
    id: "app-project-1",
    name: "Proof Project",
    slug: "proof-project",
    app_url: "https://pending.invalid",
    production_url: null,
    deployment_status: "draft",
    is_active: true,
    ...overrides,
  });
  setGetApp(() => Promise.resolve({ success: true, app: cloudApp }));
  setCreateApp((input) => {
    createInputs.push(input);
    cloudApp = {
      ...cloudApp,
      is_active: input.is_active ?? true,
    };
    return Promise.resolve({
      success: true,
      app: cloudApp,
      apiKey: "eliza_app_secret_must_not_leak",
    });
  });
  setUpdateApp((_id, patch) => {
    updates.push(patch);
    cloudApp = { ...cloudApp, ...patch };
    return Promise.resolve({ success: true, app: cloudApp });
  });
}

function registerProject(
  options: { bound?: boolean; withBuild?: boolean } = {},
) {
  if (options.withBuild) {
    const dist = path.join(projectDir, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      path.join(dist, "index.html"),
      "<html><body>proof</body></html>",
      "utf8",
    );
  }
  const project = upsertProject({
    name: "Proof Project",
    localPath: projectDir,
    ...(options.bound ? { cloudAppId: cloudApp.id } : {}),
  });
  setActiveProject(project.id);
  return project;
}

beforeEach(() => {
  resetSdk();
  createInputs = [];
  updates = [];
  stateDir = mkdtempSync(path.join(os.tmpdir(), "project-publication-action-"));
  projectDir = path.join(stateDir, "proof-project");
  mkdirSync(projectDir);
  process.env.ELIZA_STATE_DIR = stateDir;
  installCloudState();
  globalThis.fetch = (async () =>
    new Response(cloudApp.is_active ? "ok" : "inactive", {
      status: cloudApp.is_active ? 200 : 404,
    })) as typeof fetch;
  setDeployAppFrontend(() =>
    Promise.resolve({
      success: true,
      deployment: {
        id: "frontend-1",
        app_id: cloudApp.id,
        version: 1,
        status: "active",
        r2_prefix: "frontends/app-project-1/frontend-1",
        content_hash: "a".repeat(64),
        file_count: 1,
        total_bytes: 31,
        error: null,
        created_at: "2026-07-23T00:00:00.000Z",
        activated_at: "2026-07-23T00:00:00.000Z",
      },
      public_url: "https://proof-project.frontends.test",
    }),
  );
  setListAppFrontendDeployments(() =>
    Promise.resolve({
      success: true,
      active_deployment_id: "frontend-1",
      public_url: "https://proof-project.frontends.test",
      deployments: [
        {
          id: "frontend-1",
          app_id: cloudApp.id,
          version: 1,
          status: "active",
          r2_prefix: "frontends/app-project-1/frontend-1",
          content_hash: "a".repeat(64),
          file_count: 1,
          total_bytes: 31,
          error: null,
          created_at: "2026-07-23T00:00:00.000Z",
          activated_at: "2026-07-23T00:00:00.000Z",
        },
      ],
    }),
  );
  setGetAppAnalytics(() =>
    Promise.resolve({
      success: true,
      analytics: [
        {
          period_start: "2026-07-23T00:00:00.000Z",
          total_requests: 12,
          unique_users: 4,
          new_users: 0,
          total_cost: "1.25",
        },
      ],
      totalStats: {
        totalRequests: 12,
        totalUsers: 4,
        totalCreditsUsed: "1.25",
      },
      period: {
        type: "daily",
        start: "2026-06-23T00:00:00.000Z",
        end: "2026-07-23T00:00:00.000Z",
      },
    }),
  );
  setGetAppEarnings(() =>
    Promise.resolve({
      success: true,
      earnings: {
        summary: {
          totalLifetimeEarnings: 8,
          totalInferenceEarnings: 8,
          totalPurchaseEarnings: 0,
          pendingBalance: 1,
          withdrawableBalance: 7,
          totalWithdrawn: 0,
          payoutThreshold: 25,
        },
      },
      monetization: { enabled: true },
    }),
  );
  setListAppUsers(() =>
    Promise.resolve({
      success: true,
      users: [
        {
          id: "app-user-1",
          app_id: cloudApp.id,
          user_id: "user-1",
          signup_source: "chat",
          referral_code_used: null,
          ip_address: "203.0.113.9",
          user_agent: "secret-test-agent",
          total_requests: 3,
          total_credits_used: "0.25",
          first_seen_at: "2026-07-22T00:00:00.000Z",
          last_seen_at: "2026-07-23T00:00:00.000Z",
          metadata: { private: true },
        },
      ],
      pagination: { total: 1, limit: 25 },
    }),
  );
});

afterEach(() => {
  delete process.env.ELIZA_STATE_DIR;
  globalThis.fetch = originalFetch;
  rmSync(stateDir, { recursive: true, force: true });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("PUBLISH_PROJECT", () => {
  it("creates, immediately binds, publishes an auto-detected build, and activates only after liveness", async () => {
    const project = registerProject({ withBuild: true });
    const callback = captureCallback();
    const result = await publishProjectAction.handler(
      memoryRuntime(),
      makeMessage("publish my project"),
      undefined,
      { name: "Proof Project Public" },
      callback.fn,
    );

    expect(result.success).toBe(true);
    expect(result.userFacingText).toContain(
      "https://proof-project.frontends.test",
    );
    expect(result.userFacingText).not.toContain(
      "eliza_app_secret_must_not_leak",
    );
    expect(getProjectById(project.id)?.cloudAppId).toBe(cloudApp.id);
    expect(createInputs).toEqual([
      expect.objectContaining({
        name: "Proof Project Public",
        is_active: false,
      }),
    ]);
    expect(updates[0]).toEqual({ is_active: false });
    expect(updates.at(-1)).toMatchObject({
      name: "Proof Project Public",
      app_url: "https://proof-project.frontends.test",
      allowed_origins: ["https://proof-project.frontends.test"],
      is_active: true,
    });
    expect(result.data).toMatchObject({
      published: true,
      hosting: "managed-frontend",
      createdCloudRecord: true,
      apiKeyCreated: true,
    });
  });

  it("keeps a failed publication bound and inactive when Cloud has no public frontend host", async () => {
    const project = registerProject({ withBuild: true });
    setDeployAppFrontend(() =>
      Promise.resolve({
        success: true,
        deployment: {
          id: "frontend-1",
          app_id: cloudApp.id,
          version: 1,
          status: "active",
          r2_prefix: "p",
          content_hash: null,
          file_count: 1,
          total_bytes: 31,
          error: null,
          created_at: "2026-07-23T00:00:00.000Z",
          activated_at: "2026-07-23T00:00:00.000Z",
        },
        public_url: null,
      }),
    );

    const result = await publishProjectAction.handler(
      memoryRuntime(),
      makeMessage("publish my project"),
    );

    expect(result.success).toBe(false);
    expect(getProjectById(project.id)?.cloudAppId).toBe(cloudApp.id);
    expect(updates).toEqual([{ is_active: false }]);
    expect(result.userFacingText).toContain(
      "remains bound so a retry will reuse the same identity",
    );
  });

  it("rolls an activated managed frontend back to inactive when its public URL returns 404", async () => {
    const project = registerProject({ withBuild: true });
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as typeof fetch;

    const result = await publishProjectAction.handler(
      memoryRuntime(),
      makeMessage("publish my project"),
    );

    expect(result.success).toBe(false);
    expect(getProjectById(project.id)?.cloudAppId).toBe(cloudApp.id);
    expect(updates).toEqual([
      { is_active: false },
      expect.objectContaining({
        app_url: "https://proof-project.frontends.test",
        is_active: true,
      }),
      { is_active: false },
    ]);
    expect(cloudApp.is_active).toBe(false);
    expect(result.userFacingText).toContain(
      "remains bound so a retry will reuse the same identity",
    );
  });

  it("rejects invalid container input before creating or mutating a Cloud record", async () => {
    const project = registerProject();

    const result = await publishProjectAction.handler(
      memoryRuntime(),
      makeMessage("publish my project as a container"),
      undefined,
      { mode: "container", ref: "main" },
    );

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      reason: "missing_repo",
      projectId: project.id,
    });
    expect(getProjectById(project.id)?.cloudAppId).toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});

describe("project publication reads", () => {
  it("GET_PUBLISHED_PROJECT returns live URL, analytics, and earnings", async () => {
    installCloudState({
      app_url: "https://proof-project.frontends.test",
      is_active: true,
    });
    registerProject({ bound: true });

    const result = await getPublishedProjectAction.handler(
      memoryRuntime(),
      makeMessage("how is my project doing?"),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      published: true,
      publicUrl: "https://proof-project.frontends.test",
      analytics: { totalRequests: 12, totalUsers: 4 },
      earnings: { totalLifetimeEarnings: 8, withdrawableBalance: 7 },
    });
  });

  it("GET_APP_ANALYTICS resolves the active project and returns exact Cloud totals", async () => {
    registerProject({ bound: true });
    const result = await getAppAnalyticsAction.handler(
      memoryRuntime(),
      makeMessage("show project analytics"),
      undefined,
      { period: "daily" },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      analytics: {
        totalStats: {
          totalRequests: 12,
          totalUsers: 4,
          totalCreditsUsed: "1.25",
        },
      },
    });
  });

  it("LIST_APP_USERS omits IP, user-agent, and arbitrary metadata from chat/action data", async () => {
    registerProject({ bound: true });
    const result = await listAppUsersAction.handler(
      memoryRuntime(),
      makeMessage("who uses my project?"),
    );
    const serialized = JSON.stringify(result);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      users: [
        {
          userId: "user-1",
          totalRequests: 3,
          totalCreditsUsed: "0.25",
        },
      ],
    });
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain("secret-test-agent");
    expect(serialized).not.toContain('"private"');
  });
});

describe("UNPUBLISH_PROJECT", () => {
  it("requires confirmation, deactivates once, and preserves the project binding", async () => {
    const project = registerProject({ bound: true });
    const runtime = memoryRuntime();

    const first = await unpublishProjectAction.handler(
      runtime,
      makeMessage("unpublish my project"),
    );
    expect(first.success).toBe(true);
    expect(first.data).toMatchObject({
      confirmationRequired: true,
      unpublished: false,
    });
    expect(updates).toHaveLength(0);

    const confirmed = await unpublishProjectAction.handler(
      runtime,
      makeMessage("yes"),
      undefined,
      { confirm: true },
    );
    expect(confirmed.success).toBe(true);
    expect(updates).toEqual([{ is_active: false }]);
    expect(getProjectById(project.id)?.cloudAppId).toBe(cloudApp.id);
    expect(confirmed.data).toMatchObject({
      unpublished: true,
      bindingPreserved: true,
    });
  });
});
