/**
 * Public hosted-frontend serve route — real route handler + real
 * AppFrontendHostingService (R2 shim). Resolves the app from the request host
 * (system suffix slug, or verified/active custom domain) and serves the active
 * deployment; fails closed to 404 otherwise. Data seams mocked:
 *   - `@/lib/services/apps` (getBySlug/getById/trackPageView)
 *   - `@/lib/services/managed-domains` (getDomainByName)
 *   - `@/db/repositories/app-frontend-deployments` (getActive)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppFrontendDeployment } from "@/db/schemas/app-frontend-deployments";
import * as realApps from "@/lib/services/apps";
import * as realManaged from "@/lib/services/managed-domains";
import {
  type RuntimeR2Bucket,
  setRuntimeR2Bucket,
} from "@/lib/storage/r2-runtime-binding";
import { sha256Hex } from "@/lib/services/app-frontend-hosting";
import type { AppEnv } from "@/types/cloud-worker-env";

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];
const APP = {
  id: "app_1",
  name: "Cool Site",
  description: "a cool site",
  logo_url: null,
  is_active: true,
  is_approved: true,
};

const trackPageView = mock(async () => {});
let getBySlugImpl: (slug: string) => Promise<unknown> = async () => undefined;
let getByIdImpl: (id: string) => Promise<unknown> = async () => undefined;
let getDomainByNameImpl: (d: string) => Promise<unknown> = async () => undefined;
let getActiveImpl: (appId: string) => Promise<AppFrontendDeployment | undefined> = async () =>
  undefined;

mock.module("@/lib/services/apps", () => ({
  ...realApps,
  appsService: {
    getBySlug: (slug: string) => getBySlugImpl(slug),
    getById: (id: string) => getByIdImpl(id),
    trackPageView,
  },
}));
mock.module("@/lib/services/managed-domains", () => ({
  ...realManaged,
  managedDomainsService: { getDomainByName: (d: string) => getDomainByNameImpl(d) },
}));
mock.module("@/db/repositories/app-frontend-deployments", () => ({
  appFrontendDeploymentsRepository: { getActive: (id: string) => getActiveImpl(id) },
}));

const serveRoute = (
  await import("../v1/hosted-frontend/serve/[[...path]]/route")
).default;

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
      objects.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : (value as Uint8Array),
      );
      return {};
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
  };
}

let activeDeployment: AppFrontendDeployment;

beforeAll(async () => {
  const objects = new Map<string, Uint8Array>();
  setRuntimeR2Bucket(memoryBucket(objects));
  const prefix = "app-frontends/o/app_1/dep_1/";
  const html = new TextEncoder().encode("<html><head></head><body><h1>Live</h1></body></html>");
  const hash = await sha256Hex(html);
  objects.set(`${prefix}${hash}`, html);
  activeDeployment = {
    id: "dep_1",
    app_id: "app_1",
    r2_prefix: prefix,
    status: "active",
    manifest: {
      entrypoint: "index.html",
      spaFallback: true,
      files: [{ path: "index.html", hash, contentType: "text/html; charset=utf-8", size: html.byteLength }],
    },
  } as unknown as AppFrontendDeployment;
});

afterAll(() => {
  mock.module("@/lib/services/apps", () => realApps);
  mock.module("@/lib/services/managed-domains", () => realManaged);
  setRuntimeR2Bucket(null);
});

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });
  app.route("/api/v1/hosted-frontend/serve/:*{.+}", serveRoute);
  app.route("/api/v1/hosted-frontend/serve", serveRoute);
  return app;
}

describe("public hosted-frontend serve", () => {
  let app: Hono<AppEnv>;
  beforeEach(() => {
    app = buildApp();
    process.env.ELIZA_FRONTEND_HOST_SUFFIX = "sites.elizacloud.ai";
    getBySlugImpl = async () => undefined;
    getByIdImpl = async () => undefined;
    getDomainByNameImpl = async () => undefined;
    getActiveImpl = async () => undefined;
    trackPageView.mockClear();
  });

  test("serves a system-host (slug) request and records a page view", async () => {
    getBySlugImpl = async (slug) => (slug === "cool" ? APP : undefined);
    getActiveImpl = async (id) => (id === "app_1" ? activeDeployment : undefined);
    const res = await app.request(
      "/api/v1/hosted-frontend/serve?host=cool.sites.elizacloud.ai",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>Live</h1>");
    expect(html).toContain("<title>Cool Site</title>");
    expect(trackPageView).toHaveBeenCalled();
  });

  test("serves a verified, active custom domain", async () => {
    getDomainByNameImpl = async (d) =>
      d === "mycool.site" ? { appId: "app_1", verified: true, status: "active" } : undefined;
    getByIdImpl = async (id) => (id === "app_1" ? APP : undefined);
    getActiveImpl = async () => activeDeployment;
    const res = await app.request(
      "/api/v1/hosted-frontend/serve?host=mycool.site",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Live</h1>");
  });

  test("404 for an unknown host (fails closed)", async () => {
    const res = await app.request(
      "/api/v1/hosted-frontend/serve?host=nobody.example.com",
      {},
      ENV,
    );
    expect(res.status).toBe(404);
  });

  test("404 when the custom domain is unverified", async () => {
    getDomainByNameImpl = async () => ({ appId: "app_1", verified: false, status: "active" });
    const res = await app.request(
      "/api/v1/hosted-frontend/serve?host=unverified.site",
      {},
      ENV,
    );
    expect(res.status).toBe(404);
  });

  test("404 when the app has no active deployment", async () => {
    getBySlugImpl = async () => APP;
    getActiveImpl = async () => undefined;
    const res = await app.request(
      "/api/v1/hosted-frontend/serve?host=cool.sites.elizacloud.ai",
      {},
      ENV,
    );
    expect(res.status).toBe(404);
  });
});
