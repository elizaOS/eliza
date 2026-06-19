/**
 * Optional per-tenant Postgres persistence for edad-chat.
 *
 * When edad is deployed on Eliza Cloud with `databaseMode: "isolated"`, the
 * platform provisions an isolated Postgres DB and injects `DATABASE_URL`
 * (reachable only through the per-app DB ambassador — `REVOKE CONNECT` from
 * every other tenant, no general egress). This module persists each chat turn
 * there so a signed-in user's history survives across sessions — exercising the
 * full per-tenant-DB path end to end.
 *
 * Best-effort by design: with no `DATABASE_URL` (or if the DB is briefly
 * unreachable at boot) this is a silent no-op and the chat proxy still works
 * standalone — the example runs anywhere. Uses native `Bun.sql`, no extra dep.
 */

import { SQL } from "bun";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

let sql: SQL | null = null;

/** True once a real per-tenant DB connection + schema are in place. */
export function dbReady(): boolean {
  return sql !== null;
}

/** Connect + ensure the schema. Never throws — falls back to no persistence. */
export async function initDb(): Promise<void> {
  if (!DATABASE_URL) {
    console.log("[edad-chat] database: none (DATABASE_URL unset) — running stateless");
    return;
  }
  try {
    const db = new SQL(DATABASE_URL);
    await db`
      CREATE TABLE IF NOT EXISTS edad_messages (
        id         bigserial   PRIMARY KEY,
        user_ref   text        NOT NULL,
        role       text        NOT NULL,
        content    text        NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
    await db`CREATE INDEX IF NOT EXISTS edad_messages_user_idx ON edad_messages (user_ref, id)`;
    sql = db;
    console.log("[edad-chat] database: connected — per-tenant chat persistence ON");
  } catch (err) {
    sql = null;
    console.error(
      "[edad-chat] database: init failed, continuing without persistence:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Stable per-user key derived from the signed-in user's token. We persist
 * history per user WITHOUT ever storing the token itself (one-way sha256).
 */
export function userRef(userToken: string): string {
  return new Bun.CryptoHasher("sha256").update(userToken).digest("hex").slice(0, 32);
}

/** Append one turn. No-op when there is no DB or the content is empty. */
export async function saveTurn(
  ref: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  if (!sql || !content) return;
  try {
    await sql`INSERT INTO edad_messages (user_ref, role, content) VALUES (${ref}, ${role}, ${content})`;
  } catch (err) {
    console.error("[edad-chat] db saveTurn failed:", err instanceof Error ? err.message : err);
  }
}

/** A user's recent turns, oldest-first. Empty when there is no DB. */
export async function getHistory(
  ref: string,
  limit = 50,
): Promise<Array<{ role: string; content: string; created_at: string }>> {
  if (!sql) return [];
  try {
    const rows = (await sql`
      SELECT role, content, created_at FROM edad_messages
      WHERE user_ref = ${ref}
      ORDER BY id DESC
      LIMIT ${Math.min(Math.max(limit, 1), 200)}`) as Array<{
      role: string;
      content: string;
      created_at: string;
    }>;
    return rows.reverse();
  } catch (err) {
    console.error("[edad-chat] db getHistory failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
