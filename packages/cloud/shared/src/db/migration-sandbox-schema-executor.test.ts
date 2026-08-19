/**
 * Deterministically exercises the real migration-session adapter against the
 * complete agent-sandbox convergence batch and parameterized Drizzle output.
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { convergeAgentSandboxSchema } from "./ensure-agent-sandbox-schema";
import { createMigrationClientSandboxExecutor } from "./migration-sandbox-schema-executor";

describe("createMigrationClientSandboxExecutor", () => {
  test("renders each convergence statement into a parameterized query in order", async () => {
    const rendered: Array<{ sql: string; params: unknown[] }> = [];
    const executor = createMigrationClientSandboxExecutor(async (sql, params) => {
      rendered.push({ sql, params });
      return { rows: [] };
    });

    await convergeAgentSandboxSchema(executor);

    expect(rendered.length).toBeGreaterThan(30);
    for (const query of rendered) {
      expect(query.sql.length).toBeGreaterThan(0);
      expect(Array.isArray(query.params)).toBe(true);
    }

    expect(rendered[0]?.sql).toContain('ALTER TABLE "agent_sandboxes"');
    expect(rendered[0]?.sql).toContain('ADD COLUMN IF NOT EXISTS "pool_status"');
    expect(
      rendered.some(({ sql }) =>
        sql.includes('CREATE TABLE IF NOT EXISTS "agent_sandbox_backups"'),
      ),
    ).toBe(true);
    expect(
      rendered.some(({ sql }) => sql.includes("agent_sandboxes_deletion_intent_pair_check")),
    ).toBe(true);

    const seed = rendered.find(({ sql }) => sql.includes('INSERT INTO "organizations"'));
    expect(seed?.params.length).toBeGreaterThan(0);
  });

  test("returns the raw session result and propagates its failure", async () => {
    const sentinel = { rows: [{ ok: true }] };
    const success = createMigrationClientSandboxExecutor(async () => sentinel);
    await expect(success.execute(sql`SELECT 1`)).resolves.toBe(sentinel);

    const failure = new Error("locked migration session failed");
    const rejected = createMigrationClientSandboxExecutor(async () => {
      throw failure;
    });
    await expect(rejected.execute(sql`SELECT 2`)).rejects.toBe(failure);
  });
});
