/**
 * `/api/v1/marketing/pr/*` — REAL global middleware chain + REAL route handlers
 * + REAL press-release service + REAL PGlite DB, in-process (#11819).
 *
 * Only the AUTH seam is mocked (`requireUserOrApiKeyWithOrg` maps a
 * `Bearer eliza_*` token to a seeded org/user). Everything the routes are about
 * — the service, the repository, the state transitions, the org scoping — runs
 * for real against PGlite, so create → update → ready → submit and the
 * multi-tenant isolation paths are proven against actual DB rows, not a stub.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { closeDatabaseConnectionsForTests, dbWrite } from "@/db/client";
import { organizations } from "@/db/schemas/organizations";
import {
  pressCoverage,
  pressMediaContacts,
  pressReleaseDistributions,
  pressReleases,
} from "@/db/schemas/press-releases";
import { users } from "@/db/schemas/users";
import { AuthenticationError } from "@/lib/api/cloud-worker-errors";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { authMiddleware } from "../src/middleware/auth";

const PGLITE_TIMEOUT = 60_000;
const KEY_A = "eliza_test_pr_org_a";
const KEY_B = "eliza_test_pr_org_b";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let pgliteReady = true;
// Seeded in beforeAll; the mocked auth resolver reads them at request time.
let orgAId = "";
let userAId = "";
let orgBId = "";
let userBId = "";

const requireUserOrApiKeyWithOrg = mock(async (c: AppContext) => {
  const auth = c.req.header("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (bearer === KEY_A) {
    return {
      id: userAId,
      email: "a@example.com",
      organization_id: orgAId,
      organization: { id: orgAId, name: "Org A", is_active: true },
      is_active: true,
      role: "user",
      steward_id: null,
      wallet_address: null,
      is_anonymous: false,
    };
  }
  if (bearer === KEY_B) {
    return {
      id: userBId,
      email: "b@example.com",
      organization_id: orgBId,
      organization: { id: orgBId, name: "Org B", is_active: true },
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

// Routes bind the mocked auth seam at module-eval time — import AFTER the mock.
const listRoute = (await import("../v1/marketing/pr/route")).default;
const detailRoute = (await import("../v1/marketing/pr/[id]/route")).default;
const readyRoute = (await import("../v1/marketing/pr/[id]/ready/route"))
  .default;
const submitRoute = (await import("../v1/marketing/pr/[id]/submit/route"))
  .default;
const cancelRoute = (await import("../v1/marketing/pr/[id]/cancel/route"))
  .default;
const coverageRoute = (await import("../v1/marketing/pr/[id]/coverage/route"))
  .default;

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });
  app.use("*", corsMiddleware);
  app.use(
    "*",
    secureHeaders({ xContentTypeOptions: "nosniff", xFrameOptions: "DENY" }),
  );
  app.use("*", authMiddleware);
  // More specific sub-routes before the `:id` detail route.
  app.route("/api/v1/marketing/pr/:id/ready", readyRoute);
  app.route("/api/v1/marketing/pr/:id/submit", submitRoute);
  app.route("/api/v1/marketing/pr/:id/cancel", cancelRoute);
  app.route("/api/v1/marketing/pr/:id/coverage", coverageRoute);
  app.route("/api/v1/marketing/pr/:id", detailRoute);
  app.route("/api/v1/marketing/pr", listRoute);
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

async function createDraft(
  key: string,
  body: Record<string, unknown> = { title: "Flow", body: "Body text" },
): Promise<string> {
  const { json } = await req("POST", "/api/v1/marketing/pr", { key, body });
  return (json.release as { id: string }).id;
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

    const [orgA] = await dbWrite
      .insert(organizations)
      .values({ name: "PR Org A", slug: "pr-org-a" })
      .returning();
    const [orgB] = await dbWrite
      .insert(organizations)
      .values({ name: "PR Org B", slug: "pr-org-b" })
      .returning();
    orgAId = orgA.id;
    orgBId = orgB.id;
    const [uA] = await dbWrite
      .insert(users)
      .values({ steward_user_id: "pr-steward-a", organization_id: orgAId })
      .returning();
    const [uB] = await dbWrite
      .insert(users)
      .values({ steward_user_id: "pr-steward-b", organization_id: orgBId })
      .returning();
    userAId = uA.id;
    userBId = uB.id;
  } catch (error) {
    pgliteReady = false;
    throw error;
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  mock.module("@/lib/auth/workers-hono-auth", () => realAuth);
  await closeDatabaseConnectionsForTests();
});

describe("create + list (auth + org-scoped)", () => {
  test("GET without a bearer is 401", async () => {
    expect(pgliteReady).toBe(true);
    const { status } = await req("GET", "/api/v1/marketing/pr");
    expect(status).toBe(401);
  });

  test("creates a draft and lists it for the owning org", async () => {
    const create = await req("POST", "/api/v1/marketing/pr", {
      key: KEY_A,
      body: { title: "Launch day", body: "We shipped it." },
    });
    expect(create.status).toBe(201);
    const release = create.json.release as {
      id: string;
      status: string;
      organization_id: string;
    };
    expect(release.status).toBe("draft");
    expect(release.organization_id).toBe(orgAId);

    const list = await req("GET", "/api/v1/marketing/pr", { key: KEY_A });
    expect(list.status).toBe(200);
    expect(
      (list.json.releases as Array<{ id: string }>).some(
        (r) => r.id === release.id,
      ),
    ).toBe(true);
  });

  test("rejects empty title/body with 400", async () => {
    const { status, json } = await req("POST", "/api/v1/marketing/pr", {
      key: KEY_A,
      body: { title: "   ", body: "x" },
    });
    expect(status).toBe(400);
    expect(json.success).toBe(false);
  });

  test("rejects a past embargo with 400 (service validation)", async () => {
    const { status, json } = await req("POST", "/api/v1/marketing/pr", {
      key: KEY_A,
      body: {
        title: "T",
        body: "B",
        embargoAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/embargo/i);
  });

  test("idempotency key returns the same release, never duplicates", async () => {
    const body = { title: "Idem", body: "once", idempotencyKey: "pr-idem-1" };
    const first = await req("POST", "/api/v1/marketing/pr", {
      key: KEY_A,
      body,
    });
    const second = await req("POST", "/api/v1/marketing/pr", {
      key: KEY_A,
      body,
    });
    expect(first.status).toBe(201);
    expect((second.json.release as { id: string }).id).toBe(
      (first.json.release as { id: string }).id,
    );
  });
});

describe("state transitions: draft -> ready -> submit(fail-closed) / cancel", () => {
  test("PATCH updates a draft", async () => {
    const id = await createDraft(KEY_A);
    const { status, json } = await req("PATCH", `/api/v1/marketing/pr/${id}`, {
      key: KEY_A,
      body: { summary: "New summary" },
    });
    expect(status).toBe(200);
    expect((json.release as { summary: string }).summary).toBe("New summary");
  });

  test("unknown id is 404 on GET", async () => {
    const { status } = await req(
      "GET",
      "/api/v1/marketing/pr/00000000-0000-4000-8000-000000000000",
      { key: KEY_A },
    );
    expect(status).toBe(404);
  });

  test("POST /ready moves draft -> ready; PATCH then 409 (not editable)", async () => {
    const id = await createDraft(KEY_A);
    const ready = await req("POST", `/api/v1/marketing/pr/${id}/ready`, {
      key: KEY_A,
    });
    expect(ready.status).toBe(200);
    expect((ready.json.release as { status: string }).status).toBe("ready");

    const patch = await req("PATCH", `/api/v1/marketing/pr/${id}`, {
      key: KEY_A,
      body: { summary: "too late" },
    });
    expect(patch.status).toBe(409);
  });

  test("submit on a ready release is fail-closed (503, provider_unavailable)", async () => {
    const id = await createDraft(KEY_A);
    await req("POST", `/api/v1/marketing/pr/${id}/ready`, { key: KEY_A });
    const { status, json } = await req(
      "POST",
      `/api/v1/marketing/pr/${id}/submit`,
      {
        key: KEY_A,
      },
    );
    expect(status).toBe(503);
    expect(json.success).toBe(false);
    expect(json.status).toBe("provider_unavailable");
  });

  test("submit on a draft (not ready) is 409", async () => {
    const id = await createDraft(KEY_A);
    const { status } = await req("POST", `/api/v1/marketing/pr/${id}/submit`, {
      key: KEY_A,
    });
    expect(status).toBe(409);
  });

  test("cancel moves draft -> cancelled", async () => {
    const id = await createDraft(KEY_A);
    const { status, json } = await req(
      "POST",
      `/api/v1/marketing/pr/${id}/cancel`,
      {
        key: KEY_A,
      },
    );
    expect(status).toBe(200);
    expect((json.release as { status: string }).status).toBe("cancelled");
  });

  test("coverage list is empty for a fresh release", async () => {
    const id = await createDraft(KEY_A);
    const { status, json } = await req(
      "GET",
      `/api/v1/marketing/pr/${id}/coverage`,
      { key: KEY_A },
    );
    expect(status).toBe(200);
    expect(json.coverage).toEqual([]);
  });
});

describe("multi-tenant isolation — org B cannot touch org A's release", () => {
  let releaseId = "";

  test("org A creates a release", async () => {
    releaseId = await createDraft(KEY_A, {
      title: "Secret A",
      body: "Org A only",
    });
    expect(releaseId).toBeTruthy();
  });

  test("org B GET is 404", async () => {
    const { status } = await req("GET", `/api/v1/marketing/pr/${releaseId}`, {
      key: KEY_B,
    });
    expect(status).toBe(404);
  });

  test("org B PATCH is 404 and never mutates org A's release", async () => {
    const patch = await req("PATCH", `/api/v1/marketing/pr/${releaseId}`, {
      key: KEY_B,
      body: { summary: "hijack" },
    });
    expect(patch.status).toBe(404);
    const check = await req("GET", `/api/v1/marketing/pr/${releaseId}`, {
      key: KEY_A,
    });
    expect(
      (check.json.release as { summary: string | null }).summary ?? null,
    ).toBe(null);
  });

  test("org B ready/cancel/submit/coverage all 404", async () => {
    const cases: Array<[string, string]> = [
      ["POST", "/ready"],
      ["POST", "/cancel"],
      ["POST", "/submit"],
      ["GET", "/coverage"],
    ];
    for (const [method, suffix] of cases) {
      const { status } = await req(
        method,
        `/api/v1/marketing/pr/${releaseId}${suffix}`,
        { key: KEY_B },
      );
      expect(status).toBe(404);
    }
  });

  test("org B list does not include org A's release", async () => {
    const { json } = await req("GET", "/api/v1/marketing/pr", { key: KEY_B });
    expect(
      (json.releases as Array<{ id: string }>).some((r) => r.id === releaseId),
    ).toBe(false);
  });
});
