/**
 * Exercises JobsRepository.findByFilters against real in-process PGlite.
 * Zero, omitted, and positive limits must retain distinct SQL semantics.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const USER_ID = "00000000-0000-4000-8000-00000000a002";
const PGLITE_TIMEOUT = 60_000;

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests;
let repo: typeof import("../jobs").jobsRepository;

beforeAll(async () => {
  const client = await import("../../client");
  dbWrite = client.dbWrite;
  closeDb = client.closeDatabaseConnectionsForTests;
  const mod = await import("../jobs");
  repo = mod.jobsRepository;
  await dbWrite.execute(`
      CREATE TABLE IF NOT EXISTS jobs (
        id uuid PRIMARY KEY,
        type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        data jsonb NOT NULL,
        data_storage text NOT NULL DEFAULT 'inline',
        data_key text,
        agent_id text,
        character_id text,
        result jsonb,
        result_storage text NOT NULL DEFAULT 'inline',
        result_key text,
        error text,
        error_storage text NOT NULL DEFAULT 'inline',
        error_key text,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        execution_interruptions integer NOT NULL DEFAULT 0,
        retryable_requeues integer NOT NULL DEFAULT 0,
        organization_id uuid NOT NULL,
        user_id uuid,
        api_key_id uuid,
        generation_id uuid,
        webhook_url text,
        webhook_status text,
        estimated_completion_at timestamp,
        scheduled_for timestamp NOT NULL DEFAULT NOW(),
        started_at timestamp,
        execution_generation uuid,
        execution_quiesced_at timestamp,
        completed_at timestamp,
        created_at timestamp NOT NULL DEFAULT NOW(),
        updated_at timestamp NOT NULL DEFAULT NOW()
      )
  `);
  await dbWrite.execute(`
      CREATE TABLE IF NOT EXISTS organizations (id uuid PRIMARY KEY, name text, slug text)
  `);
  await dbWrite.execute(`
      CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, organization_id uuid, steward_user_id text)
  `);
  await dbWrite.execute(
    `INSERT INTO organizations (id, name, slug) VALUES ('${ORG_ID}', 'test-org', 'test-org') ON CONFLICT DO NOTHING`,
  );
  await dbWrite.execute(
    `INSERT INTO users (id, organization_id, steward_user_id) VALUES ('${USER_ID}', '${ORG_ID}', 'steward') ON CONFLICT DO NOTHING`,
  );
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  await dbWrite.execute(`DELETE FROM jobs WHERE organization_id = '${ORG_ID}'`);
});

afterAll(async () => {
  await closeDb();
});

describe("JobsRepository.findByFilters limit=0 (real PGlite)", () => {
  test("limit=0 returns 0 rows, undefined returns all, positive caps", async () => {
    for (let i = 0; i < 3; i++) {
      await dbWrite.execute(`
        INSERT INTO jobs (id, type, status, data, organization_id, user_id, scheduled_for, created_at, updated_at)
        VALUES (gen_random_uuid(), 'agent_message', 'pending', '{}'::jsonb, '${ORG_ID}', '${USER_ID}', NOW(), NOW(), NOW())
      `);
    }
    const allUndefined = await repo.findByFilters({ organizationId: ORG_ID });
    expect(allUndefined.length).toBe(3);

    const withZero = await repo.findByFilters({ organizationId: ORG_ID, limit: 0 });
    expect(withZero.length).toBe(0);

    const withOne = await repo.findByFilters({ organizationId: ORG_ID, limit: 1 });
    expect(withOne.length).toBe(1);

    const withTwo = await repo.findByFilters({ organizationId: ORG_ID, limit: 2 });
    expect(withTwo.length).toBe(2);
    expect(withZero.length).not.toBe(allUndefined.length);
  });
});
