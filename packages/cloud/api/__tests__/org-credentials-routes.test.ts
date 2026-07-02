/**
 * Org credential-pool routes — REAL handlers, REAL DB, REAL crypto (#11332).
 *
 * Mounts the actual /api/organizations/credentials route modules on a Hono
 * app and drives them end-to-end against in-process PGlite: real
 * `pooled_credentials` + envelope-encrypted `secrets` rows, the real
 * `assertOrgMembership` IDOR guard, the real service layer, and a real HTTP
 * provider stub for the live contribution probe (ANTHROPIC_BASE_URL override
 * — real request, real 200/401, no fetch mocks).
 *
 * The ONLY seam mocked is `requireUserOrApiKeyWithOrg` (like
 * apps-crud.integration.test.ts): bearer tokens map to seeded users across
 * TWO orgs so the member / admin / owner / contributor / cross-org paths are
 * all exercised for real.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SECRETS_MASTER_KEY = "fedcba9876543210".repeat(4);

import { Hono } from "hono";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const OWNER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ADMIN_A = "aaaaaaaa-2222-4222-8222-222222222222";
const MEMBER_A = "aaaaaaaa-3333-4333-8333-333333333333";
const MEMBER_A2 = "aaaaaaaa-4444-4444-8444-444444444444";
const MEMBER_B = "bbbbbbbb-1111-4111-8111-111111111111";

const TOKENS: Record<
  string,
  { id: string; organization_id: string; role: string }
> = {
  eliza_owner_a: { id: OWNER_A, organization_id: ORG_A, role: "owner" },
  eliza_admin_a: { id: ADMIN_A, organization_id: ORG_A, role: "admin" },
  eliza_member_a: { id: MEMBER_A, organization_id: ORG_A, role: "member" },
  eliza_member_a2: { id: MEMBER_A2, organization_id: ORG_A, role: "member" },
  eliza_member_b: { id: MEMBER_B, organization_id: ORG_B, role: "member" },
};

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: mock(
    async (c: { req: { header: (n: string) => string | undefined } }) => {
      const bearer =
        c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const user = TOKENS[bearer];
      if (!user) throw new Error("Authentication required");
      return { ...user, organization: { id: user.organization_id } };
    },
  ),
}));

const GOOD_KEYS = new Set([
  "sk-ant-team-key-one-1111",
  "sk-ant-team-key-two-2222",
]);

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let pgliteReady = true;
let provider: ReturnType<typeof Bun.serve> | undefined;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;

function authed(token: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  };
}

beforeAll(async () => {
  try {
    provider = Bun.serve({
      port: 0,
      fetch(req) {
        const key = req.headers.get("x-api-key") ?? "";
        if (new URL(req.url).pathname.endsWith("/models")) {
          return GOOD_KEYS.has(key)
            ? Response.json({ data: [] })
            : Response.json({ error: "invalid api key" }, { status: 401 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;

    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;
    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const {
      secretActorTypeEnum,
      secretAuditActionEnum,
      secretAuditLog,
      secretEnvironmentEnum,
      secretProjectTypeEnum,
      secretProviderEnum,
      secretScopeEnum,
      secrets,
    } = await import("@/db/schemas/secrets");
    const { pooledCredentialUsage, pooledCredentials } = await import(
      "@/db/schemas/pooled-credentials"
    );
    const { authEvents } = await import("@/db/schemas/auth-events");
    const { pushSchema } = await import("@/db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        secrets,
        secretAuditLog,
        authEvents,
        secretScopeEnum,
        secretEnvironmentEnum,
        secretAuditActionEnum,
        secretActorTypeEnum,
        secretProviderEnum,
        secretProjectTypeEnum,
        pooledCredentials,
        pooledCredentialUsage,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite.insert(organizations).values([
      { id: ORG_A, name: "Org A", slug: "org-a" },
      { id: ORG_B, name: "Org B", slug: "org-b" },
    ]);
    await dbWrite.insert(users).values([
      {
        id: OWNER_A,
        email: "owner@a.test",
        organization_id: ORG_A,
        role: "owner",
        steward_user_id: `steward-${OWNER_A}`,
      },
      {
        id: ADMIN_A,
        email: "admin@a.test",
        organization_id: ORG_A,
        role: "admin",
        steward_user_id: `steward-${ADMIN_A}`,
      },
      {
        id: MEMBER_A,
        email: "member@a.test",
        organization_id: ORG_A,
        role: "member",
        steward_user_id: `steward-${MEMBER_A}`,
      },
      {
        id: MEMBER_A2,
        email: "member2@a.test",
        organization_id: ORG_A,
        role: "member",
        steward_user_id: `steward-${MEMBER_A2}`,
      },
      {
        id: MEMBER_B,
        email: "member@b.test",
        organization_id: ORG_B,
        role: "member",
        steward_user_id: `steward-${MEMBER_B}`,
      },
    ]);

    // Real route modules at their codegen mount paths.
    const collection = (await import("../organizations/credentials/route"))
      .default;
    const item = (
      await import("../organizations/credentials/[credentialId]/route")
    ).default;
    app = new Hono<AppEnv>();
    app.route("/api/organizations/credentials", collection);
    app.route("/api/organizations/credentials/:credentialId", item);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[org-credentials-routes.test] setup failed — failing.",
      error,
    );
  }
}, 120_000);

afterAll(async () => {
  provider?.stop(true);
  if (closeDb) await closeDb();
  mock.restore();
});

let credentialByMemberA = "";

describe("POST /api/organizations/credentials — contribute", () => {
  test("rejects a key the provider 401s: 400, nothing stored", async () => {
    expect(pgliteReady).toBe(true);
    const res = await app.request(
      "/api/organizations/credentials",
      authed("eliza_member_a", {
        method: "POST",
        body: JSON.stringify({
          provider: "anthropic-api",
          apiKey: "sk-ant-bogus-key-0000",
        }),
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/failed live validation/i);
  });

  test("rejects subscription providers with the Phase-2 gate message", async () => {
    const res = await app.request(
      "/api/organizations/credentials",
      authed("eliza_member_a", {
        method: "POST",
        body: JSON.stringify({
          provider: "openai-codex",
          apiKey: "sk-whatever-long-enough",
        }),
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /cannot be pooled/i,
    );
  });

  test("member contributes a live-validated key: 201 masked summary, plaintext never returned, ciphertext at rest", async () => {
    const plaintext = "sk-ant-team-key-one-1111";
    const res = await app.request(
      "/api/organizations/credentials",
      authed("eliza_member_a", {
        method: "POST",
        body: JSON.stringify({
          provider: "anthropic-api",
          apiKey: plaintext,
          label: "m1 key",
        }),
      }),
      ENV,
    );
    expect(res.status).toBe(201);
    const raw = await res.text();
    // The creation response itself never carries the key material.
    expect(raw).not.toContain(plaintext);
    const body = JSON.parse(raw) as {
      success: boolean;
      data: { id: string; last4: string; provider: string };
    };
    expect(body.data.last4).toBe("1111");
    expect(body.data.provider).toBe("anthropic-api");
    credentialByMemberA = body.data.id;

    // At rest: vault ciphertext only.
    const { dbWrite } = await import("@/db/client");
    const stored = await dbWrite.execute(
      `SELECT encrypted_value FROM secrets;`,
    );
    for (const row of stored.rows as Array<{ encrypted_value: string }>) {
      expect(row.encrypted_value).not.toContain(plaintext);
    }
  });
});

describe("GET /api/organizations/credentials — member-readable, masked", () => {
  test("member sees the masked list (no key material anywhere)", async () => {
    const res = await app.request(
      "/api/organizations/credentials",
      authed("eliza_member_a2"),
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<Record<string, unknown>>;
    };
    expect(body.data).toHaveLength(1);
    const item = body.data[0];
    expect(item.provider).toBe("anthropic-api");
    expect(item.last4).toBe("1111");
    expect(item.health).toBe("ok");
    expect(item.contributedBy).toMatchObject({ id: MEMBER_A });
    expect(JSON.stringify(body)).not.toContain("sk-ant-team-key-one-1111");
  });

  test("another org's member sees an empty pool (org-scoped)", async () => {
    const res = await app.request(
      "/api/organizations/credentials",
      authed("eliza_member_b"),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  test("unauthenticated request is rejected", async () => {
    const res = await app.request("/api/organizations/credentials", {}, ENV);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("PATCH/DELETE /api/organizations/credentials/:id — RBAC + IDOR", () => {
  test("member cannot PATCH (owner/admin only)", async () => {
    const res = await app.request(
      `/api/organizations/credentials/${credentialByMemberA}`,
      authed("eliza_member_a2", {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
      ENV,
    );
    expect(res.status).toBe(403);
  });

  test("admin PATCHes enabled/priority", async () => {
    const res = await app.request(
      `/api/organizations/credentials/${credentialByMemberA}`,
      authed("eliza_admin_a", {
        method: "PATCH",
        body: JSON.stringify({ enabled: false, priority: 5 }),
      }),
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { enabled: boolean; priority: number };
    };
    expect(body.data.enabled).toBe(false);
    expect(body.data.priority).toBe(5);
  });

  test("cross-org member gets an audited 403 on a real credential id (IDOR)", async () => {
    const res = await app.request(
      `/api/organizations/credentials/${credentialByMemberA}`,
      authed("eliza_member_b", { method: "DELETE" }),
      ENV,
    );
    expect(res.status).toBe(403);
    // The denial is audited (assertOrgMembership emits a denied event).
    const { dbWrite } = await import("@/db/client");
    const audited = await dbWrite.execute(
      `SELECT actor_id, result, metadata FROM auth_events
       WHERE result = 'denied' AND resource_type = 'pooled_credential' AND resource_id = '${credentialByMemberA}';`,
    );
    expect(audited.rows.length).toBeGreaterThanOrEqual(1);
    expect((audited.rows[0] as { actor_id: string }).actor_id).toBe(MEMBER_B);
  });

  test("a non-contributor member cannot DELETE someone else's key", async () => {
    const res = await app.request(
      `/api/organizations/credentials/${credentialByMemberA}`,
      authed("eliza_member_a2", { method: "DELETE" }),
      ENV,
    );
    expect(res.status).toBe(403);
  });

  test("the contributor deletes their own key (row + vault secret gone)", async () => {
    const res = await app.request(
      `/api/organizations/credentials/${credentialByMemberA}`,
      authed("eliza_member_a", { method: "DELETE" }),
      ENV,
    );
    expect(res.status).toBe(200);
    const { dbWrite } = await import("@/db/client");
    const rows = await dbWrite.execute(
      `SELECT id FROM pooled_credentials WHERE id = '${credentialByMemberA}';`,
    );
    expect(rows.rows).toHaveLength(0);
    const secretsLeft = await dbWrite.execute(`SELECT id FROM secrets;`);
    expect(secretsLeft.rows).toHaveLength(0);
  });

  test("PATCH on a nonexistent id is a clean 404", async () => {
    const res = await app.request(
      "/api/organizations/credentials/99999999-9999-4999-8999-999999999999",
      authed("eliza_admin_a", {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      }),
      ENV,
    );
    expect(res.status).toBe(404);
  });
});
