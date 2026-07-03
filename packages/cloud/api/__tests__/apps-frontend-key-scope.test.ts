/**
 * Route-level per-app API-key scope guard for the managed-frontend, review and
 * backup route families (#10852 follow-up).
 *
 * The #10852 guard (`isAppKeyOutOfScope`) was applied on ~24 `/apps/[id]/*`
 * routes (deploy, monetization, earnings, domains, charges, chat, …) but was
 * MISSING on the frontend hosting routes (publish / activate-rollback /
 * delete / preview), review submission, and the config-backup export — all of
 * which gated only on `organization_id`. Within one org, App A's app-scoped
 * key could overwrite/rollback/delete App B's live frontend, submit B for
 * review, or export B's config.
 *
 * These tests drive the REAL routes and the REAL `isAppKeyOutOfScope`
 * implementation (only `appsService` and the side-effect collaborators are
 * mocked), asserting the exact acceptance criteria of the fix:
 *   - app A's key on app B  → 403, side effect NOT invoked
 *   - the app's OWN key     → allowed
 *   - session auth (no key) → allowed (unchanged full org access)
 *   - a normal org key (claimed by no app) → allowed (unchanged)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import { Hono } from "hono";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const APP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_A = "kkkkkkkk-aaaa-4aaa-8aaa-000000000001";
const KEY_B = "kkkkkkkk-bbbb-4bbb-8bbb-000000000002";
const KEY_ORG = "kkkkkkkk-0000-4000-8000-00000000000f";
const DEPLOYMENT = "dddddddd-dddd-4ddd-8ddd-000000000001";

/** Both apps live in the SAME org — the whole point of the guard. */
const APPS: Record<
  string,
  { id: string; organization_id: string; api_key_id: string | null } & Record<
    string,
    unknown
  >
> = {
  [APP_A]: {
    id: APP_A,
    name: "app-a",
    organization_id: ORG,
    api_key_id: KEY_A,
  },
  [APP_B]: {
    id: APP_B,
    name: "app-b",
    organization_id: ORG,
    api_key_id: KEY_B,
    review_status: "pending",
    reviewed_at: null,
  },
};

/** `undefined` = session auth; otherwise the API key id the caller presented. */
let currentApiKeyId: string | undefined;

// Real production behavior: requireUserOrApiKeyWithOrg sets `apiKeyId` on the
// Hono context when the credential was an API key (workers-hono-auth.ts).
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async (c: Context) => {
    if (currentApiKeyId) c.set("apiKeyId", currentApiKeyId);
    return { id: USER, organization_id: ORG };
  },
}));

// The review route authenticates from the raw Request and reads `apiKey?.id`
// off the result instead (same shape the monetization routes use).
mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: USER, organization_id: ORG },
    apiKey: currentApiKeyId ? { id: currentApiKeyId } : undefined,
    authMethod: currentApiKeyId ? "api_key" : "session",
  }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { CRITICAL: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

// NOTE: `@/lib/auth/app-key-scope` is intentionally NOT mocked — the real
// guard runs, resolving key ownership through this appsService seam (its
// dynamic `import("../services/apps")` resolves to this same module).
const getByApiKeyId = mock(
  async (apiKeyId: string) =>
    Object.values(APPS).find((a) => a.api_key_id === apiKeyId) ?? null,
);
mock.module("@/lib/services/apps", () => ({
  appsService: {
    getById: async (id: string) => APPS[id] ?? null,
    getByApiKeyId,
    trackPageView: mock(async () => undefined),
  },
}));

const deployBundle = mock(async () => ({
  id: DEPLOYMENT,
  app_id: APP_B,
  version: 2,
  status: "active",
  file_count: 1,
  total_bytes: 42,
}));
const activate = mock(async () => ({
  id: DEPLOYMENT,
  app_id: APP_B,
  version: 1,
  status: "active",
}));
const deleteArtifacts = mock(async () => undefined);
mock.module("@/lib/services/app-frontend-hosting", () => ({
  appFrontendHostingService: {
    deployBundle,
    activate,
    deleteArtifacts,
    renderFrontendResponse: mock(async () => ({
      response: new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      }),
      isDocument: true,
    })),
  },
}));

const repoDelete = mock(async () => undefined);
mock.module("@/db/repositories/app-frontend-deployments", () => ({
  appFrontendDeploymentsRepository: {
    listByApp: mock(async () => []),
    getActive: mock(async () => ({
      id: DEPLOYMENT,
      app_id: APP_B,
      status: "active",
      version: 1,
    })),
    getByIdForApp: mock(async () => ({
      id: DEPLOYMENT,
      app_id: APP_B,
      status: "superseded",
      version: 1,
    })),
    delete: repoDelete,
  },
}));

const exportApp = mock(async () => ({ name: "app-b", config: {} }));
mock.module("@/lib/services/app-backup", () => ({
  appBackupService: { exportApp },
}));

const runAppReview = mock(async () => ({
  disposition: "allow",
  matched_categories: [],
  rationale: "ok",
  rubric_version: "v1",
  model: "test",
  created_at: new Date().toISOString(),
}));
mock.module("@/lib/services/app-review", () => ({
  runAppReview,
  getLatestAppReview: mock(async () => null),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

const { default: frontendRoute } = await import(
  "../v1/apps/[id]/frontend/route"
);
const { default: previewRoute } = await import(
  "../v1/apps/[id]/frontend/preview/[[...path]]/route"
);
const { default: deploymentRoute } = await import(
  "../v1/apps/[id]/frontend/[deploymentId]/route"
);
const { default: activateRoute } = await import(
  "../v1/apps/[id]/frontend/[deploymentId]/activate/route"
);
const { default: reviewRoute } = await import("../v1/apps/[id]/review/route");
const { default: backupRoute } = await import("../v1/apps/[id]/backup/route");

const app = new Hono();
app.route("/api/v1/apps/:id/frontend", frontendRoute);
app.route("/api/v1/apps/:id/frontend/preview", previewRoute);
app.route("/api/v1/apps/:id/frontend/:deploymentId/activate", activateRoute);
app.route("/api/v1/apps/:id/frontend/:deploymentId", deploymentRoute);
app.route("/api/v1/apps/:id/review", reviewRoute);
app.route("/api/v1/apps/:id/backup", backupRoute);

function publishBody(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      files: [{ path: "index.html", content: "<html></html>" }],
      activate: true,
    }),
  };
}

async function expectAccessDenied(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as { success: boolean; error: string };
  expect(body).toEqual({ success: false, error: "Access denied" });
}

beforeEach(() => {
  currentApiKeyId = undefined;
  deployBundle.mockClear();
  activate.mockClear();
  deleteArtifacts.mockClear();
  repoDelete.mockClear();
  exportApp.mockClear();
  runAppReview.mockClear();
  getByApiKeyId.mockClear();
});

describe("frontend publish — POST /api/v1/apps/:id/frontend (#10852 gap)", () => {
  test("app A's key on app B's frontend → 403, nothing published", async () => {
    currentApiKeyId = KEY_A;
    const res = await app.request(
      `/api/v1/apps/${APP_B}/frontend`,
      publishBody(),
    );
    await expectAccessDenied(res);
    expect(deployBundle).not.toHaveBeenCalled();
  });

  test("the app's OWN key → publish allowed", async () => {
    currentApiKeyId = KEY_B;
    const res = await app.request(
      `/api/v1/apps/${APP_B}/frontend`,
      publishBody(),
    );
    expect(res.status).toBe(201);
    expect(deployBundle).toHaveBeenCalledTimes(1);
  });

  test("full org user (session, no apiKeyId) → publish allowed", async () => {
    currentApiKeyId = undefined;
    const res = await app.request(
      `/api/v1/apps/${APP_B}/frontend`,
      publishBody(),
    );
    expect(res.status).toBe(201);
    expect(deployBundle).toHaveBeenCalledTimes(1);
    // Session auth short-circuits before any key-ownership lookup.
    expect(getByApiKeyId).not.toHaveBeenCalled();
  });

  test("normal org key (claimed by no app) → publish allowed (org access unchanged)", async () => {
    currentApiKeyId = KEY_ORG;
    const res = await app.request(
      `/api/v1/apps/${APP_B}/frontend`,
      publishBody(),
    );
    expect(res.status).toBe(201);
    expect(deployBundle).toHaveBeenCalledTimes(1);
  });

  test("cross-app key is also denied on the deployment list (GET)", async () => {
    currentApiKeyId = KEY_A;
    const res = await app.request(`/api/v1/apps/${APP_B}/frontend`);
    await expectAccessDenied(res);
  });
});

describe("frontend activate (rollback) — POST .../frontend/:deploymentId/activate", () => {
  test("app A's key rolling back app B → 403, not activated", async () => {
    currentApiKeyId = KEY_A;
    const res = await app.request(
      `/api/v1/apps/${APP_B}/frontend/${DEPLOYMENT}/activate`,
      { method: "POST" },
    );
    await expectAccessDenied(res);
    expect(activate).not.toHaveBeenCalled();
  });

  test("own key → rollback allowed", async () => {
    currentApiKeyId = KEY_B;
    const res = await app.request(
      `/api/v1/apps/${APP_B}/frontend/${DEPLOYMENT}/activate`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe("frontend deployment delete — DELETE .../frontend/:deploymentId", () => {
  test("app A's key deleting app B's deployment → 403, nothing deleted", async () => {
    currentApiKeyId = KEY_A;
    const res = await app.request(
      `/api/v1/apps/${APP_B}/frontend/${DEPLOYMENT}`,
      { method: "DELETE" },
    );
    await expectAccessDenied(res);
    expect(deleteArtifacts).not.toHaveBeenCalled();
    expect(repoDelete).not.toHaveBeenCalled();
  });

  test("cross-app key is also denied on deployment detail (GET)", async () => {
    currentApiKeyId = KEY_A;
    const res = await app.request(
      `/api/v1/apps/${APP_B}/frontend/${DEPLOYMENT}`,
    );
    await expectAccessDenied(res);
  });
});

describe("frontend preview — GET .../frontend/preview", () => {
  test("app A's key previewing app B's site → 403", async () => {
    currentApiKeyId = KEY_A;
    const res = await app.request(`/api/v1/apps/${APP_B}/frontend/preview`);
    await expectAccessDenied(res);
  });
});

describe("review submission — POST /api/v1/apps/:id/review", () => {
  test("app A's key submitting app B for review → 403, classifier not run", async () => {
    currentApiKeyId = KEY_A;
    const res = await app.request(`/api/v1/apps/${APP_B}/review`, {
      method: "POST",
    });
    await expectAccessDenied(res);
    expect(runAppReview).not.toHaveBeenCalled();
  });

  test("own key → review submission allowed", async () => {
    currentApiKeyId = KEY_B;
    const res = await app.request(`/api/v1/apps/${APP_B}/review`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(runAppReview).toHaveBeenCalledTimes(1);
  });

  test("cross-app key is also denied on review status (GET)", async () => {
    currentApiKeyId = KEY_A;
    const res = await app.request(`/api/v1/apps/${APP_B}/review`);
    await expectAccessDenied(res);
  });
});

describe("config backup export — GET /api/v1/apps/:id/backup", () => {
  test("app A's key exporting app B's config → 403, nothing exported", async () => {
    currentApiKeyId = KEY_A;
    const res = await app.request(`/api/v1/apps/${APP_B}/backup`);
    await expectAccessDenied(res);
    expect(exportApp).not.toHaveBeenCalled();
  });

  test("own key → export allowed", async () => {
    currentApiKeyId = KEY_B;
    const res = await app.request(`/api/v1/apps/${APP_B}/backup`);
    expect(res.status).toBe(200);
    expect(exportApp).toHaveBeenCalledTimes(1);
  });

  test("session auth → export allowed", async () => {
    currentApiKeyId = undefined;
    const res = await app.request(`/api/v1/apps/${APP_B}/backup`);
    expect(res.status).toBe(200);
    expect(exportApp).toHaveBeenCalledTimes(1);
  });
});
