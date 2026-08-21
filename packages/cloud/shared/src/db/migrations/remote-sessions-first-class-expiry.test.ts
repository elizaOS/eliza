/**
 * Applies the exact remote-session migrations to an isolated PGlite database
 * in deployment order — 0068 creates the status CHECK, 0275 widens it — so the
 * terminal `expired` state is proven against the constraint production really
 * carries rather than against a hand-built fixture table that omits it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const createUrl = new URL("./0068_add_remote_sessions.sql", import.meta.url);
const expiryUrl = new URL("./0275_remote_sessions_first_class_expiry.sql", import.meta.url);

const organizationId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const agentId = "30000000-0000-4000-8000-000000000001";

let pg: PGlite;
let createSource = "";
let expirySource = "";

async function apply(source: string, target: PGlite = pg): Promise<void> {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await target.exec(statement);
  }
}

/** Stands in for the referenced tenant tables owned by earlier migrations. */
async function createReferencedTables(target: PGlite = pg): Promise<void> {
  await target.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE eliza_sandboxes (id uuid PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('${organizationId}');
    INSERT INTO users (id) VALUES ('${userId}');
    INSERT INTO eliza_sandboxes (id) VALUES ('${agentId}');
  `);
}

async function insertPending(id: string, target: PGlite = pg): Promise<void> {
  await target.query(
    `INSERT INTO remote_sessions
       (id, organization_id, user_id, agent_id, status, requester_identity)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'pending', $5::text)`,
    [id, organizationId, userId, agentId, userId],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  createSource = await Bun.file(createUrl).text();
  expirySource = await Bun.file(expiryUrl).text();
  await createReferencedTables();
  await apply(createSource);
  await apply(expirySource);
});

beforeEach(async () => {
  await pg.exec("DELETE FROM remote_sessions");
});

afterAll(async () => {
  await pg.close();
});

describe("remote session first-class expiry migration", () => {
  test("0068 alone rejects the expired status the lifecycle now writes", async () => {
    // Isolated so this reproduces the deployed pre-0275 shape no matter what
    // order the suite runs in. This is the production failure the PR's
    // hand-built fixture masked by omitting the CHECK entirely.
    const legacy = new PGlite();
    try {
      await createReferencedTables(legacy);
      await apply(createSource, legacy);
      await insertPending("40000000-0000-4000-8000-000000000001", legacy);
      await expect(legacy.exec("UPDATE remote_sessions SET status = 'expired'")).rejects.toThrow(
        /remote_sessions_status_check/,
      );
    } finally {
      await legacy.close();
    }
  });

  test("0275 widens the deployed CHECK so the expiry transition commits", async () => {
    await insertPending("40000000-0000-4000-8000-000000000002");

    await pg.exec(
      "UPDATE remote_sessions SET status = 'expired', ended_at = now() WHERE status = 'pending'",
    );
    const rows = await pg.query<{ status: string; ended_at: Date | null }>(
      "SELECT status, ended_at FROM remote_sessions",
    );
    expect(rows.rows[0]?.status).toBe("expired");
    expect(rows.rows[0]?.ended_at).not.toBeNull();
  });

  test("the widened CHECK still rejects statuses outside the lifecycle", async () => {
    await insertPending("40000000-0000-4000-8000-000000000003");
    await expect(pg.exec("UPDATE remote_sessions SET status = 'compromised'")).rejects.toThrow(
      /remote_sessions_status_check/,
    );
  });

  test("re-applying 0275 keeps exactly one widened constraint and the expiry column", async () => {
    await apply(expirySource);
    const constraints = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
       WHERE conname = 'remote_sessions_status_check'`,
    );
    expect(constraints.rows[0]?.count).toBe("1");

    const columns = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'remote_sessions' AND column_name = 'expires_at'`,
    );
    expect(columns.rows).toHaveLength(1);
  });
});
