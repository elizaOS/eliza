import type { AgentRuntime } from "@elizaos/core";

const repairedRuntimes = new WeakSet<AgentRuntime>();
const repairPromises = new WeakMap<AgentRuntime, Promise<void>>();

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function sanitizeIdentifier(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_]/g, "");
  if (sanitized.length === 0 || sanitized.length > 128) return null;
  return sanitized;
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function executeRawSql(
  runtime: AgentRuntime,
  sqlText: string,
): Promise<{
  rows: Record<string, unknown>[];
  columns: string[];
}> {
  const db = runtime.adapter?.db as
    | {
        execute: (query: { queryChunks: unknown[] }) => Promise<{
          rows: Record<string, unknown>[];
          fields?: Array<{ name: string }>;
        }>;
      }
    | undefined;

  if (!db?.execute) {
    throw new Error("Database adapter not available");
  }

  const { sql } = await import("drizzle-orm");
  const result = await db.execute(sql.raw(sqlText));
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const columns = Array.isArray(result.fields)
    ? result.fields.map((field) => field.name)
    : Object.keys(rows[0] ?? {});

  return { rows, columns };
}

async function getTableColumnNames(
  runtime: AgentRuntime,
  tableName: string,
  schemaName = "public",
): Promise<Set<string>> {
  const columns = new Set<string>();

  try {
    const { rows } = await executeRawSql(
      runtime,
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = ${sqlLiteral(schemaName)}
          AND table_name = ${sqlLiteral(tableName)}
        ORDER BY ordinal_position`,
    );

    for (const row of rows) {
      const value = row.column_name;
      if (typeof value === "string" && value.length > 0) {
        columns.add(value);
      }
    }
  } catch {
    // Fall through to PRAGMA for PGlite/SQLite compatibility.
  }

  if (columns.size > 0) {
    return columns;
  }

  try {
    const safeTableName = sanitizeIdentifier(tableName);
    if (!safeTableName) {
      return columns;
    }

    const { rows } = await executeRawSql(
      runtime,
      `PRAGMA table_info(${safeTableName})`,
    );

    for (const row of rows) {
      const value = row.name;
      if (typeof value === "string" && value.length > 0) {
        columns.add(value);
      }
    }
  } catch {
    // Ignore missing-table/missing-pragma support.
  }

  return columns;
}

async function addColumnIfMissing(
  runtime: AgentRuntime,
  tableName: string,
  columnName: string,
  definition: string,
): Promise<void> {
  const columns = await getTableColumnNames(runtime, tableName);
  if (columns.has(columnName)) {
    return;
  }

  throw new Error(
    `[sql-compat] Missing required column ${quoteIdent(tableName)}.${quoteIdent(columnName)} (${definition}). Run the appropriate database migrations before starting the app.`,
  );
}

export async function ensureRuntimeSqlCompatibility(
  runtime: AgentRuntime | null | undefined,
): Promise<void> {
  if (!runtime?.adapter?.db) {
    return;
  }

  if (repairedRuntimes.has(runtime)) {
    return;
  }

  const existingRepair = repairPromises.get(runtime);
  if (existingRepair) {
    await existingRepair;
    return;
  }

  const repairPromise = (async () => {
    await addColumnIfMissing(
      runtime,
      "participants",
      "agent_id",
      'uuid REFERENCES "agents"("id") ON DELETE CASCADE',
    );
    await addColumnIfMissing(runtime, "participants", "room_state", "text");

    for (const [columnName, definition] of [
      ["step_count", "integer NOT NULL DEFAULT 0"],
      ["llm_call_count", "integer NOT NULL DEFAULT 0"],
      ["total_prompt_tokens", "integer NOT NULL DEFAULT 0"],
      ["total_completion_tokens", "integer NOT NULL DEFAULT 0"],
      ["total_reward", "real NOT NULL DEFAULT 0"],
      ["scenario_id", "text"],
      ["batch_id", "text"],
    ] as const) {
      await addColumnIfMissing(runtime, "trajectories", columnName, definition);
    }

    repairedRuntimes.add(runtime);
  })().finally(() => {
    repairPromises.delete(runtime);
  });

  repairPromises.set(runtime, repairPromise);
  await repairPromise;
}
