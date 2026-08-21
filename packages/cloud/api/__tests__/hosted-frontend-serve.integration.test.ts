/**
 * Public hosted-frontend serve route — real route handler + real
 * AppFrontendHostingService (R2 shim). Resolves the app from the ACTUAL
 * request host (system suffix slug, or verified/active custom domain) and
 * serves the active deployment; fails closed to 404 otherwise. Client-supplied
 * `?host=` queries and `x-forwarded-host` headers are never consulted.
 * Data seams mocked:
 *   - `@/lib/services/apps` (getBySlug/getById/trackPageView)
 *   - `@/lib/services/managed-domains` (getDomainByName)
 *   - `@/db/repositories/app-frontend-deployments` (getActive)
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Hono } from "hono";
import * as realFrontendRepo from "@/db/repositories/app-frontend-deployments";
import type { AppFrontendDeployment } from "@/db/schemas/app-frontend-deployments";
import { sha256Hex } from "@/lib/services/app-frontend-hosting";
import * as realApps from "@/lib/services/apps";
import * as realManaged from "@/lib/services/managed-domains";
import {
  type RuntimeR2Bucket,
  setRuntimeR2Bucket,
} from "@/lib/storage/r2-runtime-binding";
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
let getDomainByNameImpl: (d: string) => Promise<unknown> = async () =>
  undefined;
let getActiveImpl: (
  appId: string,
) => Promise<AppFrontendDeployment | undefined> = async () => undefined;

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
  managedDomainsService: {
    getDomainByName: (d: string) => getDomainByNameImpl(d),
  },
}));
mock.module("@/db/repositories/app-frontend-deployments", () => ({
  appFrontendDeploymentsRepository: {
    getActive: (id: string) => getActiveImpl(id),
  },
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
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : (value as Uint8Array),
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
  const html = new TextEncoder().encode(
    "<html><head></head><body><h1>Live</h1></body></html>",
  );
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
      files: [
        {
          path: "index.html",
          hash,
          contentType: "text/html; charset=utf-8",
          size: html.byteLength,
        },
      ],
    },
  } as unknown as AppFrontendDeployment;
});

afterAll(() => {
  mock.module("@/lib/services/apps", () => realApps);
  mock.module("@/lib/services/managed-domains", () => realManaged);
  mock.module(
    "@/db/repositories/app-frontend-deployments",
    () => realFrontendRepo,
  );
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
    process.env.ELIZA_FRONTEND_HOST_SUFFIX = "sites.eliza.app";
    getBySlugImpl = async () => undefined;
    getByIdImpl = async () => undefined;
    getDomainByNameImpl = async () => undefined;
    getActiveImpl = async () => undefined;
    trackPageView.mockClear();
  });

  test("serves a system-host (slug) request and records a page view", async () => {
    getBySlugImpl = async (slug) => (slug === "cool" ? APP : undefined);
    getActiveImpl = async (id) =>
      id === "app_1" ? activeDeployment : undefined;
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve",
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

  test("sets analytics cookies and records matching hosted-frontend session metadata", async () => {
    getBySlugImpl = async (slug) => (slug === "cool" ? APP : undefined);
    getActiveImpl = async (id) =>
      id === "app_1" ? activeDeployment : undefined;
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve",
      {
        headers: {
          cookie:
            "eliza_visitor_id=visitor-abc123; eliza_session_id=session-def456",
        },
      },
      ENV,
    );

    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie?.() ?? [];
    expect(setCookie.join("\n")).toContain("eliza_visitor_id=visitor-abc123");
    expect(setCookie.join("\n")).toContain("eliza_session_id=session-def456");
    expect(trackPageView).toHaveBeenCalledWith(
      "app_1",
      expect.objectContaining({
        source: "hosted_frontend",
        metadata: expect.objectContaining({
          visitor_id: "visitor-abc123",
          session_id: "session-def456",
        }),
      }),
    );
    expect(await res.text()).toContain('"visitor-abc123"');
  });

  test("ignores malformed analytics cookies instead of failing the hosted page", async () => {
    getBySlugImpl = async (slug) => (slug === "cool" ? APP : undefined);
    getActiveImpl = async (id) =>
      id === "app_1" ? activeDeployment : undefined;
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve",
      { headers: { cookie: "eliza_visitor_id=%E0%A4%A" } },
      ENV,
    );

    expect(res.status).toBe(200);
    expect(trackPageView).toHaveBeenCalledWith(
      "app_1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          visitor_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        }),
      }),
    );
  });

  test("synthesizes robots.txt (allow + sitemap link) for a hosted frontend", async () => {
    getBySlugImpl = async (slug) => (slug === "cool" ? APP : undefined);
    getActiveImpl = async () => activeDeployment;
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve/robots.txt",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Sitemap: https://cool.sites.eliza.app/sitemap.xml");
  });

  test("synthesizes sitemap.xml for a hosted frontend", async () => {
    getBySlugImpl = async (slug) => (slug === "cool" ? APP : undefined);
    getActiveImpl = async () => activeDeployment;
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve/sitemap.xml",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const body = await res.text();
    expect(body).toContain("<urlset");
    expect(body).toContain("<loc>https://cool.sites.eliza.app/</loc>");
  });

  test("serves a verified, active custom domain", async () => {
    getDomainByNameImpl = async (d) =>
      d === "mycool.site"
        ? { appId: "app_1", verified: true, status: "active" }
        : undefined;
    getByIdImpl = async (id) => (id === "app_1" ? APP : undefined);
    getActiveImpl = async () => activeDeployment;
    const res = await app.request(
      "https://mycool.site/api/v1/hosted-frontend/serve",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Live</h1>");
  });

  test("404 for a de-approved (is_approved=false) app on its system host — takedown gate", async () => {
    getBySlugImpl = async (slug) =>
      slug === "cool" ? { ...APP, is_approved: false } : undefined;
    getActiveImpl = async () => activeDeployment;
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve",
      {},
      ENV,
    );
    expect(res.status).toBe(404);
  });

  test("404 for an unknown host (fails closed)", async () => {
    const res = await app.request(
      "https://nobody.example.com/api/v1/hosted-frontend/serve",
      {},
      ENV,
    );
    expect(res.status).toBe(404);
  });

  test("404 when the custom domain is unverified", async () => {
    getDomainByNameImpl = async () => ({
      appId: "app_1",
      verified: false,
      status: "active",
    });
    const res = await app.request(
      "https://unverified.site/api/v1/hosted-frontend/serve",
      {},
      ENV,
    );
    expect(res.status).toBe(404);
  });

  test("404 when the app has no active deployment", async () => {
    getBySlugImpl = async () => APP;
    getActiveImpl = async () => undefined;
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve",
      {},
      ENV,
    );
    expect(res.status).toBe(404);
  });

  test("404 when the system-host app is not approved", async () => {
    getBySlugImpl = async () => ({ ...APP, is_approved: false });
    getActiveImpl = async () => activeDeployment;
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve",
      {},
      ENV,
    );
    expect(res.status).toBe(404);
    expect(trackPageView).not.toHaveBeenCalled();
  });
});

describe("hosted-frontend serve host resolution (anti same-origin-serve)", () => {
  let app: Hono<AppEnv>;
  beforeEach(() => {
    app = buildApp();
    process.env.ELIZA_FRONTEND_HOST_SUFFIX = "sites.eliza.app";
    getBySlugImpl = async (slug) => (slug === "cool" ? APP : undefined);
    getByIdImpl = async (id) => (id === "app_1" ? APP : undefined);
    getDomainByNameImpl = async () => undefined;
    getActiveImpl = async () => activeDeployment;
    trackPageView.mockClear();
  });

  test("ignores a `?host=` query override on the API host — 404, nothing served", async () => {
    // The W9-CLOUD-1 contract: the query string must never turn the API origin
    // into a serving host for a deployment's content.
    const res = await app.request(
      "https://api.eliza.app/api/v1/hosted-frontend/serve?host=cool.sites.eliza.app",
      {},
      ENV,
    );
    expect(res.status).toBe(404);
    expect(trackPageView).not.toHaveBeenCalled();
  });

  test("ignores a client-supplied x-forwarded-host header on the API host", async () => {
    const res = await app.request(
      "https://api.eliza.app/api/v1/hosted-frontend/serve",
      { headers: { "x-forwarded-host": "cool.sites.eliza.app" } },
      ENV,
    );
    expect(res.status).toBe(404);
    expect(trackPageView).not.toHaveBeenCalled();
  });

  test("a forged x-forwarded-host on a system-host request does not switch apps", async () => {
    // Only "cool" resolves; the forged header names "other.sites.eliza.app".
    // The response must be cool's own deployment, served from its own host.
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve",
      { headers: { "x-forwarded-host": "other.sites.eliza.app" } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Cool Site</title>");
  });

  test("a `?host=` query on a system-host request does not switch apps", async () => {
    const res = await app.request(
      "https://cool.sites.eliza.app/api/v1/hosted-frontend/serve?host=other.sites.eliza.app",
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Cool Site</title>");
  });
});
