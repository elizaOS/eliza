/**
 * Press release routes (#11819) - real route handlers + real service + PGlite.
 *
 * The external newswire/provider execution is intentionally not implemented in
 * this slice. These tests prove the API exposes the draft lifecycle while the
 * submit path fails closed unless explicit confirmation is supplied and a
 * provider exists.
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

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { closeDatabaseConnectionsForTests, dbWrite } from "@/db/client";
import { pushSchema } from "@/db/push-schema-for-tests";
import { organizations } from "@/db/schemas/organizations";
import {
  pressCoverage,
  pressMediaContacts,
  pressReleaseDistributions,
  pressReleases,
} from "@/db/schemas/press-releases";
import { users } from "@/db/schemas/users";
import type { AppEnv } from "@/types/cloud-worker-env";

type AuthUser = { id: string; organization_id: string };
let currentAuth: AuthUser = { id: "user-1", organization_id: "org-1" };

const requireUserOrApiKeyWithOrg = mock(async () => currentAuth);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: collectionRoute } = await import("../v1/marketing/pr/route");
const { default: detailRoute } = await import(
  "../v1/marketing/pr/[releaseId]/route"
);
const { default: readyRoute } = await import(
  "../v1/marketing/pr/[releaseId]/ready/route"
);
const { default: submitRoute } = await import(
  "../v1/marketing/pr/[releaseId]/submit/route"
);
const { default: cancelRoute } = await import(
  "../v1/marketing/pr/[releaseId]/cancel/route"
);
const { default: coverageRoute } = await import(
  "../v1/marketing/pr/[releaseId]/coverage/route"
);

const ENV = {
  NODE_ENV: "test",
  MOCK_REDIS: "1",
} as unknown as AppEnv["Bindings"];

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let seq = 0;

function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/marketing/pr/:releaseId/ready", readyRoute);
  app.route("/api/v1/marketing/pr/:releaseId/submit", submitRoute);
  app.route("/api/v1/marketing/pr/:releaseId/cancel", cancelRoute);
  app.route("/api/v1/marketing/pr/:releaseId/coverage", coverageRoute);
  app.route("/api/v1/marketing/pr/:releaseId", detailRoute);
  app.route("/api/v1/marketing/pr", collectionRoute);
  return app;
}

const api = buildApp();

async function seedActor(prefix = "pr") {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: `${prefix} org`, slug: uniq(`${prefix}-org`) })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: uniq(`${prefix}-user`),
      organization_id: org.id,
    })
    .returning();
  return { orgId: org.id, userId: user.id };
}

function asAuth(actor: { orgId: string; userId: string }): AuthUser {
  return { id: actor.userId, organization_id: actor.orgId };
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return api.request(path, init, ENV);
}

async function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
  env: AppEnv["Bindings"] = ENV,
): Promise<Response> {
  return api.request(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

async function createDraft(actor: { orgId: string; userId: string }) {
  currentAuth = asAuth(actor);
  const res = await jsonRequest("/api/v1/marketing/pr", "POST", {
    title: "Eliza Cloud launches press distribution",
    body: "Eliza Cloud now supports a press release workflow.",
    summary: "Launch summary",
    targetRegions: ["US", "US", "EU"],
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as {
    release: { id: string; status: string; target_regions: string[] };
  };
  return json.release;
}

async function countDistributions(releaseId: string): Promise<number> {
  const rows = await dbWrite
    .select()
    .from(pressReleaseDistributions)
    .where(eq(pressReleaseDistributions.press_release_id, releaseId));
  return rows.length;
}

beforeAll(async () => {
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        pressReleases,
        pressReleaseDistributions,
        pressMediaContacts,
        pressCoverage,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[press-release-routes.test] PGlite/pushSchema unavailable.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("press release routes (#11819)", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
  });

  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("create, list, get, update, ready, coverage, and cancel", async () => {
    if (!pgliteReady) return;
    const actor = await seedActor("flow");
    const release = await createDraft(actor);
    expect(release.status).toBe("draft");
    expect(release.target_regions).toEqual(["US", "EU"]);

    const list = await request("/api/v1/marketing/pr");
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { releases: Array<{ id: string }> };
    expect(listed.releases.map((item) => item.id)).toContain(release.id);

    const get = await request(`/api/v1/marketing/pr/${release.id}`);
    expect(get.status).toBe(200);

    const patch = await jsonRequest(
      `/api/v1/marketing/pr/${release.id}`,
      "PATCH",
      {
        summary: "Updated summary",
      },
    );
    expect(patch.status).toBe(200);
    expect(
      ((await patch.json()) as { release: { summary: string } }).release
        .summary,
    ).toBe("Updated summary");

    const ready = await jsonRequest(
      `/api/v1/marketing/pr/${release.id}/ready`,
      "POST",
    );
    expect(ready.status).toBe(200);
    expect(
      ((await ready.json()) as { release: { status: string } }).release.status,
    ).toBe("ready");

    const coverage = await request(
      `/api/v1/marketing/pr/${release.id}/coverage`,
    );
    expect(coverage.status).toBe(200);
    expect(
      ((await coverage.json()) as { coverage: unknown[] }).coverage,
    ).toEqual([]);

    const cancel = await jsonRequest(
      `/api/v1/marketing/pr/${release.id}/cancel`,
      "POST",
    );
    expect(cancel.status).toBe(200);
    expect(
      ((await cancel.json()) as { release: { status: string } }).release.status,
    ).toBe("cancelled");
  });

  test("invalid create returns 400", async () => {
    if (!pgliteReady) return;
    currentAuth = asAuth(await seedActor("invalid"));
    const res = await jsonRequest("/api/v1/marketing/pr", "POST", {
      title: "",
    });
    expect(res.status).toBe(400);
  });

  test("release lookup is tenant scoped", async () => {
    if (!pgliteReady) return;
    const owner = await seedActor("owner");
    const other = await seedActor("other");
    const release = await createDraft(owner);
    currentAuth = asAuth(other);
    const res = await request(`/api/v1/marketing/pr/${release.id}`);
    expect(res.status).toBe(404);
  });

  test("submit requires explicit confirmation and creates no distribution", async () => {
    if (!pgliteReady) return;
    const actor = await seedActor("confirm");
    const release = await createDraft(actor);
    await jsonRequest(`/api/v1/marketing/pr/${release.id}/ready`, "POST");

    const res = await jsonRequest(
      `/api/v1/marketing/pr/${release.id}/submit`,
      "POST",
      {},
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      confirmationRequired: boolean;
    };
    expect(body.code).toBe("confirmation_required");
    expect(body.confirmationRequired).toBe(true);
    expect(await countDistributions(release.id)).toBe(0);
  });

  test("confirmed submit fails closed with no provider and creates no distribution", async () => {
    if (!pgliteReady) return;
    const actor = await seedActor("provider");
    const release = await createDraft(actor);
    await jsonRequest(`/api/v1/marketing/pr/${release.id}/ready`, "POST");

    const res = await jsonRequest(
      `/api/v1/marketing/pr/${release.id}/submit`,
      "POST",
      { confirmPaidDistribution: true },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("no_provider_configured");
    expect(body.error).toContain("no charge was attempted");
    expect(await countDistributions(release.id)).toBe(0);
  });
});
