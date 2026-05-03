import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// Skip all DB-dependent tests when DATABASE_URL is not configured
const SKIP = !process.env.DATABASE_URL;

import { generateApiKey } from "@stwd/auth";
import { getDb, tenants, webhookConfigs } from "@stwd/db";
import { eq } from "drizzle-orm";

const TEST_PORT = parseInt(process.env.PORT || "3200", 10);
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_TENANT = "test-webhooks-tenant";

let validApiKey: string;
let createdWebhookId: string;

// ─── Setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (SKIP) return;
  const db = getDb();
  const apiKeyPair = generateApiKey();
  validApiKey = apiKeyPair.key;

  await db
    .insert(tenants)
    .values({
      id: TEST_TENANT,
      name: "Webhook Test Tenant",
      apiKeyHash: apiKeyPair.hash,
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (SKIP) return;
  const db = getDb();
  // Clean up webhooks first (FK constraint)
  await db.delete(webhookConfigs).where(eq(webhookConfigs.tenantId, TEST_TENANT));
  await db.delete(tenants).where(eq(tenants.id, TEST_TENANT));
});

function authHeaders() {
  return {
    "X-Steward-Tenant": TEST_TENANT,
    "X-Steward-Key": validApiKey,
    "Content-Type": "application/json",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("Webhook Configuration API", () => {
  describe("POST /webhooks", () => {
    it("creates a webhook with valid data", async () => {
      const res = await fetch(`${BASE_URL}/webhooks`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          url: "https://example.com/hooks/steward",
          events: ["tx.pending", "tx.approved"],
          description: "Test webhook",
          maxRetries: 3,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.url).toBe("https://example.com/hooks/steward");
      expect(body.data.events).toEqual(["tx.pending", "tx.approved"]);
      expect(body.data.secret).toMatch(/^whsec_/);
      expect(body.data.maxRetries).toBe(3);
      expect(body.data.enabled).toBe(true);

      createdWebhookId = body.data.id;
    });

    it("rejects invalid URL", async () => {
      const res = await fetch(`${BASE_URL}/webhooks`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ url: "not-a-url" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });

    it("rejects invalid event types", async () => {
      const res = await fetch(`${BASE_URL}/webhooks`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          url: "https://example.com/hook",
          events: ["invalid.event"],
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid events");
    });

    it("defaults to all events when none specified", async () => {
      const res = await fetch(`${BASE_URL}/webhooks`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ url: "https://example.com/all-events" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.events.length).toBe(6);
    });
  });

  describe("GET /webhooks", () => {
    it("lists webhooks for tenant", async () => {
      const res = await fetch(`${BASE_URL}/webhooks`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      // Secret should be omitted from list
      expect(body.data[0].secret).toBeUndefined();
    });
  });

  describe("PUT /webhooks/:id", () => {
    it("updates webhook config", async () => {
      const res = await fetch(`${BASE_URL}/webhooks/${createdWebhookId}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          enabled: false,
          description: "Updated description",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.enabled).toBe(false);
      expect(body.data.description).toBe("Updated description");
    });

    it("returns 404 for non-existent webhook", async () => {
      const res = await fetch(`${BASE_URL}/webhooks/00000000-0000-0000-0000-000000000000`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /webhooks/:id/deliveries", () => {
    it("returns empty list for new webhook", async () => {
      const res = await fetch(`${BASE_URL}/webhooks/${createdWebhookId}/deliveries`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual([]);
    });
  });

  describe("DELETE /webhooks/:id", () => {
    it("deletes a webhook", async () => {
      const res = await fetch(`${BASE_URL}/webhooks/${createdWebhookId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.deleted).toBe(true);
    });

    it("returns 404 for already-deleted webhook", async () => {
      const res = await fetch(`${BASE_URL}/webhooks/${createdWebhookId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      expect(res.status).toBe(404);
    });
  });
});
