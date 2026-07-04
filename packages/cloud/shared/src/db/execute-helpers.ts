// Coordinates cloud DB execute helpers behavior shared by repositories and services.
import type { SQLWrapper } from "drizzle-orm";

export interface SqlExecutor {
  execute(query: SQLWrapper): Promise<unknown>;
}

/**
 * `Database#execute` resolves to a driver-specific shape; with `PgQueryResultHKT` it is typed as unknown.
 * This helper validates the Neon/Node `{ rows }` shape used across the repo.
 */
export async function sqlRows<T extends object>(db: SqlExecutor, query: SQLWrapper): Promise<T[]> {
  const result = await db.execute(query);
  if (typeof result !== "object" || result === null || !("rows" in result)) {
    throw new Error("[sqlRows] execute() did not return an object with rows");
  }
  const { rows } = result as { rows: unknown };
  if (!Array.isArray(rows)) {
    throw new Error("[sqlRows] execute().rows is not an array");
  }
  return rows as T[];
}

/** Row count from delete/update without returning(), when the driver exposes `rowCount`. */
export function mutateRowCount(result: unknown): number {
  if (typeof result !== "object" || result === null || !("rowCount" in result)) {
    return 0;
  }
  const n = (result as { rowCount: unknown }).rowCount;
  return typeof n === "number" ? n : 0;
}
