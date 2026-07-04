/**
 * Real-DB cross-org isolation for provisioning-job reads (#12227 M3).
 *
 * `GET /api/v1/jobs/:jobId` previously set `organizationId = null` for any valid
 * WAIFU service key and called the UNSCOPED `getJob(jobId)` — a single shared
 * service key could read ANY org's provisioning job (status/result/error). The
 * fix scopes every read to the resolved owner org via `getJobForOrg` →
 * `jobsRepository.findByIdAndOrg`. This test proves the underlying SQL denies a
 * cross-org read against the REAL Drizzle query (in-process PGlite), with no row
 * leak.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const PGLITE_TIMEOUT = 60_000;
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b2";
const JOB_A = "00000000-0000-4000-8000-00000000a001";

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let repo: typeof import("../jobs").jobsRepository;
let pgliteReady = true;

async function seedJob(id: string, orgId: string): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO jobs (
      id, type, status, data, attempts, max_attempts, organization_id,
      result, error, scheduled_for, created_at, updated_at
    ) VALUES (
      '${id}', 'agent_provision', 'completed', '{}'::jsonb, 1, 3, '${orgId}',
      '{"secret":"org-a-only"}'::jsonb, NULL, NOW(), NOW(), NOW()
    );`,
  );
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ jobsRepository: repo } = await import("../jobs"));
    await dbWrite.execute(
      `CREATE TABLE IF NOT EXISTS jobs (
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
        organization_id uuid NOT NULL,
        user_id uuid,
        api_key_id uuid,
        generation_id uuid,
        webhook_url text,
        webhook_status text,
        estimated_completion_at timestamp,
        scheduled_for timestamp NOT NULL DEFAULT now(),
        started_at timestamp,
        completed_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );`,
    );
  } catch (error) {
    pgliteReady = false;
    throw new Error(
      `[jobs-scope] PGlite unavailable — this test must run for real: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("jobsRepository — cross-org job read isolation (M3)", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await dbWrite.execute("DELETE FROM jobs;");
    await seedJob(JOB_A, ORG_A);
  });

  test("owner org reads its own job", async () => {
    const job = await repo.findByIdAndOrg(JOB_A, ORG_A);
    expect(job?.id).toBe(JOB_A);
    expect(job?.result).toMatchObject({ secret: "org-a-only" });
  });

  test("a different org gets NOTHING for the same job id (no row leak)", async () => {
    const job = await repo.findByIdAndOrg(JOB_A, ORG_B);
    expect(job).toBeUndefined();
  });

  test("the unscoped path (what the route used to call) would have leaked it", async () => {
    // Documents exactly why the route must never call the unscoped read for a
    // shared service key: findById ignores the org and returns the row.
    const leaked = await repo.findById(JOB_A);
    expect(leaked?.id).toBe(JOB_A);
    // ...but the scoped read the route now uses denies the cross-org caller.
    expect(await repo.findByIdAndOrg(JOB_A, ORG_B)).toBeUndefined();
  });
});
