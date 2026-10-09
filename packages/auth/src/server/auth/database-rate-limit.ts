/** Enforces atomic, restart-safe login attempt budgets in the embedded identity database. */
import { createDatabaseAuthSql } from "./auth-sql";

export async function checkDatabaseAuthRateLimit(
  key: string,
  windowMs: number,
  maximum: number,
): Promise<{ allowed: boolean; retryAfterSecs: number }> {
  const sql = createDatabaseAuthSql();
  const [row] = await sql<Array<{ count: number; remaining_seconds: number }>>`
    INSERT INTO auth_kv_store (id, namespace, value, expires_at)
    VALUES (${key}, 'auth:rate-limit', '1', clock_timestamp() + ${windowMs} * interval '1 millisecond')
    ON CONFLICT (id, namespace) DO UPDATE SET
      value = CASE WHEN auth_kv_store.expires_at <= clock_timestamp()
        THEN '1' ELSE (auth_kv_store.value::integer + 1)::text END,
      expires_at = CASE WHEN auth_kv_store.expires_at <= clock_timestamp()
        THEN clock_timestamp() + ${windowMs} * interval '1 millisecond'
        ELSE auth_kv_store.expires_at END
    RETURNING value::integer AS count,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))))::integer AS remaining_seconds
  `;
  return {
    allowed: row.count <= maximum,
    retryAfterSecs: row.remaining_seconds,
  };
}
