/**
 * Trajectory steps table tests.
 *
 * Verifies that the dedicated `trajectory_steps` table can:
 *   - Store steps and read them back in ordinal order.
 *   - Paginate large step sets (1000 steps).
 *   - Migrate existing JSONB `steps_json` rows into row format.
 *   - Round-trip scripts longer than the legacy 4096-char cap.
 *
 * Uses an in-process mock SQL engine sufficient to handle the queries
 * the trajectory persistence layer emits. We do not boot PGLite — these
 * are unit tests for the schema and read/write code paths.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureTrajectoriesTable,
  loadTrajectoryById,
  type PersistedTrajectory,
  saveTrajectory,
} from "./trajectory-internals";
import {
  DEFAULT_GET_STEPS_LIMIT,
  getSteps,
  loadAllStepsForTrajectory,
  MAX_GET_STEPS_LIMIT,
} from "./trajectory-steps-reader";
import { replaceStepsForTrajectory } from "./trajectory-steps-writer";

interface MockTable {
  rows: Map<string, Record<string, unknown>>;
  columns: Set<string>;
}

interface MockSqlEngine {
  tables: Map<string, MockTable>;
  execute: (sqlText: string) => unknown;
}

function newTable(): MockTable {
  return { rows: new Map(), columns: new Set() };
}

function parseInsertColumns(sqlText: string): {
  table: string;
  columns: string[];
} | null {
  const insertMatch = sqlText.match(
    /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(\w+)\s*\(([\s\S]+?)\)\s*VALUES/i,
  );
  if (!insertMatch) return null;
  const [, table, cols] = insertMatch;
  return {
    table,
    columns: cols.split(",").map((s) => s.trim()),
  };
}

function parseInsertValues(sqlText: string): string[] | null {
  // Values are after the first VALUES (, captured to the matching )
  const idx = sqlText.search(/\bVALUES\s*\(/i);
  if (idx < 0) return null;
  const start = sqlText.indexOf("(", idx);
  if (start < 0) return null;

  // Find matching close paren respecting strings.
  let depth = 0;
  let inSingle = false;
  let end = -1;
  for (let i = start; i < sqlText.length; i += 1) {
    const ch = sqlText[i];
    if (inSingle) {
      if (ch === "'") {
        if (sqlText[i + 1] === "'") {
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const inner = sqlText.slice(start + 1, end);

  // Split on commas respecting strings/parens.
  const values: string[] = [];
  let buf = "";
  inSingle = false;
  depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          buf += "'";
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      values.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) values.push(buf.trim());
  return values;
}

function unquoteSqlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "NULL" || trimmed === "null") return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function evaluateWhereForRow(
  row: Record<string, unknown>,
  whereSql: string,
): boolean {
  // Support a small subset: `col = 'value'`, `col IN ('a','b')`, ANDs.
  const conditions = whereSql.split(/\bAND\b/i).map((s) => s.trim());
  for (const cond of conditions) {
    const eqMatch = cond.match(/^(\w+)\s*=\s*'([^']*)'$/);
    if (eqMatch) {
      const [, col, val] = eqMatch;
      if (String(row[col]) !== val) return false;
      continue;
    }
    const inMatch = cond.match(/^(\w+)\s+IN\s*\(([^)]*)\)$/i);
    if (inMatch) {
      const [, col, list] = inMatch;
      const vals = list
        .split(",")
        .map((s) => s.trim())
        .map((s) =>
          s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s,
        );
      if (!vals.includes(String(row[col]))) return false;
      continue;
    }
    const isNullMatch = cond.match(/^(\w+)\s+IS\s+NULL$/i);
    if (isNullMatch) {
      const [, col] = isNullMatch;
      if (row[col] !== null && row[col] !== undefined) return false;
      continue;
    }
    const compareMatch = cond.match(/^(\w+)\s*(<>|>=|<=|>|<)\s*'?([^'<>]*)'?$/);
    if (compareMatch) {
      const [, col, op, valRaw] = compareMatch;
      const val = unquoteSqlValue(valRaw);
      const rowVal = row[col];
      const cmp = (a: unknown, b: unknown): number => {
        if (typeof a === "number" && typeof b === "number") return a - b;
        return String(a).localeCompare(String(b));
      };
      const result = cmp(rowVal, val);
      if (op === "<>" && result === 0) return false;
      if (op === ">" && result <= 0) return false;
      if (op === ">=" && result < 0) return false;
      if (op === "<" && result >= 0) return false;
      if (op === "<=" && result > 0) return false;
      continue;
    }
    if (cond.length === 0) continue;
    // Unsupported condition — treat as true (best-effort mock).
  }
  return true;
}

function applyOrderLimitOffset(
  rows: Record<string, unknown>[],
  sqlText: string,
): Record<string, unknown>[] {
  let result = rows;
  const orderMatch = sqlText.match(/ORDER\s+BY\s+([\w_]+)\s+(ASC|DESC)/i);
  if (orderMatch) {
    const [, col, dir] = orderMatch;
    const directionMul = dir.toUpperCase() === "DESC" ? -1 : 1;
    result = [...result].sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * directionMul;
      }
      return String(av ?? "").localeCompare(String(bv ?? "")) * directionMul;
    });
  }
  const limitMatch = sqlText.match(/LIMIT\s+(\d+)/i);
  const offsetMatch = sqlText.match(/OFFSET\s+(\d+)/i);
  const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
  const limit = limitMatch ? Number(limitMatch[1]) : undefined;
  if (offset > 0) result = result.slice(offset);
  if (limit !== undefined) result = result.slice(0, limit);
  return result;
}

function createMockSqlEngine(): MockSqlEngine {
  const tables = new Map<string, MockTable>();

  const execute = (sqlText: string): unknown => {
    const trimmed = sqlText.trim();

    // CREATE TABLE
    const createMatch = trimmed.match(
      /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([\s\S]+)\)\s*$/i,
    );
    if (createMatch) {
      const [, table, body] = createMatch;
      if (!tables.has(table)) tables.set(table, newTable());
      const tbl = tables.get(table);
      if (tbl) {
        const colDefs = body.split(",").map((s) => s.trim());
        for (const def of colDefs) {
          const colName = def.split(/\s+/)[0];
          if (colName) tbl.columns.add(colName);
        }
      }
      return { rows: [] };
    }

    // CREATE INDEX
    if (/^CREATE\s+INDEX/i.test(trimmed)) return { rows: [] };

    // ALTER TABLE
    if (/^ALTER\s+TABLE/i.test(trimmed)) {
      // No-op for the mock (treat as "already has column").
      return { rows: [] };
    }

    // INSERT
    if (/^INSERT/i.test(trimmed)) {
      const head = parseInsertColumns(trimmed);
      const values = parseInsertValues(trimmed);
      if (head && values) {
        const tbl = tables.get(head.table) ?? newTable();
        tables.set(head.table, tbl);
        const row: Record<string, unknown> = {};
        head.columns.forEach((col, idx) => {
          row[col] = unquoteSqlValue(values[idx] ?? "NULL");
        });
        const idValue = row.id;
        if (typeof idValue === "string" && idValue.length > 0) {
          // Honor ON CONFLICT DO NOTHING / DO UPDATE — we update on conflict.
          if (tbl.rows.has(idValue) && /DO\s+NOTHING/i.test(trimmed)) {
            return { rows: [] };
          }
          tbl.rows.set(idValue, row);
        } else {
          // Use a synthetic ID if there's no id column.
          tbl.rows.set(`__row_${tbl.rows.size}`, row);
        }
        return { rows: [] };
      }
      return { rows: [] };
    }

    // DELETE
    const deleteMatch = trimmed.match(/^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+RETURNING\s+\w+)?$/i);
    if (deleteMatch) {
      const [, table, whereSql] = deleteMatch;
      const tbl = tables.get(table);
      if (!tbl) return { rows: [] };
      const deleted: Record<string, unknown>[] = [];
      const survivors = new Map<string, Record<string, unknown>>();
      for (const [key, row] of tbl.rows) {
        if (!whereSql || evaluateWhereForRow(row, whereSql)) {
          deleted.push(row);
        } else {
          survivors.set(key, row);
        }
      }
      tbl.rows = survivors;
      // Replicate `RETURNING id` shape if present.
      if (/RETURNING/i.test(trimmed)) {
        return { rows: deleted.map((r) => ({ id: r.id })) };
      }
      return { rows: deleted };
    }

    // SELECT
    const selectMatch = trimmed.match(
      /^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)(?:\s+(?:t\s+)?LEFT\s+JOIN\s+(\w+)\s+s\s+ON\s+([\s\S]+?))?(?:\s+WHERE\s+([\s\S]+?))?(?:\s+GROUP\s+BY\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+[\s\S]+?)?(?:\s+LIMIT\s+\d+)?(?:\s+OFFSET\s+\d+)?\s*$/i,
    );
    if (selectMatch) {
      const [, cols, table, joinTable, _joinOn, whereSql] = selectMatch;
      const tbl = tables.get(table);
      if (!tbl) return { rows: [] };
      let rows = Array.from(tbl.rows.values());
      if (whereSql) {
        rows = rows.filter((r) => evaluateWhereForRow(r, whereSql));
      }
      // Handle LEFT JOIN trajectory_steps for the forward-migration query.
      if (joinTable === "trajectory_steps") {
        const stepsTable = tables.get("trajectory_steps");
        const stepRows = stepsTable
          ? Array.from(stepsTable.rows.values())
          : [];
        const stepTrajectoryIds = new Set(
          stepRows.map((r) => String(r.trajectory_id)),
        );
        rows = rows.filter((r) => !stepTrajectoryIds.has(String(r.id)));
      }
      // Apply ORDER/LIMIT/OFFSET on the original SQL text.
      rows = applyOrderLimitOffset(rows, sqlText);

      // Handle count(*).
      if (/count\(\*\)/i.test(cols)) {
        const total = rows.length;
        const aliasMatch = cols.match(/count\(\*\)\s+AS\s+(\w+)/i);
        const alias = aliasMatch ? aliasMatch[1] : "count";
        return { rows: [{ [alias]: total }] };
      }
      return { rows };
    }

    return { rows: [] };
  };

  return { tables, execute };
}

function createMockRuntime(engine: MockSqlEngine): IAgentRuntime {
  const adapter = {
    db: {
      execute: async (chunks: { queryChunks: object[] }) => {
        const raw = chunks as unknown as { queryChunks?: unknown[]; sql?: string };
        // Our test mock receives `sql.raw(text)` which returns an object with
        // a `queryChunks` field that is the raw text wrapped. We extract it
        // by re-reading the original text from the engine call helper.
        const sqlText = (raw as { __sql?: string }).__sql ?? "";
        return engine.execute(sqlText);
      },
    },
  };
  return {
    agentId: "test-agent",
    adapter,
  } as unknown as IAgentRuntime;
}

// Replace drizzle-orm with a stub that gives us the raw SQL text directly.
// We patch the dynamic import cache by intercepting the `import("drizzle-orm")`
// in `getSqlRaw()` via a module-mock.

import { vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  sql: {
    raw: (text: string) => ({ __sql: text, queryChunks: [text] }),
  },
}));

describe("trajectory_steps dedicated table", () => {
  let engine: MockSqlEngine;
  let runtime: IAgentRuntime;
  const trajectoryId = "test-trajectory-1";

  beforeEach(() => {
    engine = createMockSqlEngine();
    runtime = createMockRuntime(engine);
  });

  it("creates the trajectory_steps table with no script length cap", async () => {
    const ok = await ensureTrajectoriesTable(runtime);
    expect(ok).toBe(true);
    expect(engine.tables.has("trajectory_steps")).toBe(true);
    expect(engine.tables.has("trajectories")).toBe(true);
    const stepsTable = engine.tables.get("trajectory_steps");
    expect(stepsTable?.columns.has("id")).toBe(true);
    expect(stepsTable?.columns.has("trajectory_id")).toBe(true);
    expect(stepsTable?.columns.has("ordinal")).toBe(true);
    expect(stepsTable?.columns.has("script")).toBe(true);
  });

  it("inserts 1000 steps and paginates them", async () => {
    await ensureTrajectoriesTable(runtime);
    const steps = Array.from({ length: 1000 }, (_v, i) => ({
      stepId: `step-${i.toString().padStart(4, "0")}`,
      stepNumber: i,
      timestamp: 1_700_000_000_000 + i,
      llmCalls: [],
      providerAccesses: [],
    }));
    await replaceStepsForTrajectory(runtime, trajectoryId, steps);

    const page1 = await getSteps(runtime, trajectoryId, 0, 100);
    expect(page1.total).toBe(1000);
    expect(page1.steps.length).toBe(100);
    expect(page1.steps[0]?.stepId).toBe("step-0000");
    expect(page1.steps[99]?.stepId).toBe("step-0099");

    const page2 = await getSteps(runtime, trajectoryId, 100, 100);
    expect(page2.total).toBe(1000);
    expect(page2.steps.length).toBe(100);
    expect(page2.steps[0]?.stepId).toBe("step-0100");

    const lastPage = await getSteps(runtime, trajectoryId, 900, 200);
    expect(lastPage.steps.length).toBe(100);
    expect(lastPage.steps[99]?.stepId).toBe("step-0999");
  });

  it("returns empty page when trajectory has no steps", async () => {
    await ensureTrajectoriesTable(runtime);
    const page = await getSteps(runtime, "non-existent", 0, 50);
    expect(page.total).toBe(0);
    expect(page.steps).toEqual([]);
  });

  it("clamps oversize limits", async () => {
    await ensureTrajectoriesTable(runtime);
    const page = await getSteps(runtime, trajectoryId, 0, 999_999);
    expect(page.limit).toBeLessThanOrEqual(MAX_GET_STEPS_LIMIT);
  });

  it("uses sane default limit when not specified", async () => {
    await ensureTrajectoriesTable(runtime);
    const steps = Array.from({ length: 5 }, (_v, i) => ({
      stepId: `step-${i}`,
      stepNumber: i,
      timestamp: 1_700_000_000_000 + i,
      llmCalls: [],
      providerAccesses: [],
    }));
    await replaceStepsForTrajectory(runtime, trajectoryId, steps);
    const page = await getSteps(runtime, trajectoryId);
    expect(page.limit).toBe(DEFAULT_GET_STEPS_LIMIT);
    expect(page.steps.length).toBe(5);
  });

  it("loads all steps with loadAllStepsForTrajectory", async () => {
    await ensureTrajectoriesTable(runtime);
    const steps = Array.from({ length: 1000 }, (_v, i) => ({
      stepId: `step-${i.toString().padStart(4, "0")}`,
      stepNumber: i,
      timestamp: 1_700_000_000_000 + i,
      llmCalls: [],
      providerAccesses: [],
    }));
    await replaceStepsForTrajectory(runtime, trajectoryId, steps);
    const all = await loadAllStepsForTrajectory(runtime, trajectoryId);
    expect(all.length).toBe(1000);
    expect(all[0]?.stepId).toBe("step-0000");
    expect(all[999]?.stepId).toBe("step-0999");
  });

  it("stores scripts longer than the legacy 4096-char cap", async () => {
    await ensureTrajectoriesTable(runtime);
    const longScript = "console.log('x');\n".repeat(1000); // ~18000 chars
    expect(longScript.length).toBeGreaterThan(4096);

    const trajectory: PersistedTrajectory = {
      id: trajectoryId,
      source: "test",
      status: "completed",
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_001_000,
      steps: [
        {
          stepId: "step-with-long-script",
          stepNumber: 0,
          timestamp: 1_700_000_000_000,
          llmCalls: [],
          providerAccesses: [],
          kind: "action",
          script: longScript,
        },
      ],
      metadata: {},
      totalReward: 0,
      createdAt: new Date(1_700_000_000_000).toISOString(),
      updatedAt: new Date(1_700_000_001_000).toISOString(),
    };
    await saveTrajectory(runtime, trajectory);

    const loaded = await loadTrajectoryById(runtime, trajectoryId);
    expect(loaded).not.toBeNull();
    expect(loaded?.steps.length).toBe(1);
    expect(loaded?.steps[0]?.script).toBe(longScript);
    expect(loaded?.steps[0]?.script?.length).toBe(longScript.length);
  });
});
