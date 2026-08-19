/**
 * Pins the workerd short-circuit for the agent-sandbox schema convergence
 * guard (STAGING-FLOW-GREEN-2026-08-19).
 *
 * On workerd the guard's large sequential DDL batch cannot reliably finish
 * inside a request (or its waitUntil budget). Observed live on staging: every cold
 * shared-agent scope hydration died with the guard's own
 * "Failed query: ALTER TABLE agent_sandboxes ..." — keeping the scope cache
 * permanently cold, so the first-turn warming 503 recurred on every cold
 * conversation instead of resolving once. The guard must therefore skip on
 * Workers unless explicitly opted in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { runWithCloudBindings } from "../lib/runtime/cloud-bindings";
import {
  convergeAgentSandboxSchema,
  createMigrationClientSandboxExecutor,
  shouldSkipEnsure,
} from "./ensure-agent-sandbox-schema";

const globalRecord = globalThis as Record<string, unknown>;
const hadWebSocketPair = Object.hasOwn(globalRecord, "WebSocketPair");
const originalWebSocketPair = globalRecord.WebSocketPair;

function enterWorkerRuntime(): void {
  // isCloudflareWorkerRuntime() detects workerd via the WebSocketPair global.
  globalRecord.WebSocketPair = class {};
}

function leaveWorkerRuntime(): void {
  if (hadWebSocketPair) {
    globalRecord.WebSocketPair = originalWebSocketPair;
  } else {
    delete globalRecord.WebSocketPair;
  }
}

afterEach(() => {
  leaveWorkerRuntime();
  delete process.env.SKIP_AGENT_SANDBOX_ENSURE;
  delete process.env.AGENT_SANDBOX_ENSURE_IN_WORKER;
  delete process.env.ENVIRONMENT;
});

describe("shouldSkipEnsure", () => {
  test("skips on workerd by default (the staging cold-scope incident class)", () => {
    enterWorkerRuntime();
    expect(shouldSkipEnsure()).toBe(true);
  });

  test("workerd can opt back in explicitly", () => {
    enterWorkerRuntime();
    process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
    process.env.AGENT_SANDBOX_ENSURE_IN_WORKER = "1";
    expect(shouldSkipEnsure()).toBe(false);
  });

  test("workerd reads the opt-in from request-scoped Worker bindings", () => {
    enterWorkerRuntime();
    process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
    expect(
      runWithCloudBindings({ AGENT_SANDBOX_ENSURE_IN_WORKER: "1" }, () => shouldSkipEnsure()),
    ).toBe(false);
  });

  test("non-Worker runtimes still run the convergence guard", () => {
    expect(shouldSkipEnsure()).toBe(false);
  });

  test("explicit escape hatch still wins everywhere", () => {
    process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
    expect(shouldSkipEnsure()).toBe(true);
    enterWorkerRuntime();
    expect(shouldSkipEnsure()).toBe(true);
  });

  test("local environment still skips", () => {
    process.env.ENVIRONMENT = "local";
    expect(shouldSkipEnsure()).toBe(true);
  });
});

describe("createMigrationClientSandboxExecutor", () => {
  test("renders each convergence statement into a parameterized query in order", async () => {
    const rendered: Array<{ sql: string; params: unknown[] }> = [];
    const executor = createMigrationClientSandboxExecutor(async (sql, params) => {
      rendered.push({ sql, params });
      return { rows: [] };
    });

    await convergeAgentSandboxSchema(executor);

    // Every convergence statement must reach the raw query function as a
    // finished { sql, params } pair; no unrendered Drizzle SQL object leaks out.
    expect(rendered.length).toBeGreaterThan(30);
    for (const { sql, params } of rendered) {
      expect(typeof sql).toBe("string");
      expect(sql.length).toBeGreaterThan(0);
      expect(Array.isArray(params)).toBe(true);
    }

    // The batch opens with the agent_sandboxes column ALTER and includes the
    // duplicate_object-guarded DO block that adds the deletion-intent check.
    const first = rendered[0];
    expect(first).toBeDefined();
    expect(first?.sql).toContain('ALTER TABLE "agent_sandboxes"');
    expect(first?.sql).toContain('ADD COLUMN IF NOT EXISTS "pool_status"');
    expect(
      rendered.some(({ sql }) =>
        sql.includes('CREATE TABLE IF NOT EXISTS "agent_sandbox_backups"'),
      ),
    ).toBe(true);
    expect(
      rendered.some(({ sql }) => sql.includes("agent_sandboxes_deletion_intent_pair_check")),
    ).toBe(true);

    // The warm-pool organization seed is parameterized, not string-interpolated,
    // so the WARM_POOL_ORG_ID crosses as a bound parameter.
    const seed = rendered.find(({ sql }) => sql.includes('INSERT INTO "organizations"'));
    expect(seed).toBeDefined();
    expect(seed?.params.length).toBeGreaterThan(0);
  });

  test("forwards the raw query result back through the executor", async () => {
    const sentinel = { rows: [{ ok: true }] };
    let calls = 0;
    const executor = createMigrationClientSandboxExecutor(async () => {
      calls += 1;
      return sentinel;
    });

    // The executor must return the raw query result unchanged so callers can
    // read rows from the underlying session.
    const result = await executor.execute(sql`SELECT 1`);
    expect(result).toBe(sentinel);

    // A full convergence run drives the raw query once per statement.
    await convergeAgentSandboxSchema(executor);
    expect(calls).toBeGreaterThan(30);
  });
});
