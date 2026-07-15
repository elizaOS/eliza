/**
 * Real-DB (PGlite) coverage for the stranded agent-sandbox key GC query (#16071).
 *
 * `deleteOlderThan(olderThan)` must delete only active
 * `agent-sandbox:<uuid>` keys whose uuid has NO `agent_sandboxes` row and whose
 * `created_at` predates the grace window. The three acceptance cases from the
 * issue are proven against real SQL (no mocks): a stranded key is returned, an
 * in-flight (young) mint is protected by the grace window, and a key correctly
 * bound to a live sandbox is never returned. PGlite setup is intentionally not
 * swallowed, so a broken backend cannot vacuously pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

let dbWrite: typeof import("../helpers").dbWrite;
let strandedAgentKeyRepository: typeof import("./stranded-agent-keys").strandedAgentKeyRepository;
let closeDatabaseConnectionsForTests: typeof import("../client").closeDatabaseConnectionsForTests;

const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "00000000-0000-4000-8000-0000000000b1";

// Sandbox ids the tests reference. LIVE has a matching agent_sandboxes row.
const SANDBOX_STRANDED = "00000000-0000-4000-8000-0000000000c1";
const SANDBOX_LIVE = "00000000-0000-4000-8000-0000000000c2";
const SANDBOX_INFLIGHT = "00000000-0000-4000-8000-0000000000c3";

let hashCounter = 0;

async function insertKey(params: {
  name: string;
  isActive?: boolean;
  createdAtSql: string;
}): Promise<string> {
  hashCounter += 1;
  const hash = `hash-${hashCounter}-${params.name}`;
  const result = (await dbWrite.execute(sql`
    INSERT INTO api_keys (name, key_hash, key_prefix, organization_id, user_id, is_active, created_at)
    VALUES (
      ${params.name},
      ${hash},
      'eliza_pref',
      ${ORG_ID},
      ${USER_ID},
      ${params.isActive ?? true},
      ${sql.raw(params.createdAtSql)}
    )
    RETURNING id
  `)) as { rows: Array<{ id: string }> };
  return result.rows[0].id;
}

beforeAll(async () => {
  ({ dbWrite } = await import("../helpers"));
  ({ closeDatabaseConnectionsForTests } = await import("../client"));
  ({ strandedAgentKeyRepository } = await import("./stranded-agent-keys"));

  // Minimal shapes: the query only touches api_keys columns + agent_sandboxes.id.
  await dbWrite.execute(sql`
      CREATE TABLE IF NOT EXISTS agent_sandboxes (
        id uuid PRIMARY KEY
      )
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

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM api_keys`);
  await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
  // The LIVE sandbox row exists for the "never touch a bound key" case.
  await dbWrite.execute(sql`INSERT INTO agent_sandboxes (id) VALUES (${SANDBOX_LIVE})`);
});

afterAll(async () => {
  await dbWrite.execute(sql`DROP TABLE IF EXISTS api_keys`);
  await dbWrite.execute(sql`DROP TABLE IF EXISTS agent_sandboxes`);
  await closeDatabaseConnectionsForTests();
});

describe("strandedAgentKeyRepository.deleteOlderThan (#16071)", () => {
  test("returns a stranded key: no sandbox row + past the grace window", async () => {
    const strandedId = await insertKey({
      name: `agent-sandbox:${SANDBOX_STRANDED}`,
      createdAtSql: "now() - interval '1 day'",
    });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h grace
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found.map((k) => k.id)).toEqual([strandedId]);
  });

  test("NEVER touches a key minted moments ago for an in-flight mint (grace window)", async () => {
    // Same stranded shape (no sandbox row) but created just now — still inside
    // the tier-upgrade lock window, so the grace cutoff must exclude it.
    await insertKey({
      name: `agent-sandbox:${SANDBOX_INFLIGHT}`,
      createdAtSql: "now()",
    });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found).toHaveLength(0);
  });

  test("NEVER touches a key correctly bound to a live sandbox", async () => {
    // Old enough to clear the grace window, but its sandbox row EXISTS.
    await insertKey({
      name: `agent-sandbox:${SANDBOX_LIVE}`,
      createdAtSql: "now() - interval '1 day'",
    });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found).toHaveLength(0);
    const remaining = (await dbWrite.execute(sql`
      SELECT id FROM api_keys WHERE name = ${`agent-sandbox:${SANDBOX_LIVE}`}
    `)) as { rows: Array<{ id: string }> };
    expect(remaining.rows).toHaveLength(1);
  });

  test("ignores non-sandbox keys and already-revoked stranded keys", async () => {
    // A user key that merely resembles nothing of the pattern.
    await insertKey({ name: "my personal key", createdAtSql: "now() - interval '1 day'" });
    // An INACTIVE stranded key — already revoked, must not be re-selected.
    await insertKey({
      name: `agent-sandbox:${SANDBOX_STRANDED}`,
      isActive: false,
      createdAtSql: "now() - interval '1 day'",
    });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found).toHaveLength(0);
  });

  test("mixed fixture returns exactly the one stranded, past-grace, active key", async () => {
    const strandedId = await insertKey({
      name: `agent-sandbox:${SANDBOX_STRANDED}`,
      createdAtSql: "now() - interval '1 day'",
    });
    await insertKey({
      name: `agent-sandbox:${SANDBOX_LIVE}`,
      createdAtSql: "now() - interval '1 day'",
    });
    await insertKey({
      name: `agent-sandbox:${SANDBOX_INFLIGHT}`,
      createdAtSql: "now()",
    });
    await insertKey({ name: "eliza cloud key", createdAtSql: "now() - interval '1 day'" });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found.map((k) => k.id)).toEqual([strandedId]);
  });
});
