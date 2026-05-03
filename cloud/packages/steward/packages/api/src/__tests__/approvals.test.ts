import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// Skip all DB-dependent tests when DATABASE_URL is not configured
const SKIP = !process.env.DATABASE_URL;

import { generateApiKey } from "@stwd/auth";
import { agents, approvalQueue, autoApprovalRules, getDb, tenants, transactions } from "@stwd/db";
import { eq } from "drizzle-orm";

const TEST_PORT = parseInt(process.env.PORT || "3200", 10);
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_TENANT = "test-approvals-tenant";
const TEST_AGENT = "test-approvals-agent";
const TEST_TX_APPROVE = "test-tx-approve";
const TEST_TX_DENY = "test-tx-deny";
const TEST_APPROVAL_APPROVE = "test-approval-approve";
const TEST_APPROVAL_DENY = "test-approval-deny";

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
      id: TEST_TENANT,
      name: "Approvals Test Tenant",
      apiKeyHash: apiKeyPair.hash,
    })
    .onConflictDoNothing();

  await db
    .insert(agents)
    .values({
      id: TEST_AGENT,
      tenantId: TEST_TENANT,
      name: "Test Agent",
      walletAddress: "0x1234567890123456789012345678901234567890",
    })
    .onConflictDoNothing();

  // Create test transactions
  for (const txId of [TEST_TX_APPROVE, TEST_TX_DENY]) {
    await db
      .insert(transactions)
      .values({
        id: txId,
        agentId: TEST_AGENT,
        status: "pending",
        toAddress: "0x0000000000000000000000000000000000000001",
        value: "1000000000000000000",
        chainId: 84532,
      })
      .onConflictDoNothing();
  }

  // Create approval queue entries
  await db
    .insert(approvalQueue)
    .values({
      id: TEST_APPROVAL_APPROVE,
      txId: TEST_TX_APPROVE,
      agentId: TEST_AGENT,
      status: "pending",
    })
    .onConflictDoNothing();

  await db
    .insert(approvalQueue)
    .values({
      id: TEST_APPROVAL_DENY,
      txId: TEST_TX_DENY,
      agentId: TEST_AGENT,
      status: "pending",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (SKIP) return;
  const db = getDb();
  await db.delete(approvalQueue).where(eq(approvalQueue.agentId, TEST_AGENT));
  await db.delete(transactions).where(eq(transactions.agentId, TEST_AGENT));
  await db.delete(autoApprovalRules).where(eq(autoApprovalRules.tenantId, TEST_TENANT));
  await db.delete(agents).where(eq(agents.id, TEST_AGENT));
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

describe.skipIf(SKIP)("Approval Workflow API", () => {
  describe("GET /approvals", () => {
    it("lists pending approvals for tenant", async () => {
      const res = await fetch(`${BASE_URL}/approvals`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      expect(body.data[0].agentName).toBeDefined();
      expect(body.data[0].toAddress).toBeDefined();
    });

    it("filters by status", async () => {
      const res = await fetch(`${BASE_URL}/approvals?status=approved`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // No approvals should be approved yet
      expect(body.data.length).toBe(0);
    });
  });

  describe("GET /approvals/stats", () => {
    it("returns approval statistics", async () => {
      const res = await fetch(`${BASE_URL}/approvals/stats`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.pending).toBeGreaterThanOrEqual(2);
      expect(typeof body.data.approved).toBe("number");
      expect(typeof body.data.rejected).toBe("number");
      expect(typeof body.data.avgWaitSeconds).toBe("number");
    });
  });

  describe("POST /approvals/:txId/approve", () => {
    it("approves a pending transaction", async () => {
      const res = await fetch(`${BASE_URL}/approvals/${TEST_TX_APPROVE}/approve`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ comment: "Looks good" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.status).toBe("approved");
      expect(body.data.comment).toBe("Looks good");
    });

    it("rejects double-approval", async () => {
      const res = await fetch(`${BASE_URL}/approvals/${TEST_TX_APPROVE}/approve`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("already approved");
    });
  });

  describe("POST /approvals/:txId/deny", () => {
    it("requires a reason", async () => {
      const res = await fetch(`${BASE_URL}/approvals/${TEST_TX_DENY}/deny`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("reason is required");
    });

    it("denies a pending transaction with reason", async () => {
      const res = await fetch(`${BASE_URL}/approvals/${TEST_TX_DENY}/deny`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ reason: "Suspicious destination address" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.status).toBe("rejected");
      expect(body.data.reason).toBe("Suspicious destination address");
    });

    it("returns 404 for non-existent transaction", async () => {
      const res = await fetch(`${BASE_URL}/approvals/nonexistent-tx/deny`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ reason: "test" }),
      });

      expect(res.status).toBe(404);
    });
  });
});

describe.skipIf(SKIP)("Auto-Approval Rules API", () => {
  describe("GET /approvals/rules", () => {
    it("returns null when no rules configured", async () => {
      const res = await fetch(`${BASE_URL}/approvals/rules`, {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toBeNull();
    });
  });

  describe("PUT /approvals/rules", () => {
    it("creates auto-approval rules", async () => {
      const res = await fetch(`${BASE_URL}/approvals/rules`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          maxAmountWei: "1000000000000000000",
          autoDenyAfterHours: 24,
          escalateAboveWei: "10000000000000000000",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.maxAmountWei).toBe("1000000000000000000");
      expect(body.data.autoDenyAfterHours).toBe(24);
      expect(body.data.escalateAboveWei).toBe("10000000000000000000");
      expect(body.data.enabled).toBe(true);
    });

    it("updates existing rules", async () => {
      const res = await fetch(`${BASE_URL}/approvals/rules`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          autoDenyAfterHours: 48,
          enabled: false,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.autoDenyAfterHours).toBe(48);
      expect(body.data.enabled).toBe(false);
      // Previous values should be preserved
      expect(body.data.maxAmountWei).toBe("1000000000000000000");
    });

    it("rejects invalid maxAmountWei", async () => {
      const res = await fetch(`${BASE_URL}/approvals/rules`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ maxAmountWei: "not-a-number" }),
      });

      expect(res.status).toBe(400);
    });
  });
});
