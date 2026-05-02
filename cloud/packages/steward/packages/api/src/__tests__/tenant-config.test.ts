import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// Skip all DB-dependent tests when DATABASE_URL is not configured
const SKIP = !process.env.DATABASE_URL;

import { generateApiKey } from "@stwd/auth";
import { getDb, tenantConfigs, tenants } from "@stwd/db";
import { eq } from "drizzle-orm";

// ─── Test Config ──────────────────────────────────────────────────────────

const TEST_PORT = 3299;
const BASE_URL = `http://localhost:${TEST_PORT}`;

const TENANT_ID = "test-tenant-config";
let validApiKey: string;

// ─── Setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (SKIP) return;
  const db = getDb();
  const apiKeyPair = generateApiKey();
  validApiKey = apiKeyPair.key;

  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "Config Test Tenant",
      apiKeyHash: apiKeyPair.hash,
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (SKIP) return;
  const db = getDb();
  await db.delete(tenantConfigs).where(eq(tenantConfigs.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

const headers = () => ({
  "X-Steward-Tenant": TENANT_ID,
  "X-Steward-Key": validApiKey,
  "Content-Type": "application/json",
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("Tenant Config API", () => {
  describe("GET /tenants/:id/config", () => {
    it("returns empty config for tenant with no config set", async () => {
      const res = await fetch(`${BASE_URL}/tenants/${TENANT_ID}/config`, {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.tenantId).toBe(TENANT_ID);
      expect(body.data.policyExposure).toEqual({});
      expect(body.data.policyTemplates).toEqual([]);
    });

    it("returns default config for milady-cloud tenant", async () => {
      // This tests the default fallback — milady-cloud has built-in defaults
      // We need a milady-cloud tenant to exist for auth to pass
      const db = getDb();
      const apiKeyPair = generateApiKey();
      await db
        .insert(tenants)
        .values({
          id: "milady-cloud",
          name: "Milady Cloud",
          apiKeyHash: apiKeyPair.hash,
        })
        .onConflictDoNothing();

      const res = await fetch(`${BASE_URL}/tenants/milady-cloud/config`, {
        headers: {
          "X-Steward-Tenant": "milady-cloud",
          "X-Steward-Key": apiKeyPair.key,
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.tenantId).toBe("milady-cloud");
      expect(body.data.policyTemplates.length).toBeGreaterThan(0);
      expect(body.data.policyExposure["spending-limit"]).toBe("visible");

      // Cleanup
      await db.delete(tenants).where(eq(tenants.id, "milady-cloud"));
    });
  });

  describe("PUT /tenants/:id/config", () => {
    it("creates/updates tenant config", async () => {
      const config = {
        displayName: "Test Tenant Display",
        policyExposure: {
          "spending-limit": "visible",
          "rate-limit": "enforced",
        },
        policyTemplates: [
          {
            id: "test-template",
            name: "Test Template",
            description: "A test template",
            icon: "test",
            policies: [
              {
                id: "tpl-spend",
                type: "spending-limit",
                enabled: true,
                config: {
                  maxPerTx: "100",
                  maxPerDay: "1000",
                  maxPerWeek: "5000",
                },
              },
            ],
            customizableFields: [],
          },
        ],
        featureFlags: {
          showFundingQR: true,
          showTransactionHistory: true,
          showSpendDashboard: false,
        },
        approvalConfig: {
          autoExpireSeconds: 3600,
          approvers: { mode: "owner" },
        },
        theme: {
          primaryColor: "#FF0000",
          colorScheme: "dark",
        },
      };

      const res = await fetch(`${BASE_URL}/tenants/${TENANT_ID}/config`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(config),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.tenantId).toBe(TENANT_ID);
      expect(body.data.displayName).toBe("Test Tenant Display");
      expect(body.data.policyExposure["spending-limit"]).toBe("visible");
      expect(body.data.policyTemplates).toHaveLength(1);
      expect(body.data.featureFlags.showFundingQR).toBe(true);
      expect(body.data.featureFlags.showSpendDashboard).toBe(false);
      expect(body.data.theme.primaryColor).toBe("#FF0000");
    });

    it("GET returns the saved config", async () => {
      const res = await fetch(`${BASE_URL}/tenants/${TENANT_ID}/config`, {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.displayName).toBe("Test Tenant Display");
      expect(body.data.policyTemplates).toHaveLength(1);
    });

    it("rejects invalid JSON", async () => {
      const res = await fetch(`${BASE_URL}/tenants/${TENANT_ID}/config`, {
        method: "PUT",
        headers: {
          ...headers(),
          "Content-Type": "text/plain",
        },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /tenants/:id/config/templates", () => {
    it("returns saved templates", async () => {
      const res = await fetch(`${BASE_URL}/tenants/${TENANT_ID}/config/templates`, {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe("test-template");
    });
  });

  describe("POST /tenants/:id/config/templates/:name/apply", () => {
    it("rejects without agentId", async () => {
      const res = await fetch(
        `${BASE_URL}/tenants/${TENANT_ID}/config/templates/test-template/apply`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent template", async () => {
      const res = await fetch(
        `${BASE_URL}/tenants/${TENANT_ID}/config/templates/nonexistent/apply`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ agentId: "some-agent" }),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("Auth", () => {
    it("rejects access without auth", async () => {
      const res = await fetch(`${BASE_URL}/tenants/${TENANT_ID}/config`);
      expect(res.status).toBe(403);
    });

    it("rejects cross-tenant access", async () => {
      const res = await fetch(`${BASE_URL}/tenants/other-tenant/config`, {
        headers: headers(),
      });
      expect(res.status).toBe(403);
    });
  });
});

describe.skipIf(SKIP)("Dashboard API", () => {
  it("returns 404 for non-existent agent", async () => {
    const { createSessionToken } = await import("../routes/auth");
    const token = await createSessionToken("0x0000000000000000000000000000000000000000", TENANT_ID);
    const res = await fetch(`${BASE_URL}/dashboard/nonexistent-agent`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
