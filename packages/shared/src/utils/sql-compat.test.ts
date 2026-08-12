import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  ensureRuntimeSqlCompatibility,
  executeRawSql,
  quoteIdent,
  sanitizeIdentifier,
  sqlLiteral,
} from "./sql-compat.ts";

describe("quoteIdent", () => {
  it("quotes valid SQL identifiers", () => {
    expect(quoteIdent("users")).toBe('"users"');
    expect(quoteIdent("table_name")).toBe('"table_name"');
  });

  it("escapes internal double quotes", () => {
    expect(quoteIdent('user"name')).toBe('"user""name"');
    expect(quoteIdent('a"b"c')).toBe('"a""b""c"');
  });

  it("handles non-string values gracefully", () => {
    expect(quoteIdent(null as unknown as string)).toBe('""');
    expect(quoteIdent(undefined as unknown as string)).toBe('""');
  });
});

describe("sanitizeIdentifier", () => {
  it("returns sanitized identifier for alphanumeric strings", () => {
    expect(sanitizeIdentifier("users")).toBe("users");
    expect(sanitizeIdentifier("  my_table_123  ")).toBe("my_table_123");
  });

  it("strips special characters and SQL injection attempts", () => {
    expect(sanitizeIdentifier("users; DROP TABLE users;--")).toBe(
      "usersDROPTABLEusers",
    );
    expect(sanitizeIdentifier("table-name!@#")).toBe("tablename");
  });

  it("returns null for non-string, empty, or overly long inputs", () => {
    expect(sanitizeIdentifier(null)).toBeNull();
    expect(sanitizeIdentifier(undefined)).toBeNull();
    expect(sanitizeIdentifier("   ")).toBeNull();
    expect(sanitizeIdentifier("!!!")).toBeNull();
    expect(sanitizeIdentifier("a".repeat(129))).toBeNull();
  });
});

describe("sqlLiteral", () => {
  it("wraps string values in single quotes", () => {
    expect(sqlLiteral("public")).toBe("'public'");
    expect(sqlLiteral("hello world")).toBe("'hello world'");
  });

  it("escapes internal single quotes", () => {
    expect(sqlLiteral("O'Connor")).toBe("'O''Connor'");
    expect(sqlLiteral("a'b'c")).toBe("'a''b''c'");
  });

  it("handles non-string values gracefully", () => {
    expect(sqlLiteral(null as unknown as string)).toBe("''");
    expect(sqlLiteral(undefined as unknown as string)).toBe("''");
  });
});

describe("executeRawSql", () => {
  it("throws error when db execute is missing", async () => {
    const runtime = { adapter: {} } as unknown as AgentRuntime;
    await expect(executeRawSql(runtime, "SELECT 1")).rejects.toThrow(
      "Database adapter not available",
    );
  });

  it("executes raw SQL and parses standard object response", async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      rows: [{ id: 1, name: "test" }],
      fields: [{ name: "id" }, { name: "name" }],
    });
    const runtime = {
      adapter: { db: { execute: mockExecute } },
    } as unknown as AgentRuntime;

    const result = await executeRawSql(runtime, "SELECT * FROM test");
    expect(result.rows).toEqual([{ id: 1, name: "test" }]);
    expect(result.columns).toEqual(["id", "name"]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("executes raw SQL and parses direct array response from driver", async () => {
    const mockExecute = vi
      .fn()
      .mockResolvedValue([
        { column_name: "agent_id" },
        { column_name: "room_state" },
      ]);
    const runtime = {
      adapter: { db: { execute: mockExecute } },
    } as unknown as AgentRuntime;

    const result = await executeRawSql(runtime, "SELECT column_name FROM info");
    expect(result.rows).toEqual([
      { column_name: "agent_id" },
      { column_name: "room_state" },
    ]);
    expect(result.columns).toEqual(["column_name"]);
  });
});

describe("ensureRuntimeSqlCompatibility", () => {
  it("returns silently when runtime or database adapter is missing", async () => {
    await expect(ensureRuntimeSqlCompatibility(null)).resolves.toBeUndefined();
    await expect(
      ensureRuntimeSqlCompatibility(undefined),
    ).resolves.toBeUndefined();
    await expect(
      ensureRuntimeSqlCompatibility({} as AgentRuntime),
    ).resolves.toBeUndefined();
  });

  it("succeeds when all required columns are present in information_schema", async () => {
    const mockExecute = vi.fn().mockImplementation((query) => {
      const sqlString = JSON.stringify(query);

      if (sqlString.includes("participants")) {
        return Promise.resolve({
          rows: [{ column_name: "agent_id" }, { column_name: "room_state" }],
        });
      }
      if (sqlString.includes("trajectories")) {
        return Promise.resolve({
          rows: [
            { column_name: "step_count" },
            { column_name: "llm_call_count" },
            { column_name: "total_prompt_tokens" },
            { column_name: "total_completion_tokens" },
            { column_name: "total_reward" },
            { column_name: "scenario_id" },
            { column_name: "batch_id" },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const runtime = {
      adapter: { db: { execute: mockExecute } },
    } as unknown as AgentRuntime;

    await expect(
      ensureRuntimeSqlCompatibility(runtime),
    ).resolves.toBeUndefined();
    // Subsequent calls return immediately due to WeakSet caching
    await expect(
      ensureRuntimeSqlCompatibility(runtime),
    ).resolves.toBeUndefined();
  });

  it("falls back to PRAGMA table_info and throws error if required column is missing", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ rows: [] });
    const runtime = {
      adapter: { db: { execute: mockExecute } },
    } as unknown as AgentRuntime;

    await expect(ensureRuntimeSqlCompatibility(runtime)).rejects.toThrow(
      "[sql-compat] Missing required column",
    );
  });

  it("deduplicates concurrent compatibility checks on the same runtime", async () => {
    let resolveExecute: (val: unknown) => void = () => {};
    const pendingPromise = new Promise((res) => {
      resolveExecute = res;
    });

    const mockExecute = vi.fn().mockImplementation(() => pendingPromise);
    const runtime = {
      adapter: { db: { execute: mockExecute } },
    } as unknown as AgentRuntime;

    const p1 = ensureRuntimeSqlCompatibility(runtime);
    const p2 = ensureRuntimeSqlCompatibility(runtime);

    resolveExecute({
      rows: [{ column_name: "agent_id" }, { column_name: "room_state" }],
    });

    await expect(Promise.all([p1, p2])).rejects.toThrow(
      "[sql-compat] Missing required column",
    );
  });
});
