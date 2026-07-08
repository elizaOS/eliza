/**
 * Real-DB coverage for stale job recovery respecting each row's max_attempts.
 *
 * The provisioning daemon enqueues some non-idempotent jobs with max_attempts=1.
 * If a worker dies while such a row is in_progress, stale recovery must fail it
 * instead of re-queueing it under a generic service-level retry budget.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { jobs } from "../../schemas/jobs";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const PGLITE_TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-000000001854";

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let repo: typeof import("../jobs").jobsRepository;
let pgliteReady = true;

async function seedJob(params: {
  id: string;
  maxAttempts: number;
  attempts?: number;
}): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO jobs (
			id,
			type,
			status,
			data,
			attempts,
			max_attempts,
			organization_id,
			scheduled_for,
			started_at,
			created_at,
			updated_at
		)
		VALUES (
			'${params.id}',
			'agent_message',
			'in_progress',
			'{}'::jsonb,
			${params.attempts ?? 0},
			${params.maxAttempts},
			'${ORG_ID}',
			NOW() - INTERVAL '10 minutes',
			NOW() - INTERVAL '10 minutes',
			NOW() - INTERVAL '10 minutes',
			NOW() - INTERVAL '10 minutes'
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
    console.warn("[jobs-recovery] PGlite unavailable, skipping:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("jobsRepository.recoverStaleJobs", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await dbWrite.execute("DELETE FROM jobs;");
  });

  test("uses each stale row's max_attempts instead of a caller-wide fallback", async () => {
    if (!pgliteReady) return;
    const singleAttemptJobId = "00000000-0000-4000-8000-000000010854";
    const retryableJobId = "00000000-0000-4000-8000-000000020854";
    await seedJob({ id: singleAttemptJobId, maxAttempts: 1 });
    await seedJob({ id: retryableJobId, maxAttempts: 3 });

    const recovered = await repo.recoverStaleJobs({
      type: "agent_message",
      staleThresholdMs: 5 * 60 * 1000,
      maxAttempts: 3,
    });

    expect(recovered).toBe(1);
    const rows = await dbWrite
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        error: jobs.error,
      })
      .from(jobs)
      .orderBy(jobs.id);

    const singleAttempt = rows.find((row) => row.id === singleAttemptJobId);
    const retryable = rows.find((row) => row.id === retryableJobId);
    expect(singleAttempt).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "Job timed out 1 times - max attempts reached",
    });
    expect(retryable).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Job timed out - recovered for retry (attempt 1/3)",
    });
  });

  test("recovers in-progress rows claimed before a replacement worker started", async () => {
    if (!pgliteReady) return;
    const interruptedJobId = "00000000-0000-4000-8000-000000030854";
    const currentJobId = "00000000-0000-4000-8000-000000040854";

    await seedJob({ id: interruptedJobId, maxAttempts: 3 });
    await seedJob({ id: currentJobId, maxAttempts: 3 });
    await dbWrite.execute(
      `UPDATE jobs
       SET started_at = NOW() + INTERVAL '1 minute'
       WHERE id = '${currentJobId}';`,
    );

    const recovered = await repo.recoverInProgressJobsStartedBefore({
      type: "agent_message",
      startedBefore: new Date(),
    });

    expect(recovered).toBe(1);
    const rows = await dbWrite
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        error: jobs.error,
      })
      .from(jobs)
      .orderBy(jobs.id);

    const interrupted = rows.find((row) => row.id === interruptedJobId);
    const current = rows.find((row) => row.id === currentJobId);
    expect(interrupted).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Job interrupted by worker restart - recovered for retry (attempt 1/3)",
    });
    expect(current).toMatchObject({
      status: "in_progress",
      attempts: 0,
      error: null,
    });
  });
});
