/**
 * Group I — Apps CRUD lifecycle (live e2e).
 *
 * Exercises the full app lifecycle against a running Worker:
 *
 *   POST   /api/v1/apps              — create
 *   GET    /api/v1/apps              — list
 *   GET    /api/v1/apps/:id          — detail
 *   PUT    /api/v1/apps/:id          — replace fields
 *   PATCH  /api/v1/apps/:id          — partial update
 *   DELETE /api/v1/apps/:id          — full cleanup + delete
 *   POST   /api/v1/apps/check-name   — name availability
 *
 * Route handlers under test:
 *   packages/cloud/api/v1/apps/route.ts
 *   packages/cloud/api/v1/apps/[id]/route.ts
 *   packages/cloud/api/v1/apps/check-name/route.ts
 *
 * Mirrors the gate/cleanup shape of group-l-app-charges: a `serverReachable`
 * probe, a `hasTestApiKey` flag, a `describeE2E` skip gate, a `createTestApp()`
 * helper that POSTs with `skipGitHubRepo: true`, a `createdAppIds[]` ledger, and
 * an `afterAll` that DELETEs each created app with `?deleteGitHubRepo=false`.
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker (or no
 * bootstrapped TEST_API_KEY) every test in this file reports as a counted,
 * named `skip` — never a silent pass. Cross-org tests additionally skip
 * loudly when TEST_MEMBER_API_KEY is absent.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  getBaseUrl,
  isServerReachable,
  memberBearerHeaders,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
const hasMemberApiKey = Boolean(process.env.TEST_MEMBER_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-i-apps-lifecycle] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-i-apps-lifecycle] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Tests will SKIP.",
  );
}
if (!hasMemberApiKey) {
  console.warn(
    "[group-i-apps-lifecycle] TEST_MEMBER_API_KEY is not set; cross-org " +
      "tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);
// Cross-org assertions need the seeded member key; loud skip otherwise.
const testCrossOrg = test.skipIf(
  !serverReachable || !hasTestApiKey || !hasMemberApiKey,
);

const createdAppIds: string[] = [];

// A syntactically valid UUID that should never resolve to a real app.
const MISSING_UUID = "00000000-0000-4000-8000-0000000000ff";

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface AppDto {
  id?: string;
  name?: string;
  description?: string;
  slug?: string;
  organization_id?: string;
  app_url?: string;
  website_url?: string | null;
  contact_email?: string | null;
  logo_url?: string | null;
  allowed_origins?: string[];
  linked_character_ids?: string[] | null;
  monetization_enabled?: boolean;
  inference_markup_percentage?: number | null;
  is_active?: boolean;
}

interface CreateAppResponse {
  success?: boolean;
  app?: AppDto;
  apiKey?: string;
  warnings?: string[];
}

interface GetAppResponse {
  success?: boolean;
  app?: AppDto;
}

interface ListAppsResponse {
  success?: boolean;
  apps?: AppDto[];
}

async function createTestApp(
  overrides: Record<string, unknown> = {},
): Promise<AppDto> {
  const res = await api.post(
    "/api/v1/apps",
    {
      name: uniqueName("Lifecycle App"),
      description: "App CRUD lifecycle regression test",
      app_url: "https://example.com/app",
      website_url: "https://example.com",
      allowed_origins: ["https://example.com"],
      skipGitHubRepo: true,
      ...overrides,
    },
    { headers: bearerHeaders() },
  );

  expect(res.status).toBe(200);
  const body = (await res.json()) as CreateAppResponse;
  expect(body.success).toBe(true);
  expect(body.app?.id).toBeTruthy();
  createdAppIds.push(body.app?.id as string);
  return body.app as AppDto;
}

async function getApp(id: string): Promise<AppDto | undefined> {
  const res = await api.get(`/api/v1/apps/${id}`, { headers: bearerHeaders() });
  expect(res.status).toBe(200);
  return ((await res.json()) as GetAppResponse).app;
}

const createdCharacterIds: string[] = [];

/**
 * Creates a real character owned by the test user. linked_character_ids on
 * PUT /api/v1/apps/:id enforces the character ownership guard (#10863), so
 * link targets must exist and be owned/public — made-up UUIDs 404.
 */
async function createTestCharacter(): Promise<string> {
  const res = await api.post(
    "/api/my-agents/characters",
    { name: uniqueName("Linked Character"), bio: ["app-link e2e fixture"] },
    { headers: bearerHeaders() },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id?: string };
  expect(body.id).toBeTruthy();
  createdCharacterIds.push(body.id as string);
  return body.id as string;
}

afterAll(async () => {
  if (!serverReachable || !hasTestApiKey) return;
  for (const appId of createdAppIds) {
    await api.delete(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
      headers: bearerHeaders(),
    });
  }
  for (const characterId of createdCharacterIds) {
    await api.delete(`/api/my-agents/characters/${characterId}`, {
      headers: bearerHeaders(),
    });
  }
});

// -------- POST /api/v1/apps (create) ---------------------------------------

describeE2E("POST /api/v1/apps", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.post("/api/v1/apps", {
      name: uniqueName("No Auth"),
      app_url: "https://example.com/app",
      skipGitHubRepo: true,
    });
    expect(res.status).toBe(401);
  });

  test("validation: 400 for an invalid app_url", async () => {
    const res = await api.post(
      "/api/v1/apps",
      {
        name: uniqueName("Bad URL"),
        app_url: "not-a-url",
        skipGitHubRepo: true,
      },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request data");
  });

  test("conflict: 409 with conflictType + suggestedName for a duplicate name", async () => {
    const created = await createTestApp();
    const dupeName = created.name as string;

    const res = await api.post(
      "/api/v1/apps",
      {
        name: dupeName,
        app_url: "https://example.com/app",
        skipGitHubRepo: true,
      },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      success?: boolean;
      error?: string;
      conflictType?: string;
      suggestedName?: string;
    };
    expect(body.success).toBe(false);
    expect(["app", "subdomain"]).toContain(body.conflictType ?? "");
    expect(typeof body.suggestedName).toBe("string");
    expect(body.suggestedName?.startsWith(dupeName)).toBe(true);
  });

  test("happy path: returns success + app + an eliza_ apiKey", async () => {
    const name = uniqueName("Full Fields App");
    const res = await api.post(
      "/api/v1/apps",
      {
        name,
        description: "Full-fields create",
        app_url: "https://example.com/app",
        website_url: "https://example.com",
        contact_email: "owner@example.com",
        logo_url: "https://example.com/logo.png",
        allowed_origins: ["https://example.com", "https://app.example.com"],
        skipGitHubRepo: true,
      },
      { headers: bearerHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CreateAppResponse;
    expect(body.success).toBe(true);
    expect(body.app?.id).toBeTruthy();
    expect(body.app?.name).toBe(name);
    expect(body.app?.description).toBe("Full-fields create");
    expect(body.app?.app_url).toBe("https://example.com/app");
    expect(body.app?.website_url).toBe("https://example.com");
    expect(body.app?.contact_email).toBe("owner@example.com");
    expect(body.app?.logo_url).toBe("https://example.com/logo.png");
    expect(body.app?.allowed_origins).toEqual([
      "https://example.com",
      "https://app.example.com",
    ]);
    expect(body.app?.slug).toBeTruthy();
    expect(typeof body.apiKey).toBe("string");
    expect(body.apiKey?.startsWith("eliza_")).toBe(true);

    if (body.app?.id) createdAppIds.push(body.app.id);
  });

  test("monetization: create-time enable is downgraded to disabled + review warning", async () => {
    const res = await api.post(
      "/api/v1/apps",
      {
        name: uniqueName("Create-Time Monetization Downgraded"),
        description: "App CRUD lifecycle regression test",
        app_url: "https://example.com/app",
        website_url: "https://example.com",
        allowed_origins: ["https://example.com"],
        skipGitHubRepo: true,
        monetization_enabled: true,
        inference_markup_percentage: 25,
      },
      { headers: bearerHeaders() },
    );
    // The app is created (no dead 403 — #11863); monetization stays off until
    // the app passes review, and the review path is surfaced as a warning.
    expect(res.status).toBe(200);
    const body = (await res.json()) as CreateAppResponse & {
      app?: AppDto & { review_status?: string };
    };
    expect(body.success).toBe(true);
    expect(body.app?.monetization_enabled).toBe(false);
    expect(body.app?.review_status).toBe("draft");
    expect(body.warnings?.some((w) => w.includes("review"))).toBe(true);
    if (body.app?.id) createdAppIds.push(body.app.id);

    const fetched = await getApp(body.app?.id as string);
    expect(fetched?.monetization_enabled).toBe(false);
    expect(Number(fetched?.inference_markup_percentage)).toBe(25);
  });

  test("monetization: create-time pricing defaults persist while disabled", async () => {
    const app = await createTestApp({
      monetization_enabled: false,
      inference_markup_percentage: 25,
    });

    const fetched = await getApp(app.id as string);
    expect(fetched?.monetization_enabled).toBe(false);
    expect(Number(fetched?.inference_markup_percentage)).toBe(25);
  });
});

// -------- GET /api/v1/apps (list) ------------------------------------------

describeE2E("GET /api/v1/apps", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.get("/api/v1/apps");
    expect(res.status).toBe(401);
  });

  test("happy path: returns the org's apps including a freshly created one", async () => {
    const created = await createTestApp();

    const res = await api.get("/api/v1/apps", { headers: bearerHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAppsResponse;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.apps)).toBe(true);
    const found = body.apps?.find((entry) => entry.id === created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe(created.name);
  });

  testCrossOrg(
    "org isolation: a member-org key does not see this org's app",
    async () => {
      const created = await createTestApp();

      const res = await api.get("/api/v1/apps", {
        headers: memberBearerHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListAppsResponse;
      const leaked = body.apps?.find((entry) => entry.id === created.id);
      expect(leaked).toBeUndefined();
    },
  );
});

// -------- GET /api/v1/apps/:id (detail) ------------------------------------

describeE2E("GET /api/v1/apps/:id", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.get(`/api/v1/apps/${MISSING_UUID}`);
    expect(res.status).toBe(401);
  });

  test("validation: 404 for a non-existent app id", async () => {
    const res = await api.get(`/api/v1/apps/${MISSING_UUID}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("App not found");
  });

  testCrossOrg(
    "cross-org: 403 when a member-org key requests this org's app",
    async () => {
      const created = await createTestApp();

      const res = await api.get(`/api/v1/apps/${created.id}`, {
        headers: memberBearerHeaders(),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Access denied");
    },
  );

  test("happy path: full detail for an owned app", async () => {
    const created = await createTestApp();

    const res = await api.get(`/api/v1/apps/${created.id}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetAppResponse;
    expect(body.success).toBe(true);
    expect(body.app?.id).toBe(created.id);
    expect(body.app?.name).toBe(created.name);
    expect(body.app?.app_url).toBe("https://example.com/app");
    expect(body.app?.organization_id).toBeTruthy();
  });
});

// -------- PUT / PATCH /api/v1/apps/:id (update) ----------------------------

describeE2E("PUT /api/v1/apps/:id", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.put(`/api/v1/apps/${MISSING_UUID}`, {
      description: "x",
    });
    expect(res.status).toBe(401);
  });

  test("validation: 400 for an invalid contact_email", async () => {
    const created = await createTestApp();
    const res = await api.put(
      `/api/v1/apps/${created.id}`,
      { contact_email: "not-an-email" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request data");
  });

  test("validation: 404 for an unknown id", async () => {
    const res = await api.put(
      `/api/v1/apps/${MISSING_UUID}`,
      { description: "x" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });

  testCrossOrg(
    "cross-org: 403 when a member-org key updates this org's app",
    async () => {
      const created = await createTestApp();
      const res = await api.put(
        `/api/v1/apps/${created.id}`,
        { description: "hijack attempt" },
        { headers: memberBearerHeaders() },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.error).toBe("Access denied");
    },
  );

  test("happy path: updates the name", async () => {
    const created = await createTestApp();
    const newName = uniqueName("Renamed App");

    const res = await api.put(
      `/api/v1/apps/${created.id}`,
      { name: newName },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      app?: AppDto;
    };
    expect(body.success).toBe(true);
    expect(body.app?.id).toBe(created.id);
    expect(body.app?.name).toBe(newName);

    const fetched = await getApp(created.id as string);
    expect(fetched?.name).toBe(newName);
  });

  test("happy path: updates allowed_origins", async () => {
    const created = await createTestApp();
    const origins = ["https://a.example.com", "https://b.example.com"];

    const res = await api.put(
      `/api/v1/apps/${created.id}`,
      { allowed_origins: origins },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { app?: AppDto };
    expect(body.app?.allowed_origins).toEqual(origins);

    const fetched = await getApp(created.id as string);
    expect(fetched?.allowed_origins).toEqual(origins);
  });

  test("happy path: sets linked_character_ids to owned characters", async () => {
    const created = await createTestApp();
    // Real, caller-owned characters — the update path enforces ownership, so
    // fabricated UUIDs correctly 404 ("Character not found").
    const characters = [
      await createTestCharacter(),
      await createTestCharacter(),
    ];

    const res = await api.put(
      `/api/v1/apps/${created.id}`,
      { linked_character_ids: characters },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { app?: AppDto };
    expect(body.app?.linked_character_ids).toEqual(characters);

    const fetched = await getApp(created.id as string);
    expect(fetched?.linked_character_ids).toEqual(characters);
  });

  test("ownership guard: 404 when linking a nonexistent character", async () => {
    const created = await createTestApp();

    const res = await api.put(
      `/api/v1/apps/${created.id}`,
      { linked_character_ids: ["00000000-0000-4000-8000-000000000010"] },
      { headers: bearerHeaders() },
    );
    // #10863: linked_character_ids enforces the same existence/ownership guard
    // as PUT /apps/:id/characters — unknown character id → 404.
    expect(res.status).toBe(404);
  });

  test("validation: 400 for more than four linked_character_ids", async () => {
    const created = await createTestApp();
    const tooMany = [
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000023",
      "00000000-0000-4000-8000-000000000024",
    ];

    const res = await api.put(
      `/api/v1/apps/${created.id}`,
      { linked_character_ids: tooMany },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request data");
  });

  test("happy path: an empty-string website_url clears the field to null", async () => {
    const created = await createTestApp({
      website_url: "https://example.com",
    });
    expect((await getApp(created.id as string))?.website_url).toBe(
      "https://example.com",
    );

    const res = await api.put(
      `/api/v1/apps/${created.id}`,
      { website_url: "" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);

    const fetched = await getApp(created.id as string);
    expect(fetched?.website_url).toBeNull();
  });
});

describeE2E("PATCH /api/v1/apps/:id", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.patch(`/api/v1/apps/${MISSING_UUID}`, {
      description: "x",
    });
    expect(res.status).toBe(401);
  });

  test("happy path: partial update of the description", async () => {
    const created = await createTestApp();

    const res = await api.patch(
      `/api/v1/apps/${created.id}`,
      { description: "patched description" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; app?: AppDto };
    expect(body.success).toBe(true);
    expect(body.app?.description).toBe("patched description");
    // The name must be untouched by a partial update.
    expect(body.app?.name).toBe(created.name);

    const fetched = await getApp(created.id as string);
    expect(fetched?.description).toBe("patched description");
  });
});

// -------- DELETE /api/v1/apps/:id ------------------------------------------

describeE2E("DELETE /api/v1/apps/:id", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.delete(`/api/v1/apps/${MISSING_UUID}`);
    expect(res.status).toBe(401);
  });

  test("validation: 404 for an unknown id", async () => {
    const res = await api.delete(`/api/v1/apps/${MISSING_UUID}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });

  testCrossOrg(
    "cross-org: 403 when a member-org key deletes this org's app",
    async () => {
      const created = await createTestApp();
      const res = await api.delete(`/api/v1/apps/${created.id}`, {
        headers: memberBearerHeaders(),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.error).toBe("Access denied");

      // The app must still exist for the owner after the rejected delete.
      expect((await getApp(created.id as string))?.id).toBe(created.id);
    },
  );

  test("happy path: deletes then a follow-up GET is 404", async () => {
    const suffix = uniqueName("Disposable");
    const res = await api.post(
      "/api/v1/apps",
      {
        name: suffix,
        app_url: "https://example.com/app",
        skipGitHubRepo: true,
      },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const appId = ((await res.json()) as CreateAppResponse).app?.id as string;
    expect(appId).toBeTruthy();

    const delRes = await api.delete(
      `/api/v1/apps/${appId}?deleteGitHubRepo=false`,
      { headers: bearerHeaders() },
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as {
      success?: boolean;
      message?: string;
    };
    expect(delBody.success).toBe(true);
    expect(typeof delBody.message).toBe("string");

    const getRes = await api.get(`/api/v1/apps/${appId}`, {
      headers: bearerHeaders(),
    });
    expect(getRes.status).toBe(404);
  });
});

// -------- POST /api/v1/apps/check-name -------------------------------------

describeE2E("POST /api/v1/apps/check-name", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.post("/api/v1/apps/check-name", {
      name: uniqueName("anything"),
    });
    expect(res.status).toBe(401);
  });

  test("happy path: a fresh name is available", async () => {
    const res = await api.post(
      "/api/v1/apps/check-name",
      { name: uniqueName("Fresh Name") },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      available?: boolean;
      slug?: string;
    };
    expect(body.success).toBe(true);
    expect(body.available).toBe(true);
    expect(typeof body.slug).toBe("string");
  });

  test("happy path: a taken name reports unavailable with a conflictType", async () => {
    const created = await createTestApp();

    const res = await api.post(
      "/api/v1/apps/check-name",
      { name: created.name },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      available?: boolean;
      conflictType?: string;
      suggestedName?: string;
    };
    expect(body.success).toBe(true);
    expect(body.available).toBe(false);
    expect(["app", "subdomain"]).toContain(body.conflictType ?? "");
    expect(typeof body.suggestedName).toBe("string");
  });
});

// -------- Full round-trip --------------------------------------------------

describeE2E("Apps lifecycle round-trip", () => {
  test("create → list → get → update → delete → 404", async () => {
    // create
    const created = await createTestApp();
    const appId = created.id as string;

    // appears in list
    const listRes = await api.get("/api/v1/apps", { headers: bearerHeaders() });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as ListAppsResponse;
    expect(listBody.apps?.some((entry) => entry.id === appId)).toBe(true);

    // get matches
    const detail = await getApp(appId);
    expect(detail?.id).toBe(appId);
    expect(detail?.name).toBe(created.name);

    // update changes a field, verified by a follow-up GET
    const renamed = uniqueName("Round Trip Renamed");
    const updateRes = await api.put(
      `/api/v1/apps/${appId}`,
      { name: renamed, description: "round-trip update" },
      { headers: bearerHeaders() },
    );
    expect(updateRes.status).toBe(200);
    const afterUpdate = await getApp(appId);
    expect(afterUpdate?.name).toBe(renamed);
    expect(afterUpdate?.description).toBe("round-trip update");

    // delete
    const delRes = await api.delete(
      `/api/v1/apps/${appId}?deleteGitHubRepo=false`,
      { headers: bearerHeaders() },
    );
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { success?: boolean }).success).toBe(true);

    // GET → 404
    const goneRes = await api.get(`/api/v1/apps/${appId}`, {
      headers: bearerHeaders(),
    });
    expect(goneRes.status).toBe(404);
  });
});
