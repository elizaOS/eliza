import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateApiKey } from "@stwd/auth";
import { getDb, tenantConfigs, tenants, users, userTenants } from "@stwd/db";
import { eq } from "drizzle-orm";

// ─── Test Config ──────────────────────────────────────────────────────────

const TEST_PORT = 3299;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDatabaseUrl ? describe : describe.skip;

// Tenant IDs for testing
const OPEN_TENANT = "test-ct-open";
const INVITE_TENANT = "test-ct-invite";
const CLOSED_TENANT = "test-ct-closed";
const NO_CONFIG_TENANT = "test-ct-noconfig"; // no tenant_configs row → defaults to open

let platformKey: string;

// We'll create test users directly in the DB for testing
const TEST_USER_EMAIL = "cross-tenant-test@example.com";
let testUserId: string;

// ─── Setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!hasDatabaseUrl) {
    return;
  }
  const db = getDb();

  // Platform key from env
  platformKey = process.env.STEWARD_PLATFORM_KEY || "test-platform-key";

  // Create test tenants
  const openKey = generateApiKey();

  await db
    .insert(tenants)
    .values({
      id: OPEN_TENANT,
      name: "Open Tenant",
      apiKeyHash: openKey.hash,
    })
    .onConflictDoNothing();

  await db
    .insert(tenants)
    .values({
      id: INVITE_TENANT,
      name: "Invite Tenant",
      apiKeyHash: generateApiKey().hash,
    })
    .onConflictDoNothing();

  await db
    .insert(tenants)
    .values({
      id: CLOSED_TENANT,
      name: "Closed Tenant",
      apiKeyHash: generateApiKey().hash,
    })
    .onConflictDoNothing();

  await db
    .insert(tenants)
    .values({
      id: NO_CONFIG_TENANT,
      name: "No Config Tenant",
      apiKeyHash: generateApiKey().hash,
    })
    .onConflictDoNothing();

  // Create tenant configs with different join modes
  await db
    .insert(tenantConfigs)
    .values({
      tenantId: OPEN_TENANT,
      joinMode: "open",
    })
    .onConflictDoNothing();

  await db
    .insert(tenantConfigs)
    .values({
      tenantId: INVITE_TENANT,
      joinMode: "invite",
    })
    .onConflictDoNothing();

  await db
    .insert(tenantConfigs)
    .values({
      tenantId: CLOSED_TENANT,
      joinMode: "closed",
    })
    .onConflictDoNothing();

  // NO_CONFIG_TENANT intentionally has no config row (defaults to open)

  // Create test user
  const [user] = await db
    .insert(users)
    .values({ email: TEST_USER_EMAIL, emailVerified: true })
    .onConflictDoNothing()
    .returning();

  if (user) {
    testUserId = user.id;
  } else {
    const [existing] = await db.select().from(users).where(eq(users.email, TEST_USER_EMAIL));
    testUserId = existing.id;
  }

  // Link test user to open tenant
  await db
    .insert(userTenants)
    .values({ userId: testUserId, tenantId: OPEN_TENANT, role: "member" })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (!hasDatabaseUrl) {
    return;
  }
  const db = getDb();
  // Clean up in reverse order of dependencies
  await db.delete(userTenants).where(eq(userTenants.userId, testUserId));
  await db.delete(tenantConfigs).where(eq(tenantConfigs.tenantId, OPEN_TENANT));
  await db.delete(tenantConfigs).where(eq(tenantConfigs.tenantId, INVITE_TENANT));
  await db.delete(tenantConfigs).where(eq(tenantConfigs.tenantId, CLOSED_TENANT));
  await db.delete(tenants).where(eq(tenants.id, OPEN_TENANT));
  await db.delete(tenants).where(eq(tenants.id, INVITE_TENANT));
  await db.delete(tenants).where(eq(tenants.id, CLOSED_TENANT));
  await db.delete(tenants).where(eq(tenants.id, NO_CONFIG_TENANT));
  await db.delete(users).where(eq(users.id, testUserId));
});

// ─── Helper: get a JWT for the test user ──────────────────────────────────

async function getTestUserToken(tenantId?: string): Promise<string> {
  const { createSessionToken } = await import("../routes/auth");
  return createSessionToken("0x0000000000000000000000000000000000000000", tenantId ?? OPEN_TENANT, {
    userId: testUserId,
    email: TEST_USER_EMAIL,
  });
}

// ─── Tests: User Tenant APIs ──────────────────────────────────────────────

describeWithDatabase("Cross-Tenant Identity", () => {
  describe("GET /user/me/tenants", () => {
    it("lists tenants the user belongs to", async () => {
      const token = await getTestUserToken();

      const res = await fetch(`${BASE_URL}/user/me/tenants`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: Array<{ tenantId: string; role: string }>;
      };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);

      const openMembership = body.data.find(
        (m: { tenantId: string }) => m.tenantId === OPEN_TENANT,
      );
      expect(openMembership).toBeDefined();
      expect(openMembership?.role).toBe("member");
    });
  });

  describe("GET /user/me/tenants/:tenantId", () => {
    it("returns membership info for a joined tenant", async () => {
      const token = await getTestUserToken();

      const res = await fetch(`${BASE_URL}/user/me/tenants/${OPEN_TENANT}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: { tenantId: string; role: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.tenantId).toBe(OPEN_TENANT);
    });

    it("returns 404 for a tenant the user has not joined", async () => {
      const token = await getTestUserToken();

      const res = await fetch(`${BASE_URL}/user/me/tenants/${CLOSED_TENANT}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /user/me/tenants/:tenantId/join", () => {
    it("allows joining an open tenant (no config row = default open)", async () => {
      const token = await getTestUserToken();

      const res = await fetch(`${BASE_URL}/user/me/tenants/${NO_CONFIG_TENANT}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        tenantId: string;
        role: string;
      };
      expect(body.ok).toBe(true);
      expect(body.tenantId).toBe(NO_CONFIG_TENANT);
    });

    it("rejects joining an invite-only tenant", async () => {
      const token = await getTestUserToken();

      const res = await fetch(`${BASE_URL}/user/me/tenants/${INVITE_TENANT}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(403);
    });

    it("rejects joining a closed tenant", async () => {
      const token = await getTestUserToken();

      const res = await fetch(`${BASE_URL}/user/me/tenants/${CLOSED_TENANT}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(403);
    });

    it("returns 404 for a non-existent tenant", async () => {
      const token = await getTestUserToken();

      const res = await fetch(`${BASE_URL}/user/me/tenants/nonexistent-tenant/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /user/me/tenants/:tenantId/leave", () => {
    it("allows leaving a non-personal tenant", async () => {
      const token = await getTestUserToken();

      // First ensure we joined NO_CONFIG_TENANT
      await fetch(`${BASE_URL}/user/me/tenants/${NO_CONFIG_TENANT}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const res = await fetch(`${BASE_URL}/user/me/tenants/${NO_CONFIG_TENANT}/leave`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("prevents leaving personal tenant", async () => {
      const token = await getTestUserToken();

      const res = await fetch(`${BASE_URL}/user/me/tenants/personal-${testUserId}/leave`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("Platform tenant member management", () => {
    it("GET /platform/tenants/:id/members lists members", async () => {
      const res = await fetch(`${BASE_URL}/platform/tenants/${OPEN_TENANT}/members`, {
        headers: { "X-Steward-Platform-Key": platformKey },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: Array<{ userId: string }>;
      };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("POST /platform/tenants/:id/members invites a user", async () => {
      const res = await fetch(`${BASE_URL}/platform/tenants/${INVITE_TENANT}/members`, {
        method: "POST",
        headers: {
          "X-Steward-Platform-Key": platformKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: TEST_USER_EMAIL, role: "admin" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        ok: boolean;
        data: { userId: string; role: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.role).toBe("admin");
    });

    it("PATCH /platform/tenants/:id/members/:userId updates role", async () => {
      const res = await fetch(
        `${BASE_URL}/platform/tenants/${INVITE_TENANT}/members/${testUserId}`,
        {
          method: "PATCH",
          headers: {
            "X-Steward-Platform-Key": platformKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ role: "owner" }),
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: { role: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.role).toBe("owner");
    });

    it("DELETE /platform/tenants/:id/members/:userId removes member", async () => {
      const res = await fetch(
        `${BASE_URL}/platform/tenants/${INVITE_TENANT}/members/${testUserId}`,
        {
          method: "DELETE",
          headers: { "X-Steward-Platform-Key": platformKey },
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("returns 404 for members of non-existent tenant", async () => {
      const res = await fetch(`${BASE_URL}/platform/tenants/nonexistent/members`, {
        headers: { "X-Steward-Platform-Key": platformKey },
      });

      expect(res.status).toBe(404);
    });
  });
});
