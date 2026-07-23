/**
 * Proves project read actions reject malformed Cloud success envelopes.
 *
 * The fake SDK deliberately returns runtime-invalid JSON while the real
 * project resolver, action boundary, validators, and error translation run.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isElizaError, setActiveProject, upsertProject } from "@elizaos/core";
import {
  FakeElizaCloudClient,
  makeApp,
  makeMessage,
  memoryRuntime,
  resetSdk,
  setGetApp,
  setGetAppAnalytics,
  setGetAppEarnings,
  setListAppFrontendDeployments,
  setListAppUsers,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { getAppAnalyticsAction } = await import(
  "../src/actions/get-app-analytics.ts"
);
const { getPublishedProjectAction } = await import(
  "../src/actions/get-published-project.ts"
);
const { listAppUsersAction } = await import("../src/actions/list-app-users.ts");

const APP = makeApp({
  id: "app-project-response-boundary",
  name: "Boundary Project",
  slug: "boundary-project",
  deployment_status: "deployed",
  production_url: null,
  is_active: true,
});

let stateDir = "";
let previousStateDir: string | undefined;

function validAnalytics() {
  return {
    success: true,
    analytics: [
      {
        period_start: "2026-07-23T00:00:00.000Z",
        total_requests: 12,
        unique_users: 4,
        new_users: 1,
        total_cost: "1.25",
      },
    ],
    totalStats: {
      totalRequests: 12,
      totalUsers: 4,
      totalCreditsUsed: "1.25",
    },
    period: {
      type: "daily" as const,
      start: "2026-06-23T00:00:00.000Z",
      end: "2026-07-23T00:00:00.000Z",
    },
  };
}

function validUser() {
  return {
    id: "app-user-boundary",
    app_id: APP.id,
    user_id: "user-boundary",
    signup_source: "chat",
    referral_code_used: null,
    ip_address: null,
    user_agent: null,
    total_requests: 3,
    total_credits_used: "0.25",
    first_seen_at: "2026-07-22T00:00:00.000Z",
    last_seen_at: "2026-07-23T00:00:00.000Z",
    metadata: {},
  };
}

function validFrontend() {
  return {
    success: true,
    active_deployment_id: "frontend-boundary",
    public_url: "https://boundary-project.frontends.test",
    deployments: [
      {
        id: "frontend-boundary",
        app_id: APP.id,
        version: 1,
        status: "active" as const,
        r2_prefix: "frontends/app-project-response-boundary/frontend-boundary",
        content_hash: "a".repeat(64),
        file_count: 1,
        total_bytes: 42,
        error: null,
        created_at: "2026-07-23T00:00:00.000Z",
        activated_at: "2026-07-23T00:00:00.000Z",
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function expectTypedFailure(result: unknown, expectedCode: string): void {
  if (!isRecord(result)) {
    throw new Error("Expected an action result object");
  }
  expect(result.success).toBe(false);
  expect(isRecord(result.data) ? result.data.reason : undefined).toBe("error");
  if (!isElizaError(result.error)) {
    throw new Error("Expected the action boundary to preserve ElizaError");
  }
  expect(result.error.code).toBe(expectedCode);
  expect(result.error.severity).toBe("fatal");
}

beforeEach(() => {
  resetSdk();
  previousStateDir = process.env.ELIZA_STATE_DIR;
  stateDir = mkdtempSync(path.join(os.tmpdir(), "project-read-boundary-"));
  const projectDir = path.join(stateDir, "boundary-project");
  mkdirSync(projectDir);
  process.env.ELIZA_STATE_DIR = stateDir;
  const project = upsertProject({
    name: APP.name,
    localPath: projectDir,
    cloudAppId: APP.id,
  });
  setActiveProject(project.id);

  setGetApp(() => Promise.resolve({ success: true, app: APP }));
  setGetAppAnalytics(() => Promise.resolve(validAnalytics()));
  setListAppUsers(() =>
    Promise.resolve({
      success: true,
      users: [validUser()],
      pagination: { total: 1, limit: 25 },
    }),
  );
  setListAppFrontendDeployments(() => Promise.resolve(validFrontend()));
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
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = previousStateDir;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe("GET_APP_ANALYTICS response boundary", () => {
  it("rejects malformed totals, period, and time-series points", async () => {
    const valid = validAnalytics();
    const malformedResponses = [
      {
        ...valid,
        totalStats: { ...valid.totalStats, totalUsers: -1 },
      },
      {
        ...valid,
        period: { ...valid.period, type: "weekly" },
      },
      {
        ...valid,
        analytics: [{ ...valid.analytics[0], total_requests: "12" }],
      },
    ];

    for (const response of malformedResponses) {
      // The deliberate type violation models untrusted JSON after fetch parsing.
      setGetAppAnalytics(() => Promise.resolve(response));
      const result = await getAppAnalyticsAction.handler(
        memoryRuntime(),
        makeMessage("show project analytics"),
      );
      expectTypedFailure(result, "CLOUD_ANALYTICS_INVALID");
    }
  });

  it("rejects an incomplete or mismatched app envelope", async () => {
    const malformedResponses = [
      {
        success: true,
        app: { id: APP.id, name: APP.name },
      },
      {
        success: true,
        app: { id: "another-app", name: APP.name, slug: APP.slug },
      },
    ];

    for (const response of malformedResponses) {
      setGetApp(() => Promise.resolve(response));
      const result = await getAppAnalyticsAction.handler(
        memoryRuntime(),
        makeMessage("show project analytics"),
      );
      expectTypedFailure(result, "CLOUD_APP_RESPONSE_INVALID");
    }
  });
});

describe("LIST_APP_USERS response boundary", () => {
  it("rejects malformed user rows", async () => {
    const user = validUser();
    setListAppUsers(() =>
      Promise.resolve({
        success: true,
        users: [{ ...user, total_requests: "3" }],
        pagination: { total: 1, limit: 25 },
      }),
    );

    const result = await listAppUsersAction.handler(
      memoryRuntime(),
      makeMessage("who uses my project?"),
    );

    expectTypedFailure(result, "CLOUD_APP_USERS_INVALID");
  });

  it("rejects inconsistent pagination instead of fabricating a list", async () => {
    setListAppUsers(() =>
      Promise.resolve({
        success: true,
        users: [validUser()],
        pagination: { total: 0, limit: 25 },
      }),
    );

    const result = await listAppUsersAction.handler(
      memoryRuntime(),
      makeMessage("who uses my project?"),
    );

    expectTypedFailure(result, "CLOUD_APP_USERS_INVALID");
  });
});

describe("GET_PUBLISHED_PROJECT response boundary", () => {
  it("rejects app activity/deployment fields with invalid runtime values", async () => {
    const malformedApps = [
      { ...APP, is_active: "yes" },
      { ...APP, deployment_status: "unknown" },
    ];

    for (const app of malformedApps) {
      setGetApp(() => Promise.resolve({ success: true, app }));
      const result = await getPublishedProjectAction.handler(
        memoryRuntime(),
        makeMessage("is my project published?"),
      );
      expectTypedFailure(result, "CLOUD_APP_RESPONSE_INVALID");
    }
  });

  it("rejects an incomplete or internally inconsistent frontend envelope", async () => {
    const frontend = validFrontend();
    const malformedResponses = [
      {
        success: true,
        active_deployment_id: "missing-deployment",
        public_url: frontend.public_url,
        deployments: frontend.deployments,
      },
      {
        success: true,
        active_deployment_id: frontend.active_deployment_id,
        deployments: frontend.deployments,
      },
      {
        ...frontend,
        deployments: [{ ...frontend.deployments[0], app_id: "another-app" }],
      },
    ];

    for (const response of malformedResponses) {
      setListAppFrontendDeployments(() => Promise.resolve(response));
      const result = await getPublishedProjectAction.handler(
        memoryRuntime(),
        makeMessage("is my project published?"),
      );
      expectTypedFailure(result, "CLOUD_FRONTEND_RESPONSE_INVALID");
    }
  });

  it("rejects malformed analytics and earnings subresponses", async () => {
    const analytics = validAnalytics();
    setGetAppAnalytics(() =>
      Promise.resolve({
        ...analytics,
        period: { ...analytics.period, start: "not-a-date" },
      }),
    );
    const malformedAnalytics = await getPublishedProjectAction.handler(
      memoryRuntime(),
      makeMessage("is my project published?"),
    );
    expectTypedFailure(malformedAnalytics, "CLOUD_ANALYTICS_INVALID");

    setGetAppAnalytics(() => Promise.resolve(validAnalytics()));
    setGetAppEarnings(() =>
      Promise.resolve({
        success: true,
        earnings: { summary: { totalLifetimeEarnings: "8" } },
        monetization: { enabled: true },
      }),
    );
    const malformedEarnings = await getPublishedProjectAction.handler(
      memoryRuntime(),
      makeMessage("is my project published?"),
    );
    expectTypedFailure(malformedEarnings, "CLOUD_EARNINGS_INVALID");
  });
});
