/**
 * App managed-frontend hosting routes — REAL global middleware chain + REAL
 * route handlers + REAL AppFrontendHostingService, in-process.
 *
 * Mirrors `apps-crud.integration.test.ts`: builds the real cors + secureHeaders
 * + authMiddleware chain, mounts the REAL frontend route handlers at their
 * codegen mount paths, and mocks ONLY the data seams:
 *   - `@/lib/auth/workers-hono-auth` → maps `Bearer eliza_*` to a fixed org
 *     user (a second token → a second org for the 403 cross-org path).
 *   - `@/lib/services/apps` → in-memory `appsService` (getById + trackPageView).
 *   - `@/db/repositories/app-frontend-deployments` → in-memory repo faithful to
 *     the real version-increment + single-active semantics (the real repo is
 *     separately covered against PGlite).
 * The AppFrontendHostingService (manifest build, R2 store, SEO/beacon serve) is
 * REAL and runs against an in-memory R2 shim. No Postgres/Worker needed.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import * as realFrontendRepo from "@/db/repositories/app-frontend-deployments";
import type { App } from "@/db/repositories/apps";
import type {
  AppFrontendDeployment,
  FrontendManifest,
} from "@/db/schemas/app-frontend-deployments";
import { AuthenticationError } from "@/lib/api/cloud-worker-errors";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
import * as realApps from "@/lib/services/apps";
import {
  type RuntimeR2Bucket,
  setRuntimeR2Bucket,
} from "@/lib/storage/r2-runtime-binding";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { authMiddleware } from "../src/middleware/auth";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const KEY_A = "eliza_test_org_a_key";
const KEY_B = "eliza_test_org_b_key";
const APP_ID = "99999999-9999-4999-8999-000000000001";
const OTHER_APP = "99999999-9999-4999-8999-000000000002";

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

// ---- in-memory app store ----
const appStore = new Map<string, Partial<App>>();
const trackPageView = mock(async () => {});
const appsServiceMock = {
  async getById(id: string) {
    return appStore.get(id);
  },
  trackPageView,
};

// ---- in-memory R2 shim ----
function memoryBucket(objects: Map<string, Uint8Array>): RuntimeR2Bucket {
  return {
    async get(key) {
      const v = objects.get(key);
      if (v === undefined) return null;
      return {
        async text() {
          return new TextDecoder().decode(v);
        },
        async arrayBuffer() {
          return new Uint8Array(v).buffer;
        },
      };
    },
    async put(key, value) {
      let b: Uint8Array;
      if (typeof value === "string") b = new TextEncoder().encode(value);
      else if (value instanceof Uint8Array) b = value;
      else if (value instanceof ArrayBuffer) b = new Uint8Array(value);
      else b = new Uint8Array(0);
      objects.set(key, b);
      return {};
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
  };
}

// ---- in-memory frontend-deployments repo (faithful to real semantics) ----
const deployments = new Map<string, AppFrontendDeployment>();
let depSeq = 0;
function makeRow(appId: string, version: number): AppFrontendDeployment {
  depSeq += 1;
  return {
    id: `dep-${depSeq}`,
    app_id: appId,
    version,
    status: "pending",
    r2_prefix: "",
    manifest: null,
    content_hash: null,
    file_count: 0,
    total_bytes: 0,
    build_meta: {},
    error: null,
    created_by_user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    finalized_at: null,
    activated_at: null,
  } as AppFrontendDeployment;
}
const repoMock = {
  async create(input: { appId: string; r2Prefix: string }) {
    const existing = [...deployments.values()].filter(
      (d) => d.app_id === input.appId,
    );
    const version = existing.reduce((m, d) => Math.max(m, d.version), 0) + 1;
    const row = makeRow(input.appId, version);
    row.r2_prefix = input.r2Prefix;
    deployments.set(row.id, row);
    return row;
  },
  async getById(id: string) {
    return deployments.get(id);
  },
  async getByIdForApp(appId: string, id: string) {
    const d = deployments.get(id);
    return d && d.app_id === appId ? d : undefined;
  },
  async listByApp(appId: string) {
    return [...deployments.values()]
      .filter((d) => d.app_id === appId)
      .sort((a, b) => b.version - a.version);
  },
  async getActive(appId: string) {
    return [...deployments.values()].find(
      (d) => d.app_id === appId && d.status === "active",
    );
  },
  async setPrefix(id: string, r2Prefix: string) {
    const d = deployments.get(id);
    if (d) d.r2_prefix = r2Prefix;
  },
  async finalize(
    id: string,
    input: {
      manifest: FrontendManifest;
      contentHash: string;
      fileCount: number;
      totalBytes: number;
    },
  ) {
    const d = deployments.get(id);
    if (!d) return undefined;
    Object.assign(d, {
      status: "ready",
      manifest: input.manifest,
      content_hash: input.contentHash,
      file_count: input.fileCount,
      total_bytes: input.totalBytes,
      finalized_at: new Date(),
    });
    return d;
  },
  async markStatus(id: string, status: AppFrontendDeployment["status"]) {
    const d = deployments.get(id);
    if (d) d.status = status;
  },
  async markFailed(id: string, error: string) {
    const d = deployments.get(id);
    if (d) Object.assign(d, { status: "failed", error });
  },
  async activate(appId: string, id: string) {
    for (const d of deployments.values()) {
      if (d.app_id === appId && d.status === "active" && d.id !== id)
        d.status = "superseded";
    }
    const target = deployments.get(id);
    if (target && target.app_id === appId) {
      target.status = "active";
      target.activated_at = new Date();
    }
    return target;
  },
  async delete(id: string) {
    deployments.delete(id);
  },
};

const requireUserOrApiKeyWithOrg = mock(async (c: AppContext) => {
  const auth = c.req.header("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (bearer === KEY_A) {
    return {
      id: USER_A,
      email: "a@example.com",
      organization_id: ORG_A,
      organization: { id: ORG_A, name: "Org A", is_active: true },
      is_active: true,
      role: "user",
      steward_id: null,
      wallet_address: null,
      is_anonymous: false,
    };
  }
  if (bearer === KEY_B) {
    return {
      id: "bbbbbbbb-2222-4222-8222-222222222222",
      email: "b@example.com",
      organization_id: ORG_B,
      organization: { id: ORG_B, name: "Org B", is_active: true },
      is_active: true,
      role: "user",
      steward_id: null,
      wallet_address: null,
      is_anonymous: false,
    };
  }
  throw AuthenticationError("Authentication required");
});

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/apps", () => ({
  ...realApps,
  appsService: appsServiceMock,
}));
mock.module("@/db/repositories/app-frontend-deployments", () => ({
  appFrontendDeploymentsRepository: repoMock,
}));

// Import routes AFTER mocks (they bind the seams at module-eval time).
const baseRoute = (await import("../v1/apps/[id]/frontend/route")).default;
const detailRoute = (
  await import("../v1/apps/[id]/frontend/[deploymentId]/route")
).default;
const activateRoute = (
  await import("../v1/apps/[id]/frontend/[deploymentId]/activate/route")
).default;
const previewRoute = (
  await import("../v1/apps/[id]/frontend/preview/[[...path]]/route")
).default;

afterAll(() => {
  // Restore ALL mocked modules — bun's mock.module is process-global, so a
  // leaked repo mock corrupts sibling real-DB suites in a combined run.
  mock.module("@/lib/auth/workers-hono-auth", () => realAuth);
  mock.module("@/lib/services/apps", () => realApps);
  mock.module(
    "@/db/repositories/app-frontend-deployments",
    () => realFrontendRepo,
  );
  setRuntimeR2Bucket(null);
});

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });
  app.use("*", corsMiddleware);
  app.use(
    "*",
    secureHeaders({
      xContentTypeOptions: "nosniff",
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use("*", authMiddleware);
  // Mount deeper/more-specific paths before `:deploymentId` so "preview" and
  // "activate" are not captured as a deployment id.
  app.route("/api/v1/apps/:id/frontend/preview/:*{.+}", previewRoute);
  app.route("/api/v1/apps/:id/frontend/preview", previewRoute);
  app.route("/api/v1/apps/:id/frontend/:deploymentId/activate", activateRoute);
  app.route("/api/v1/apps/:id/frontend/:deploymentId", detailRoute);
  app.route("/api/v1/apps/:id/frontend", baseRoute);
  return app;
}

function req(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  key: string | null,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(
    path,
    {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    ENV,
  );
}

const BUNDLE = {
  files: [
    {
      path: "index.html",
      content: "<html><head></head><body><h1>Home</h1></body></html>",
    },
    { path: "assets/app.js", content: "console.log(1)" },
  ],
};

describe("apps frontend hosting routes", () => {
  let app: Hono<AppEnv>;
  beforeEach(() => {
    app = buildApp();
    appStore.clear();
    deployments.clear();
    depSeq = 0;
    trackPageView.mockClear();
    setRuntimeR2Bucket(memoryBucket(new Map()));
    appStore.set(APP_ID, {
      id: APP_ID,
      name: "Cool App",
      description: "A cool app",
      logo_url: null,
      production_url: null,
      app_url: "https://placeholder.invalid",
      organization_id: ORG_A,
    });
    appStore.set(OTHER_APP, { id: OTHER_APP, organization_id: ORG_A });
  });

  test("POST publishes and activates a bundle (201)", async () => {
    const res = await req(
      app,
      "POST",
      `/api/v1/apps/${APP_ID}/frontend`,
      KEY_A,
      BUNDLE,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { deployment: AppFrontendDeployment };
    expect(json.deployment.status).toBe("active");
    expect(json.deployment.version).toBe(1);
    expect(json.deployment.file_count).toBe(2);
  });

  test("POST rejects a bundle with no files (400)", async () => {
    const res = await req(
      app,
      "POST",
      `/api/v1/apps/${APP_ID}/frontend`,
      KEY_A,
      { files: [] },
    );
    expect(res.status).toBe(400);
  });

  test("POST from another org is denied (403)", async () => {
    const res = await req(
      app,
      "POST",
      `/api/v1/apps/${APP_ID}/frontend`,
      KEY_B,
      BUNDLE,
    );
    expect(res.status).toBe(403);
  });

  test("unauthenticated request is rejected (401)", async () => {
    const res = await req(app, "GET", `/api/v1/apps/${APP_ID}/frontend`, null);
    expect(res.status).toBe(401);
  });

  test("GET lists deployments with the active id", async () => {
    await req(app, "POST", `/api/v1/apps/${APP_ID}/frontend`, KEY_A, BUNDLE);
    const res = await req(app, "GET", `/api/v1/apps/${APP_ID}/frontend`, KEY_A);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      deployments: AppFrontendDeployment[];
      active_deployment_id: string | null;
    };
    expect(json.deployments).toHaveLength(1);
    expect(json.active_deployment_id).toBe(json.deployments[0].id);
  });

  test("activate an older deployment rolls back", async () => {
    const r1 = await (
      await req(app, "POST", `/api/v1/apps/${APP_ID}/frontend`, KEY_A, BUNDLE)
    ).json();
    await req(app, "POST", `/api/v1/apps/${APP_ID}/frontend`, KEY_A, BUNDLE); // v2 active
    const v1Id = (r1 as { deployment: AppFrontendDeployment }).deployment.id;
    const res = await req(
      app,
      "POST",
      `/api/v1/apps/${APP_ID}/frontend/${v1Id}/activate`,
      KEY_A,
    );
    expect(res.status).toBe(200);
    const active = await (
      await req(app, "GET", `/api/v1/apps/${APP_ID}/frontend`, KEY_A)
    ).json();
    expect(
      (active as { active_deployment_id: string }).active_deployment_id,
    ).toBe(v1Id);
  });

  test("cannot delete the active deployment (409), can delete a superseded one", async () => {
    const r1 = await (
      await req(app, "POST", `/api/v1/apps/${APP_ID}/frontend`, KEY_A, BUNDLE)
    ).json();
    const v1Id = (r1 as { deployment: AppFrontendDeployment }).deployment.id;
    await req(app, "POST", `/api/v1/apps/${APP_ID}/frontend`, KEY_A, BUNDLE); // v2 now active, v1 superseded

    const denied = await req(
      app,
      "DELETE",
      `/api/v1/apps/${APP_ID}/frontend`,
      KEY_A,
    );
    // deleting via base path is not a route; delete the ACTIVE one by id → 409
    const active = await (
      await req(app, "GET", `/api/v1/apps/${APP_ID}/frontend`, KEY_A)
    ).json();
    const activeId = (active as { active_deployment_id: string })
      .active_deployment_id;
    const del409 = await req(
      app,
      "DELETE",
      `/api/v1/apps/${APP_ID}/frontend/${activeId}`,
      KEY_A,
    );
    expect(del409.status).toBe(409);

    const del200 = await req(
      app,
      "DELETE",
      `/api/v1/apps/${APP_ID}/frontend/${v1Id}`,
      KEY_A,
    );
    expect(del200.status).toBe(200);
    void denied;
  });

  test("preview serves the site with injected SEO + records a page view", async () => {
    await req(app, "POST", `/api/v1/apps/${APP_ID}/frontend`, KEY_A, BUNDLE);
    const res = await req(
      app,
      "GET",
      `/api/v1/apps/${APP_ID}/frontend/preview`,
      KEY_A,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>Home</h1>");
    expect(html).toContain("<title>Cool App</title>");
    expect(html).toContain("/api/v1/track/pageview");
    expect(trackPageView).toHaveBeenCalled();
  });

  test("preview serves a nested asset with immutable caching", async () => {
    await req(app, "POST", `/api/v1/apps/${APP_ID}/frontend`, KEY_A, BUNDLE);
    const res = await req(
      app,
      "GET",
      `/api/v1/apps/${APP_ID}/frontend/preview/assets/app.js`,
      KEY_A,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });
});
