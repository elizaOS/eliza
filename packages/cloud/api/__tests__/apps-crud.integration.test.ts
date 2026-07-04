/**
 * Apps CRUD — REAL global middleware chain + REAL route handlers, in-process.
 *
 * Mirrors `shared-agent-messages-stream.integration.test.ts`: builds a Hono app
 * that replicates `createApp()`'s global chain (the real `corsMiddleware`, the
 * same `secureHeaders` config, the no-store JSON pass, and the real
 * `authMiddleware`) and mounts the REAL apps route handlers at their codegen
 * mount paths. Only the DATA seams are mocked so no Postgres/Worker is needed.
 *
 * Seams mocked (and ONLY these):
 *   - `@/lib/auth/workers-hono-auth` → `requireUserOrApiKeyWithOrg` maps the
 *     `Bearer eliza_*` token to a fixed org user. A SECOND token resolves to a
 *     SECOND org so the 403 cross-org paths are exercised. The real
 *     `authMiddleware` still gates the request (a `Bearer eliza_*` passes its
 *     programmatic-auth check; no auth header → 401 from the route resolver via
 *     `failureResponse`). The real module is spread so `getCurrentUser` (used by
 *     `authMiddleware`) is untouched.
 *   - `@/lib/services/apps` → `appsService` backed by an in-memory
 *     `Map<string, App>` so create→list→get→update→delete are coherent. Keeps
 *     the REAL `AppNameConflictError`.
 *   - `@/lib/services/app-factory` → `createApp` seeds the store + returns an
 *     `eliza_test_*` apiKey (no GitHub side-effect); throws `AppNameConflictError`
 *     for a duplicate name.
 *   - `@/lib/services/app-cleanup` → `deleteAppWithCleanup` removes from the
 *     store and returns the real `CleanupResult` shape.
 *   - `@/lib/services/app-credits` → `updateMonetizationSettings` persists the
 *     monetization fields into the stored App.
 *
 * No DB, no Worker; runs in plain `bun test`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { App } from "@/db/repositories/apps";
import { AuthenticationError } from "@/lib/api/cloud-worker-errors";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
import * as realAppCleanup from "@/lib/services/app-cleanup";
import * as realAppCredits from "@/lib/services/app-credits";
import * as realAppFactory from "@/lib/services/app-factory";
// Keep the real modules so afterAll can restore them — bun's `mock.module` is
// process-global and leaks across files otherwise.
import * as realApps from "@/lib/services/apps";
import * as realChars from "@/lib/services/characters/characters";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { authMiddleware } from "../src/middleware/auth";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";

// Programmatic-auth bearer keys. `authMiddleware` passes any `Bearer eliza_*`
// through; the mocked resolver maps each token to its org.
const KEY_A = "eliza_test_org_a_key";
const KEY_B = "eliza_test_org_b_key";

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let nextId = 0;
function freshUuid(): string {
  nextId += 1;
  const hex = nextId.toString(16).padStart(12, "0");
  return `99999999-9999-4999-8999-${hex}`;
}

/** Build a fully-typed App row for the in-memory store. */
function makeApp(overrides: Partial<App>): App {
  const id = overrides.id ?? freshUuid();
  const name = overrides.name ?? "Test App";
  const base = {
    id,
    name,
    description: null,
    slug: name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 50),
    organization_id: ORG_A,
    created_by_user_id: USER_A,
    app_url: "https://example.com",
    allowed_origins: ["https://example.com"],
    api_key_id: freshUuid(),
    affiliate_code: null,
    referral_bonus_credits: "0.00",
    total_requests: 0,
    total_users: 0,
    total_credits_used: "0.00",
    logo_url: null,
    website_url: null,
    contact_email: null,
    metadata: {},
    production_url: null,
    last_deployed_at: null,
    deployment_status: null,
    github_repo: null,
    linked_character_ids: [],
    monetization_enabled: false,
    inference_markup_percentage: null,
    custom_pricing_enabled: false,
    purchase_share_percentage: null,
    total_creator_earnings: "0.00",
    total_platform_revenue: "0.00",
    platform_offset_amount: "0.00",
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    email_notifications: true,
    response_notifications: true,
    is_active: true,
    is_approved: true,
    review_status: "draft",
    review_content_hash: null,
    reviewed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    last_used_at: null,
  };
  return { ...base, ...overrides } as App;
}

// ---------------------------------------------------------------------------
// In-memory store + service mocks
// ---------------------------------------------------------------------------

const store = new Map<string, App>();
let createAppLimit: number | null = null;

function slugFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
}

const appsServiceMock = {
  async getById(id: string): Promise<App | undefined> {
    return store.get(id);
  },
  async listByOrganizationWithDatabaseState(orgId: string): Promise<App[]> {
    return [...store.values()].filter((a) => a.organization_id === orgId);
  },
  async withDatabaseState(app: App): Promise<App> {
    return app;
  },
  async update(id: string, data: Partial<App>): Promise<App | undefined> {
    const existing = store.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...data, updated_at: new Date() } as App;
    store.set(id, updated);
    return updated;
  },
  async isNameAvailable(name: string): Promise<{
    available: boolean;
    slug: string;
    conflictType?: "app" | "subdomain";
    suggestedName?: string;
  }> {
    const slug = slugFor(name);
    const taken = [...store.values()].some((a) => a.slug === slug);
    if (taken) {
      return {
        available: false,
        slug,
        conflictType: "app",
        suggestedName: `${name}-a1b2`,
      };
    }
    return { available: true, slug };
  },
};

const createApp = mock(
  async (
    data: {
      name: string;
      description?: string;
      organization_id: string;
      created_by_user_id: string;
      app_url: string;
      website_url?: string;
      contact_email?: string;
      allowed_origins?: string[];
      logo_url?: string;
    },
    options: { createGitHubRepo?: boolean } = {},
  ) => {
    // Real factory checks name availability first and throws on conflict.
    const slug = slugFor(data.name);
    if ([...store.values()].some((a) => a.slug === slug)) {
      throw new realApps.AppNameConflictError(
        `An app with the name "${data.name}" already exists. Please choose a different name.`,
        "app",
        `${data.name}-a1b2`,
      );
    }

    if (
      createAppLimit !== null &&
      [...store.values()].filter(
        (a) => a.organization_id === data.organization_id,
      ).length >= createAppLimit
    ) {
      throw new realApps.AppCreationLimitError(
        data.organization_id,
        createAppLimit,
      );
    }

    const githubRepoCreated = options.createGitHubRepo !== false;
    const app = makeApp({
      name: data.name,
      description: data.description ?? null,
      organization_id: data.organization_id,
      created_by_user_id: data.created_by_user_id,
      app_url: data.app_url,
      website_url: data.website_url ?? null,
      contact_email: data.contact_email ?? null,
      allowed_origins: data.allowed_origins ?? [data.app_url],
      logo_url: data.logo_url ?? null,
      github_repo: githubRepoCreated ? `elizaOS-apps/${slug}` : null,
    });
    store.set(app.id, app);

    return {
      app,
      apiKey: `eliza_test_${app.id.replace(/-/g, "").slice(0, 24)}`,
      githubRepo: githubRepoCreated ? `elizaOS-apps/${slug}` : undefined,
      githubRepoCreated,
      errors: [] as string[],
    };
  },
);

const updateMonetizationSettings = mock(
  async (
    appId: string,
    settings: {
      monetizationEnabled?: boolean;
      inferenceMarkupPercentage?: number;
    },
  ) => {
    const existing = store.get(appId);
    if (!existing) return;
    store.set(appId, {
      ...existing,
      ...(settings.monetizationEnabled !== undefined && {
        monetization_enabled: settings.monetizationEnabled,
      }),
      ...(settings.inferenceMarkupPercentage !== undefined && {
        // `inference_markup_percentage` is a real() (number) column, not a
        // decimal string — store the number so the mock matches the schema.
        inference_markup_percentage: settings.inferenceMarkupPercentage,
      }),
    } as App);
  },
);

// Toggle to simulate partial-cleanup errors from the cleanup service.
let cleanupErrors: string[] = [];

const deleteAppWithCleanup = mock(
  async (appId: string, options: { deleteGitHubRepo?: boolean } = {}) => {
    const app = store.get(appId);
    const githubRepoDeleted =
      options.deleteGitHubRepo !== false && Boolean(app?.github_repo);
    store.delete(appId);
    return {
      success: cleanupErrors.length === 0,
      errors: cleanupErrors,
      cleaned: {
        domainsRemoved: 0,
        githubRepoDeleted,
        secretBindingsRemoved: 0,
        managedDomainsUnlinked: 0,
      },
    };
  },
);

// Auth resolver: map the bearer token to its org user. The real
// `authMiddleware` runs first and lets `Bearer eliza_*` through; this resolver
// then does the per-route org binding (and throws for missing/invalid auth,
// which `failureResponse` turns into a 401).
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
      id: USER_B,
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

// The PUT /apps/:id route validates each linked_character_id via the real
// charactersService.getById (a DB query) to block cross-tenant character
// linking. This unit-style suite mocks the apps store, not the DB, so stub the
// lookup: report every requested character as an owned, public character so the
// route's existence + ownership guard passes for the happy-path link test. No
// test asserts a character rejection, so this stays faithful to the route.
mock.module("@/lib/services/characters/characters", () => ({
  ...realChars,
  charactersService: {
    ...realChars.charactersService,
    getById: async (id: string) => ({ id, user_id: USER_A, is_public: true }),
  },
}));

mock.module("@/lib/services/app-factory", () => ({
  ...realAppFactory,
  appFactoryService: { ...realAppFactory.appFactoryService, createApp },
}));

mock.module("@/lib/services/app-cleanup", () => ({
  ...realAppCleanup,
  appCleanupService: {
    ...realAppCleanup.appCleanupService,
    deleteAppWithCleanup,
  },
}));

mock.module("@/lib/services/app-credits", () => ({
  ...realAppCredits,
  appCreditsService: {
    ...realAppCredits.appCreditsService,
    updateMonetizationSettings,
  },
}));

// Routes import the mocked seams at module-eval time, so import AFTER the mocks.
const listRoute = (await import("../v1/apps/route")).default;
const detailRoute = (await import("../v1/apps/[id]/route")).default;
const checkNameRoute = (await import("../v1/apps/check-name/route")).default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => realAuth);
  mock.module("@/lib/services/apps", () => realApps);
  mock.module("@/lib/services/characters/characters", () => realChars);
  mock.module("@/lib/services/app-factory", () => realAppFactory);
  mock.module("@/lib/services/app-cleanup", () => realAppCleanup);
  mock.module("@/lib/services/app-credits", () => realAppCredits);
});

// ---------------------------------------------------------------------------
// App under test — the real global chain around the real route handlers.
// ---------------------------------------------------------------------------

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });
  app.use("*", corsMiddleware);
  app.use(
    "*",
    secureHeaders({
      xContentTypeOptions: "nosniff",
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
      crossOriginResourcePolicy: "cross-origin",
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
    }),
  );
  app.use("*", async (c, next) => {
    await next();
    const headers = c.res.headers;
    if (
      !headers.has("Cache-Control") &&
      headers.get("Content-Type")?.includes("application/json")
    ) {
      headers.set("Cache-Control", "no-store");
    }
  });
  app.use("*", authMiddleware);
  // Mount order matters: the more specific check-name route before :id so a POST
  // to /api/v1/apps/check-name is not swallowed by the :id detail route.
  app.route("/api/v1/apps/check-name", checkNameRoute);
  app.route("/api/v1/apps/:id", detailRoute);
  app.route("/api/v1/apps", listRoute);
  return app;
}

const app = buildApp();

type Json = Record<string, unknown>;

async function req(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown } = {},
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  const res = await app.request(
    path,
    {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    },
    ENV,
  );
  const json = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, json };
}

/** Seed one app directly into the store for the given org. */
function seed(overrides: Partial<App> = {}): App {
  const app = makeApp(overrides);
  store.set(app.id, app);
  return app;
}

const VALID_CREATE = {
  name: "My Cool App",
  description: "A cool app",
  app_url: "https://mycoolapp.example.com",
};

beforeEach(() => {
  store.clear();
  cleanupErrors = [];
  createAppLimit = null;
  createApp.mockClear();
  updateMonetizationSettings.mockClear();
  deleteAppWithCleanup.mockClear();
  requireUserOrApiKeyWithOrg.mockClear();
});

// ===========================================================================
// CREATE — POST /api/v1/apps
// ===========================================================================

describe("POST /api/v1/apps (create)", () => {
  test("401 when no auth", async () => {
    const { status, json } = await req("POST", "/api/v1/apps", {
      body: VALID_CREATE,
    });
    expect(status).toBe(401);
    expect(json.success).toBe(false);
  });

  test("400 invalid app_url", async () => {
    const { status, json } = await req("POST", "/api/v1/apps", {
      key: KEY_A,
      body: { name: "Bad", app_url: "not-a-url" },
    });
    expect(status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toBe("Invalid request data");
    expect(json.details).toBeDefined();
  });

  test("400 missing required name", async () => {
    const { status, json } = await req("POST", "/api/v1/apps", {
      key: KEY_A,
      body: { app_url: "https://x.example.com" },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("Invalid request data");
  });

  test("409 duplicate name → conflictType + suggestedName", async () => {
    seed({ name: "My Cool App", slug: "my-cool-app", organization_id: ORG_A });
    const { status, json } = await req("POST", "/api/v1/apps", {
      key: KEY_A,
      body: VALID_CREATE,
    });
    expect(status).toBe(409);
    expect(json.success).toBe(false);
    expect(json.conflictType).toBe("app");
    expect(json.suggestedName).toBe("My Cool App-a1b2");
  });

  test("429 when the organization app creation cap is reached", async () => {
    createAppLimit = 1;
    seed({ name: "Existing", slug: "existing", organization_id: ORG_A });

    const { status, json } = await req("POST", "/api/v1/apps", {
      key: KEY_A,
      body: { ...VALID_CREATE, name: "Second App" },
    });

    expect(status).toBe(429);
    expect(json.success).toBe(false);
    expect(json.code).toBe("app_creation_limit_reached");
    expect(json.limit).toBe(1);
    expect(
      [...store.values()].filter((a) => a.organization_id === ORG_A),
    ).toHaveLength(1);
  });

  test("200 happy path defaults to no GitHub repo", async () => {
    const { status, json } = await req("POST", "/api/v1/apps", {
      key: KEY_A,
      body: VALID_CREATE,
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    const created = json.app as App;
    expect(created.name).toBe("My Cool App");
    expect(created.organization_id).toBe(ORG_A);
    expect(typeof json.apiKey).toBe("string");
    expect(json.apiKey as string).toMatch(/^eliza_/);
    expect(json.githubRepo).toBeUndefined();
    expect(createApp.mock.calls[0][1]).toMatchObject({
      createGitHubRepo: false,
    });
    // Persisted: a follow-up list sees it.
    const list = await req("GET", "/api/v1/apps", { key: KEY_A });
    expect((list.json.apps as App[]).map((a) => a.id)).toContain(created.id);
  });

  test("200 skipGitHubRepo:false explicitly creates a GitHub repo", async () => {
    const { status, json } = await req("POST", "/api/v1/apps", {
      key: KEY_A,
      body: {
        ...VALID_CREATE,
        name: "Repo App",
        skipGitHubRepo: false,
      },
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.githubRepo).toBe("elizaOS-apps/repo-app");
    expect(createApp.mock.calls[0][1]).toMatchObject({
      createGitHubRepo: true,
    });
  });

  test("200 skipGitHubRepo:true → no githubRepo in response", async () => {
    const { status, json } = await req("POST", "/api/v1/apps", {
      key: KEY_A,
      body: { ...VALID_CREATE, name: "No Repo App", skipGitHubRepo: true },
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.githubRepo).toBeUndefined();
    expect(createApp.mock.calls[0][1]).toMatchObject({
      createGitHubRepo: false,
    });
  });

  test("200 create-time monetization enablement is downgraded: app created, monetization off, review warning", async () => {
    const { status, json } = await req("POST", "/api/v1/apps", {
      key: KEY_A,
      body: {
        ...VALID_CREATE,
        name: "Metered App",
        monetization_enabled: true,
        inference_markup_percentage: 25,
      },
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(createApp).toHaveBeenCalledTimes(1);
    // Fail-closed: the requested enable is never honored at create time; the
    // pricing default persists so approval needs no re-entry.
    expect(updateMonetizationSettings).toHaveBeenCalledTimes(1);
    expect(updateMonetizationSettings.mock.calls[0][1]).toMatchObject({
      monetizationEnabled: false,
      inferenceMarkupPercentage: 25,
    });
    const returned = json.app as App;
    expect(returned.monetization_enabled).toBe(false);
    expect(returned.inference_markup_percentage).toBe(25);
    expect(returned.review_status).toBe("draft");
    // The review requirement is surfaced instead of a dead 403 (#11863).
    const warnings = json.warnings as string[];
    expect(warnings.some((w) => w.includes("review"))).toBe(true);
    expect(warnings.some((w) => w.includes("monetization disabled"))).toBe(
      true,
    );
  });

  test("200 with create-time pricing defaults persisted while disabled", async () => {
    const { status, json } = await req("POST", "/api/v1/apps", {
      key: KEY_A,
      body: {
        ...VALID_CREATE,
        name: "Priced Draft App",
        monetization_enabled: false,
        inference_markup_percentage: 25,
      },
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(updateMonetizationSettings).toHaveBeenCalledTimes(1);
    expect(updateMonetizationSettings.mock.calls[0][1]).toMatchObject({
      monetizationEnabled: false,
      inferenceMarkupPercentage: 25,
    });
    // Returned app reflects the monetization write (route re-reads via getById).
    const returned = json.app as App;
    expect(returned.monetization_enabled).toBe(false);
    expect(returned.inference_markup_percentage).toBe(25);
  });
});

// ===========================================================================
// LIST — GET /api/v1/apps
// ===========================================================================

describe("GET /api/v1/apps (list)", () => {
  test("401 when no auth", async () => {
    const { status } = await req("GET", "/api/v1/apps");
    expect(status).toBe(401);
  });

  test("200 array including a created app", async () => {
    const a = seed({
      organization_id: ORG_A,
      name: "App One",
      slug: "app-one",
    });
    const { status, json } = await req("GET", "/api/v1/apps", { key: KEY_A });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    const apps = json.apps as App[];
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.map((x) => x.id)).toContain(a.id);
  });

  test("200 empty list", async () => {
    const { status, json } = await req("GET", "/api/v1/apps", { key: KEY_A });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.apps).toEqual([]);
  });

  test("org isolation — only this org's apps", async () => {
    seed({ organization_id: ORG_A, name: "A App", slug: "a-app" });
    seed({ organization_id: ORG_B, name: "B App", slug: "b-app" });
    const { json } = await req("GET", "/api/v1/apps", { key: KEY_A });
    const apps = json.apps as App[];
    expect(apps).toHaveLength(1);
    expect(apps[0].organization_id).toBe(ORG_A);
  });
});

// ===========================================================================
// GET — GET /api/v1/apps/:id
// ===========================================================================

describe("GET /api/v1/apps/:id (get)", () => {
  test("401 when no auth", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status } = await req("GET", `/api/v1/apps/${a.id}`);
    expect(status).toBe(401);
  });

  test("404 not found", async () => {
    const { status, json } = await req("GET", `/api/v1/apps/${freshUuid()}`, {
      key: KEY_A,
    });
    expect(status).toBe(404);
    expect(json.error).toBe("App not found");
  });

  test("403 cross-org", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status, json } = await req("GET", `/api/v1/apps/${a.id}`, {
      key: KEY_B,
    });
    expect(status).toBe(403);
    expect(json.error).toBe("Access denied");
  });

  test("200 full detail", async () => {
    const a = seed({
      organization_id: ORG_A,
      name: "Detail App",
      slug: "detail-app",
    });
    const { status, json } = await req("GET", `/api/v1/apps/${a.id}`, {
      key: KEY_A,
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect((json.app as App).id).toBe(a.id);
    expect((json.app as App).name).toBe("Detail App");
  });
});

// ===========================================================================
// UPDATE — PUT + PATCH /api/v1/apps/:id
// ===========================================================================

describe("PUT /api/v1/apps/:id (update)", () => {
  test("401 when no auth", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status } = await req("PUT", `/api/v1/apps/${a.id}`, {
      body: { name: "X" },
    });
    expect(status).toBe(401);
  });

  test("400 invalid contact_email", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status, json } = await req("PUT", `/api/v1/apps/${a.id}`, {
      key: KEY_A,
      body: { contact_email: "not-an-email" },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("Invalid request data");
  });

  test("400 invalid website_url", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status, json } = await req("PUT", `/api/v1/apps/${a.id}`, {
      key: KEY_A,
      body: { website_url: "ftp:::bad" },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("Invalid request data");
  });

  test("400 more than 4 linked_character_ids", async () => {
    const a = seed({ organization_id: ORG_A });
    const five = Array.from({ length: 5 }, () => freshUuid());
    const { status, json } = await req("PUT", `/api/v1/apps/${a.id}`, {
      key: KEY_A,
      body: { linked_character_ids: five },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("Invalid request data");
  });

  test("404 not found", async () => {
    const { status } = await req("PUT", `/api/v1/apps/${freshUuid()}`, {
      key: KEY_A,
      body: { name: "X" },
    });
    expect(status).toBe(404);
  });

  test("403 cross-org", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status, json } = await req("PUT", `/api/v1/apps/${a.id}`, {
      key: KEY_B,
      body: { name: "X" },
    });
    expect(status).toBe(403);
    expect(json.error).toBe("Access denied");
  });

  test("200 name/description/allowed_origins/linked_character_ids update", async () => {
    const a = seed({ organization_id: ORG_A });
    const chars = [freshUuid(), freshUuid()];
    const { status, json } = await req("PUT", `/api/v1/apps/${a.id}`, {
      key: KEY_A,
      body: {
        name: "Renamed",
        description: "new desc",
        allowed_origins: ["https://a.example.com", "https://b.example.com"],
        linked_character_ids: chars,
      },
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    const updated = json.app as App;
    expect(updated.name).toBe("Renamed");
    expect(updated.description).toBe("new desc");
    expect(updated.allowed_origins).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(updated.linked_character_ids).toEqual(chars);
  });

  test("200 empty-string clears optional fields → null", async () => {
    const a = seed({
      organization_id: ORG_A,
      website_url: "https://old.example.com",
      contact_email: "old@example.com",
      logo_url: "https://old.example.com/logo.png",
    });
    const { status, json } = await req("PUT", `/api/v1/apps/${a.id}`, {
      key: KEY_A,
      body: { website_url: "", contact_email: "", logo_url: "" },
    });
    expect(status).toBe(200);
    const updated = json.app as App;
    expect(updated.website_url).toBeNull();
    expect(updated.contact_email).toBeNull();
    expect(updated.logo_url).toBeNull();
  });
});

describe("PATCH /api/v1/apps/:id (update)", () => {
  test("401 when no auth", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status } = await req("PATCH", `/api/v1/apps/${a.id}`, {
      body: { name: "X" },
    });
    expect(status).toBe(401);
  });

  test("404 not found", async () => {
    const { status } = await req("PATCH", `/api/v1/apps/${freshUuid()}`, {
      key: KEY_A,
      body: { name: "X" },
    });
    expect(status).toBe(404);
  });

  test("403 cross-org", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status } = await req("PATCH", `/api/v1/apps/${a.id}`, {
      key: KEY_B,
      body: { name: "X" },
    });
    expect(status).toBe(403);
  });

  test("400 invalid app_url", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status } = await req("PATCH", `/api/v1/apps/${a.id}`, {
      key: KEY_A,
      body: { app_url: "nope" },
    });
    expect(status).toBe(400);
  });

  test("200 partial description patch", async () => {
    const a = seed({ organization_id: ORG_A, description: "before" });
    const { status, json } = await req("PATCH", `/api/v1/apps/${a.id}`, {
      key: KEY_A,
      body: { description: "after" },
    });
    expect(status).toBe(200);
    expect((json.app as App).description).toBe("after");
    // Other fields untouched.
    expect((json.app as App).name).toBe(a.name);
  });
});

// ===========================================================================
// DELETE — DELETE /api/v1/apps/:id
// ===========================================================================

describe("DELETE /api/v1/apps/:id (delete)", () => {
  test("401 when no auth", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status } = await req("DELETE", `/api/v1/apps/${a.id}`);
    expect(status).toBe(401);
  });

  test("404 not found", async () => {
    const { status } = await req("DELETE", `/api/v1/apps/${freshUuid()}`, {
      key: KEY_A,
    });
    expect(status).toBe(404);
  });

  test("403 cross-org", async () => {
    const a = seed({ organization_id: ORG_A });
    const { status, json } = await req("DELETE", `/api/v1/apps/${a.id}`, {
      key: KEY_B,
    });
    expect(status).toBe(403);
    expect(json.error).toBe("Access denied");
  });

  test("200 happy → cleaned, then follow-up GET → 404", async () => {
    const a = seed({
      organization_id: ORG_A,
      github_repo: "elizaOS-apps/del-app",
    });
    const del = await req("DELETE", `/api/v1/apps/${a.id}`, { key: KEY_A });
    expect(del.status).toBe(200);
    expect(del.json.success).toBe(true);
    expect(del.json.message).toBe(
      "App deleted successfully with all resources cleaned up",
    );
    expect(
      (del.json.cleaned as { githubRepoDeleted: boolean }).githubRepoDeleted,
    ).toBe(true);
    expect(del.json.errors).toBeUndefined();

    const get = await req("GET", `/api/v1/apps/${a.id}`, { key: KEY_A });
    expect(get.status).toBe(404);
  });

  test("200 deleteGitHubRepo=false honored", async () => {
    const a = seed({
      organization_id: ORG_A,
      github_repo: "elizaOS-apps/keep-repo",
    });
    const del = await req(
      "DELETE",
      `/api/v1/apps/${a.id}?deleteGitHubRepo=false`,
      {
        key: KEY_A,
      },
    );
    expect(del.status).toBe(200);
    expect(deleteAppWithCleanup.mock.calls[0][1]).toMatchObject({
      deleteGitHubRepo: false,
    });
    expect(
      (del.json.cleaned as { githubRepoDeleted: boolean }).githubRepoDeleted,
    ).toBe(false);
  });

  test("200 partial-cleanup-errors shape", async () => {
    const a = seed({ organization_id: ORG_A });
    cleanupErrors = ["Failed to delete GitHub repo: 404"];
    const del = await req("DELETE", `/api/v1/apps/${a.id}`, { key: KEY_A });
    expect(del.status).toBe(200);
    expect(del.json.success).toBe(false);
    expect(del.json.message).toBe("App deleted with some cleanup errors");
    expect(del.json.errors).toEqual(["Failed to delete GitHub repo: 404"]);
  });
});

// ===========================================================================
// CHECK-NAME — POST /api/v1/apps/check-name
// ===========================================================================

describe("POST /api/v1/apps/check-name", () => {
  test("401 when no auth", async () => {
    const { status } = await req("POST", "/api/v1/apps/check-name", {
      body: { name: "Whatever" },
    });
    expect(status).toBe(401);
  });

  test("400 invalid (empty name)", async () => {
    const { status, json } = await req("POST", "/api/v1/apps/check-name", {
      key: KEY_A,
      body: { name: "" },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("Invalid request data");
    expect(json.details).toBeDefined();
  });

  test("200 available → available:true + slug", async () => {
    const { status, json } = await req("POST", "/api/v1/apps/check-name", {
      key: KEY_A,
      body: { name: "Totally Fresh Name" },
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.available).toBe(true);
    expect(json.slug).toBe("totally-fresh-name");
  });

  test("200 unavailable → available:false + conflictType + suggestedName", async () => {
    seed({ organization_id: ORG_A, name: "Taken Name", slug: "taken-name" });
    const { status, json } = await req("POST", "/api/v1/apps/check-name", {
      key: KEY_A,
      body: { name: "Taken Name" },
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.available).toBe(false);
    expect(json.conflictType).toBe("app");
    expect(json.suggestedName).toBe("Taken Name-a1b2");
  });
});
