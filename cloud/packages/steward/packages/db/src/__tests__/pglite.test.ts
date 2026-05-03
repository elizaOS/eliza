/**
 * PGLite adapter tests.
 *
 * Verifies that the PGLite adapter:
 *   1. Initializes and runs all migrations
 *   2. Supports basic CRUD via Drizzle (tenants, agents, policies)
 *   3. Persists data across close/reopen cycles
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createPGLiteDb } from "../pglite";
import { agents, encryptedKeys, policies, tenants, transactions } from "../schema";

// Shared temp dir for persistence tests
let tempDir: string;

async function freshDb(dir?: string) {
  return createPGLiteDb(dir ?? "memory://");
}

function readCountRow(rows: unknown[]): number {
  const firstRow = rows[0];
  if (!firstRow || typeof firstRow !== "object" || !("cnt" in firstRow)) {
    throw new Error("Expected count row");
  }

  return Number(firstRow.cnt);
}

describe("PGLite Adapter", () => {
  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── Initialization & Migrations ──────────────────────────────────────

  test("initializes in-memory and runs migrations", async () => {
    const { db, client } = await freshDb();

    // Check that core tables exist by querying them
    const tenantRows = await db.select().from(tenants);
    expect(tenantRows).toEqual([]);

    const agentRows = await db.select().from(agents);
    expect(agentRows).toEqual([]);

    const policyRows = await db.select().from(policies);
    expect(policyRows).toEqual([]);

    await client.close();
  });

  test("migration tracking table exists", async () => {
    const { client } = await freshDb();

    const result = await client.query("SELECT tag FROM __steward_migrations ORDER BY tag");
    expect(result.rows.length).toBeGreaterThan(0);
    // Should have at least the initial migration
    const tags = result.rows.map((r: any) => r.tag);
    expect(tags).toContain("0000_black_klaw");

    await client.close();
  });

  // ─── Basic CRUD ────────────────────────────────────────────────────────

  test("create and read tenant", async () => {
    const { db, client } = await freshDb();

    await db.insert(tenants).values({
      id: "test-tenant-1",
      name: "Test Tenant",
      apiKeyHash: "hash123",
    });

    const rows = await db.select().from(tenants).where(eq(tenants.id, "test-tenant-1"));

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Test Tenant");
    expect(rows[0].apiKeyHash).toBe("hash123");

    await client.close();
  });

  test("create agent with tenant FK", async () => {
    const { db, client } = await freshDb();

    // Create tenant first
    await db.insert(tenants).values({
      id: "t1",
      name: "Tenant",
      apiKeyHash: "h",
    });

    // Create agent
    await db.insert(agents).values({
      id: "agent-1",
      tenantId: "t1",
      name: "Test Agent",
      walletAddress: "0x1234567890abcdef",
    });

    const rows = await db.select().from(agents).where(eq(agents.id, "agent-1"));

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Test Agent");
    expect(rows[0].tenantId).toBe("t1");
    expect(rows[0].walletAddress).toBe("0x1234567890abcdef");

    await client.close();
  });

  test("create and query policies", async () => {
    const { db, client } = await freshDb();

    await db.insert(tenants).values({ id: "t1", name: "T", apiKeyHash: "h" });
    await db.insert(agents).values({
      id: "a1",
      tenantId: "t1",
      name: "Agent",
      walletAddress: "0xabc",
    });

    await db.insert(policies).values({
      id: "pol-1",
      agentId: "a1",
      type: "spending-limit",
      enabled: true,
      config: { maxAmount: "1000", period: "daily" },
    });

    const rows = await db.select().from(policies).where(eq(policies.agentId, "a1"));

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("spending-limit");
    expect(rows[0].config).toEqual({ maxAmount: "1000", period: "daily" });

    await client.close();
  });

  test("create transaction and update status", async () => {
    const { db, client } = await freshDb();

    await db.insert(tenants).values({ id: "t1", name: "T", apiKeyHash: "h" });
    await db.insert(agents).values({
      id: "a1",
      tenantId: "t1",
      name: "Agent",
      walletAddress: "0xabc",
    });

    await db.insert(transactions).values({
      id: "tx-1",
      agentId: "a1",
      status: "pending",
      toAddress: "0xdef",
      value: "1000000",
      chainId: 1,
    });

    // Update status
    await db.update(transactions).set({ status: "approved" }).where(eq(transactions.id, "tx-1"));

    const rows = await db.select().from(transactions).where(eq(transactions.id, "tx-1"));

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("approved");

    await client.close();
  });

  test("encrypted keys CRUD", async () => {
    const { db, client } = await freshDb();

    await db.insert(tenants).values({ id: "t1", name: "T", apiKeyHash: "h" });
    await db.insert(agents).values({
      id: "a1",
      tenantId: "t1",
      name: "Agent",
      walletAddress: "0xabc",
    });

    await db.insert(encryptedKeys).values({
      agentId: "a1",
      ciphertext: "encrypted_data",
      iv: "init_vector",
      tag: "auth_tag",
      salt: "salt_value",
    });

    const rows = await db.select().from(encryptedKeys).where(eq(encryptedKeys.agentId, "a1"));

    expect(rows).toHaveLength(1);
    expect(rows[0].ciphertext).toBe("encrypted_data");

    await client.close();
  });

  // ─── Persistence ───────────────────────────────────────────────────────

  test("data persists across close/reopen", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "steward-pglite-test-"));

    // First session: write data
    {
      const { db, client } = await createPGLiteDb(tempDir);

      await db.insert(tenants).values({
        id: "persist-tenant",
        name: "Persistent Tenant",
        apiKeyHash: "persist-hash",
      });

      await db.insert(agents).values({
        id: "persist-agent",
        tenantId: "persist-tenant",
        name: "Persistent Agent",
        walletAddress: "0xpersist",
      });

      await client.close();
    }

    // Second session: read data back
    {
      const { db, client } = await createPGLiteDb(tempDir);

      const tenantRows = await db.select().from(tenants).where(eq(tenants.id, "persist-tenant"));

      expect(tenantRows).toHaveLength(1);
      expect(tenantRows[0].name).toBe("Persistent Tenant");

      const agentRows = await db.select().from(agents).where(eq(agents.id, "persist-agent"));

      expect(agentRows).toHaveLength(1);
      expect(agentRows[0].name).toBe("Persistent Agent");

      await client.close();
    }
  });

  test("migrations don't re-run on persistent DB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steward-pglite-mig-"));

    // First init
    const { client: c1 } = await createPGLiteDb(dir);
    const r1 = await c1.query("SELECT COUNT(*) as cnt FROM __steward_migrations");
    const count1 = readCountRow(r1.rows);
    await c1.close();

    // Second init — same dir
    const { client: c2 } = await createPGLiteDb(dir);
    const r2 = await c2.query("SELECT COUNT(*) as cnt FROM __steward_migrations");
    const count2 = readCountRow(r2.rows);
    await c2.close();

    // Same number of migrations applied
    expect(count2).toBe(count1);

    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
});
