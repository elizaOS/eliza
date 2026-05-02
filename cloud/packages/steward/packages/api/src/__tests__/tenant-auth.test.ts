import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateApiKey } from "@stwd/auth";
import { getDb, tenants } from "@stwd/db";
import { eq } from "drizzle-orm";

// ─── Test Config ──────────────────────────────────────────────────────────

const TEST_PORT = 3299;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDatabaseUrl ? describe : describe.skip;

const TENANT_WITH_KEY = "test-tenant-with-key";
const TENANT_WITHOUT_KEY = "test-tenant-no-key";
type ErrorBody = { error: string };

let validApiKey: string;

// ─── Setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!hasDatabaseUrl) {
    return;
  }
  const db = getDb();
  const apiKeyPair = generateApiKey();
  validApiKey = apiKeyPair.key;

  // Create tenant WITH an API key hash
  await db
    .insert(tenants)
    .values({
      id: TENANT_WITH_KEY,
      name: "Tenant With Key",
      apiKeyHash: apiKeyPair.hash,
    })
    .onConflictDoNothing();

  // Create tenant WITHOUT an API key hash (simulating empty STEWARD_DEFAULT_TENANT_KEY)
  await db
    .insert(tenants)
    .values({
      id: TENANT_WITHOUT_KEY,
      name: "Tenant No Key",
      apiKeyHash: "", // Empty — no auth configured
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (!hasDatabaseUrl) {
    return;
  }
  const db = getDb();
  await db.delete(tenants).where(eq(tenants.id, TENANT_WITH_KEY));
  await db.delete(tenants).where(eq(tenants.id, TENANT_WITHOUT_KEY));
});

// ─── Tests ────────────────────────────────────────────────────────────────

describeWithDatabase("Tenant API Key Authentication", () => {
  describe("Tenant with API key configured", () => {
    it("allows access with valid API key", async () => {
      const res = await fetch(`${BASE_URL}/agents`, {
        headers: {
          "X-Steward-Tenant": TENANT_WITH_KEY,
          "X-Steward-Key": validApiKey,
        },
      });
      expect(res.status).toBe(200);
    });

    it("rejects access with invalid API key", async () => {
      const res = await fetch(`${BASE_URL}/agents`, {
        headers: {
          "X-Steward-Tenant": TENANT_WITH_KEY,
          "X-Steward-Key": "stw_invalid_key",
        },
      });
      expect(res.status).toBe(403);
    });

    it("rejects access with no API key", async () => {
      const res = await fetch(`${BASE_URL}/agents`, {
        headers: {
          "X-Steward-Tenant": TENANT_WITH_KEY,
        },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("Tenant without API key configured (Bug 3 fix)", () => {
    it("rejects anonymous access — requires API key", async () => {
      const res = await fetch(`${BASE_URL}/agents`, {
        headers: {
          "X-Steward-Tenant": TENANT_WITHOUT_KEY,
          // No X-Steward-Key
        },
      });

      // Should NOT allow through — must require auth
      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorBody;
      expect(json.error).toContain("API key required");
    });

    it("rejects when API key provided but tenant not configured for auth", async () => {
      const res = await fetch(`${BASE_URL}/agents`, {
        headers: {
          "X-Steward-Tenant": TENANT_WITHOUT_KEY,
          "X-Steward-Key": "stw_some_key",
        },
      });

      // Tenant has no hash, so can't validate the key
      expect(res.status).toBe(403);
      const json = (await res.json()) as ErrorBody;
      expect(json.error).toContain("not configured");
    });
  });

  describe("Non-existent tenant", () => {
    it("returns 404", async () => {
      const res = await fetch(`${BASE_URL}/agents`, {
        headers: {
          "X-Steward-Tenant": "nonexistent-tenant-12345",
          "X-Steward-Key": "stw_whatever",
        },
      });
      expect(res.status).toBe(404);
    });
  });
});
