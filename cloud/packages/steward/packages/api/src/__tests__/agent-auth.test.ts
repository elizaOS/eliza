import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// Skip all DB-dependent tests when DATABASE_URL is not configured
const SKIP = !process.env.DATABASE_URL;

import { generateApiKey } from "@stwd/auth";
import { agents, encryptedKeys, getDb, tenants } from "@stwd/db";
import { and, eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";

// ─── Test Config ──────────────────────────────────────────────────────────

const TEST_PORT = 3299;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const jwtSecretSource = process.env.STEWARD_SESSION_SECRET || process.env.STEWARD_MASTER_PASSWORD;
const JWT_SECRET = new TextEncoder().encode(jwtSecretSource || "dev-secret");
const JWT_ISSUER = "steward";

const TEST_TENANT_ID = "test-agent-auth";
const TEST_AGENT_ID = "agent-001";
const OTHER_AGENT_ID = "agent-002";

let testApiKey: string;

// ─── Helpers ──────────────────────────────────────────────────────────────

function tenantHeaders(apiKey: string, tenantId = TEST_TENANT_ID) {
  return {
    "X-Steward-Tenant": tenantId,
    "X-Steward-Key": apiKey,
    "Content-Type": "application/json",
  };
}

function agentBearerHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function createAgentToken(agentId: string, tenantId: string, expiresIn = "30d") {
  return new SignJWT({ agentId, tenantId, scope: "agent" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setExpirationTime(expiresIn)
    .sign(JWT_SECRET);
}

// ─── Setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (SKIP) return;
  const db = getDb();
  const apiKeyPair = generateApiKey();
  testApiKey = apiKeyPair.key;

  // Create test tenant
  await db
    .insert(tenants)
    .values({
      id: TEST_TENANT_ID,
      name: "Test Agent Auth Tenant",
      apiKeyHash: apiKeyPair.hash,
    })
    .onConflictDoNothing();

  // Create test agents via API
  await fetch(`${BASE_URL}/agents`, {
    method: "POST",
    headers: tenantHeaders(testApiKey),
    body: JSON.stringify({ id: TEST_AGENT_ID, name: "Agent One" }),
  });

  await fetch(`${BASE_URL}/agents`, {
    method: "POST",
    headers: tenantHeaders(testApiKey),
    body: JSON.stringify({ id: OTHER_AGENT_ID, name: "Agent Two" }),
  });
});

afterAll(async () => {
  if (SKIP) return;
  // Clean up test data
  const db = getDb();
  await db.delete(encryptedKeys).where(eq(encryptedKeys.agentId, TEST_AGENT_ID));
  await db.delete(encryptedKeys).where(eq(encryptedKeys.agentId, OTHER_AGENT_ID));
  await db.delete(agents).where(eq(agents.tenantId, TEST_TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TEST_TENANT_ID));
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("POST /agents/:agentId/token", () => {
  it("generates a scoped JWT with tenant API key auth", async () => {
    const res = await fetch(`${BASE_URL}/agents/${TEST_AGENT_ID}/token`, {
      method: "POST",
      headers: tenantHeaders(testApiKey),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.data.token).toBeDefined();
    expect(json.data.agentId).toBe(TEST_AGENT_ID);
    expect(json.data.tenantId).toBe(TEST_TENANT_ID);
    expect(json.data.scope).toBe("agent");

    // Verify the JWT payload
    const { payload } = await jwtVerify(json.data.token, JWT_SECRET, {
      issuer: JWT_ISSUER,
    });
    expect(payload.agentId).toBe(TEST_AGENT_ID);
    expect(payload.tenantId).toBe(TEST_TENANT_ID);
    expect(payload.scope).toBe("agent");
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await fetch(`${BASE_URL}/agents/nonexistent-agent/token`, {
      method: "POST",
      headers: tenantHeaders(testApiKey),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
  });

  it("rejects request with invalid API key", async () => {
    const res = await fetch(`${BASE_URL}/agents/${TEST_AGENT_ID}/token`, {
      method: "POST",
      headers: tenantHeaders("stw_invalid_key"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
  });

  it("rejects request from an agent-scoped token", async () => {
    const agentToken = await createAgentToken(TEST_AGENT_ID, TEST_TENANT_ID);
    const res = await fetch(`${BASE_URL}/agents/${TEST_AGENT_ID}/token`, {
      method: "POST",
      headers: agentBearerHeaders(agentToken),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error).toContain("cannot generate");
  });

  it("accepts custom expiresIn", async () => {
    const res = await fetch(`${BASE_URL}/agents/${TEST_AGENT_ID}/token`, {
      method: "POST",
      headers: tenantHeaders(testApiKey),
      body: JSON.stringify({ expiresIn: "7d" }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.expiresIn).toBe("7d");
  });
});

describe.skipIf(SKIP)("Agent-scoped JWT access to vault endpoints", () => {
  let agentToken: string;
  let _otherAgentToken: string;

  beforeAll(async () => {
    // Generate tokens via the API
    const res1 = await fetch(`${BASE_URL}/agents/${TEST_AGENT_ID}/token`, {
      method: "POST",
      headers: tenantHeaders(testApiKey),
      body: JSON.stringify({}),
    });
    const json1 = (await res1.json()) as any;
    agentToken = json1.data.token;

    const res2 = await fetch(`${BASE_URL}/agents/${OTHER_AGENT_ID}/token`, {
      method: "POST",
      headers: tenantHeaders(testApiKey),
      body: JSON.stringify({}),
    });
    const json2 = (await res2.json()) as any;
    _otherAgentToken = json2.data.token;
  });

  describe("GET /agents/:agentId/balance", () => {
    it("allows agent to access own balance", async () => {
      const res = await fetch(`${BASE_URL}/agents/${TEST_AGENT_ID}/balance`, {
        headers: agentBearerHeaders(agentToken),
      });
      // Should succeed (200) or fail with a chain error, but NOT 403
      expect(res.status).not.toBe(403);
    });

    it("blocks agent from accessing another agent's balance", async () => {
      const res = await fetch(`${BASE_URL}/agents/${OTHER_AGENT_ID}/balance`, {
        headers: agentBearerHeaders(agentToken),
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as any;
      expect(json.error).toContain("scope does not match");
    });

    it("allows tenant API key to access any agent balance", async () => {
      const res = await fetch(`${BASE_URL}/agents/${TEST_AGENT_ID}/balance`, {
        headers: tenantHeaders(testApiKey),
      });
      // Should not be 403
      expect(res.status).not.toBe(403);
    });
  });

  describe("GET /vault/:agentId/pending", () => {
    it("allows agent to access own pending", async () => {
      const res = await fetch(`${BASE_URL}/vault/${TEST_AGENT_ID}/pending`, {
        headers: agentBearerHeaders(agentToken),
      });
      expect(res.status).not.toBe(403);
    });

    it("blocks agent from accessing another agent's pending", async () => {
      const res = await fetch(`${BASE_URL}/vault/${OTHER_AGENT_ID}/pending`, {
        headers: agentBearerHeaders(agentToken),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /vault/:agentId/history", () => {
    it("allows agent to access own history", async () => {
      const res = await fetch(`${BASE_URL}/vault/${TEST_AGENT_ID}/history`, {
        headers: agentBearerHeaders(agentToken),
      });
      expect(res.status).not.toBe(403);
    });

    it("blocks agent from accessing another agent's history", async () => {
      const res = await fetch(`${BASE_URL}/vault/${OTHER_AGENT_ID}/history`, {
        headers: agentBearerHeaders(agentToken),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /vault/:agentId/sign", () => {
    it("blocks agent from signing for another agent", async () => {
      const res = await fetch(`${BASE_URL}/vault/${OTHER_AGENT_ID}/sign`, {
        method: "POST",
        headers: agentBearerHeaders(agentToken),
        body: JSON.stringify({ to: `0x${"a".repeat(40)}`, value: "1000" }),
      });
      expect(res.status).toBe(403);
    });
  });
});

describe.skipIf(SKIP)("POST /vault/:agentId/import", () => {
  const IMPORT_AGENT_ID = "import-test-agent";

  afterAll(async () => {
    const db = getDb();
    await db.delete(encryptedKeys).where(eq(encryptedKeys.agentId, IMPORT_AGENT_ID));
    await db
      .delete(agents)
      .where(and(eq(agents.id, IMPORT_AGENT_ID), eq(agents.tenantId, TEST_TENANT_ID)));
  });

  it("imports an EVM private key and returns derived address", async () => {
    // Generate a test private key (deterministic for testing)
    const testPrivateKey = `0x${"ab".repeat(32)}`;

    const res = await fetch(`${BASE_URL}/vault/${IMPORT_AGENT_ID}/import`, {
      method: "POST",
      headers: tenantHeaders(testApiKey),
      body: JSON.stringify({ privateKey: testPrivateKey, chain: "evm" }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.data.agentId).toBe(IMPORT_AGENT_ID);
    expect(json.data.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(json.data.chain).toBe("evm");
  });

  it("rejects import from agent-scoped token", async () => {
    const agentToken = await createAgentToken(IMPORT_AGENT_ID, TEST_TENANT_ID);

    const res = await fetch(`${BASE_URL}/vault/${IMPORT_AGENT_ID}/import`, {
      method: "POST",
      headers: agentBearerHeaders(agentToken),
      body: JSON.stringify({
        privateKey: `0x${"cd".repeat(32)}`,
        chain: "evm",
      }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error).toContain("tenant-level");
  });

  it("rejects missing privateKey", async () => {
    const res = await fetch(`${BASE_URL}/vault/${IMPORT_AGENT_ID}/import`, {
      method: "POST",
      headers: tenantHeaders(testApiKey),
      body: JSON.stringify({ chain: "evm" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects invalid chain type", async () => {
    const res = await fetch(`${BASE_URL}/vault/${IMPORT_AGENT_ID}/import`, {
      method: "POST",
      headers: tenantHeaders(testApiKey),
      body: JSON.stringify({
        privateKey: `0x${"ab".repeat(32)}`,
        chain: "bitcoin",
      }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toContain("chain must be");
  });

  it("rejects request with invalid API key", async () => {
    const res = await fetch(`${BASE_URL}/vault/${IMPORT_AGENT_ID}/import`, {
      method: "POST",
      headers: tenantHeaders("stw_bad_key"),
      body: JSON.stringify({
        privateKey: `0x${"ab".repeat(32)}`,
        chain: "evm",
      }),
    });

    expect(res.status).toBe(403);
  });
});

describe.skipIf(SKIP)("Backward compatibility", () => {
  it("tenant API key still works for all agent endpoints", async () => {
    const res = await fetch(`${BASE_URL}/agents`, {
      headers: tenantHeaders(testApiKey),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
  });

  it("tenant API key can access any agent's balance", async () => {
    const res = await fetch(`${BASE_URL}/agents/${TEST_AGENT_ID}/balance`, {
      headers: tenantHeaders(testApiKey),
    });
    // 200 or non-403 (might fail due to RPC but not auth)
    expect(res.status).not.toBe(403);
  });

  it("tenant API key can access any agent's history", async () => {
    const res = await fetch(`${BASE_URL}/vault/${TEST_AGENT_ID}/history`, {
      headers: tenantHeaders(testApiKey),
    });
    expect(res.status).toBe(200);
  });
});
