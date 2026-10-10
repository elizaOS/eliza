/** Shared relation selection for the database API and DATABASE action. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function parseRequestedSchema(
  raw: unknown,
): { ok: true; schema: string | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === "")
    return { ok: true, schema: null };
  if (
    typeof raw !== "string" ||
    raw.includes("\0") ||
    raw === "pg_catalog" ||
    raw === "information_schema"
  )
    return { ok: false };
  return { ok: true, schema: raw };
}

export function qualifiedTable(schema: string, tableName: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(tableName)}`;
}

/** Explicit names are data, including quoted identifiers; omitted schemas use search_path. */
export async function resolveTableSchema(
  execute: (query: string) => Promise<{ rows: Record<string, unknown>[] }>,
  tableName: string,
  requestedSchema: string | null,
): Promise<string | null> {
  const safe = tableName.replace(/'/g, "''");
  const schemaPredicate =
    requestedSchema === null
      ? "pg_catalog.pg_table_is_visible(c.oid)"
      : `n.nspname = '${requestedSchema.replace(/'/g, "''")}'`;
  const { rows } = await execute(`SELECT n.nspname AS schema
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = '${safe}'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND c.relkind IN ('r', 'p')
      AND ${schemaPredicate}
    LIMIT 1`);
  return rows.length > 0 ? String(rows[0].schema) : null;
}
