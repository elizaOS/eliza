/**
 * Drives the authenticated cron route through the real sweeper and PGlite,
 * proving one request deletes only expired orphan credentials end to end.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const OLD_ORPHAN = "00000000-0000-4000-8000-0000000000c1";
const LIVE_SANDBOX = "00000000-0000-4000-8000-0000000000c2";
const YOUNG_ORPHAN = "00000000-0000-4000-8000-0000000000c3";
const CRON_SECRET = "integration-cron-secret";

let dbWrite: typeof import("@/db/helpers").dbWrite;
let closeDatabaseConnectionsForTests: typeof import("@/db/client").closeDatabaseConnectionsForTests;
let route: typeof import("../cron/gc-stranded-sandbox-keys/route").default;

beforeAll(async () => {
  ({ dbWrite } = await import("@/db/helpers"));
  ({ closeDatabaseConnectionsForTests } = await import("@/db/client"));
  route = (await import("../cron/gc-stranded-sandbox-keys/route")).default;

  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_sandboxes (id uuid PRIMARY KEY)
  `);
  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      key_hash text NOT NULL UNIQUE,
      key_prefix text NOT NULL,
      key_ciphertext text, key_nonce text, key_auth_tag text,
      key_kms_key_id text, key_kms_key_version integer,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      rate_limit integer NOT NULL DEFAULT 1000,
      is_active boolean NOT NULL DEFAULT true,
      usage_count integer NOT NULL DEFAULT 0,
      expires_at timestamp,
      last_used_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      deleted_at timestamp
    )
  `);
});

afterAll(async () => {
  await dbWrite.execute(sql`DROP TABLE IF EXISTS api_keys`);
  await dbWrite.execute(sql`DROP TABLE IF EXISTS agent_sandboxes`);
  await closeDatabaseConnectionsForTests();
});

async function insertKey(sandboxId: string, age: "old" | "young") {
  await dbWrite.execute(sql`
    INSERT INTO api_keys (
      name, key_hash, key_prefix, organization_id, user_id, created_at
    ) VALUES (
      ${`agent-sandbox:${sandboxId}`},
      ${`hash-${sandboxId}`},
      'eliza_e2e',
      '00000000-0000-4000-8000-0000000000a1',
      '00000000-0000-4000-8000-0000000000b1',
      ${age === "old" ? sql`now() - interval '1 day'` : sql`now()`}
    )
  `);
}

async function keyNames(): Promise<string[]> {
  const result = (await dbWrite.execute(sql`
    SELECT name FROM api_keys ORDER BY name
  `)) as { rows: Array<{ name: string }> };
  return result.rows.map((row) => row.name);
}

describe("gc-stranded-sandbox-keys route integration", () => {
  test("revokes an expired orphan while preserving live and in-flight keys", async () => {
    await dbWrite.execute(sql`DELETE FROM api_keys`);
    await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
    await dbWrite.execute(
      sql`INSERT INTO agent_sandboxes (id) VALUES (${LIVE_SANDBOX})`,
    );
    await insertKey(OLD_ORPHAN, "old");
    await insertKey(LIVE_SANDBOX, "old");
    await insertKey(YOUNG_ORPHAN, "young");

    expect(await keyNames()).toEqual([
      `agent-sandbox:${OLD_ORPHAN}`,
      `agent-sandbox:${LIVE_SANDBOX}`,
      `agent-sandbox:${YOUNG_ORPHAN}`,
    ]);

    const response = await route.request(
      "/",
      { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } },
      { CRON_SECRET },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      revoked: 1,
      graceMs: 6 * 60 * 60 * 1000,
    });
    expect(await keyNames()).toEqual([
      `agent-sandbox:${LIVE_SANDBOX}`,
      `agent-sandbox:${YOUNG_ORPHAN}`,
    ]);
  });
});
