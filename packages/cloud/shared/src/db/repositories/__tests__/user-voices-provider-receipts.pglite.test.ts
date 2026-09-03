/**
 * Proves voice-clone provider receipts are append-only and immediately durable
 * against a real in-process PGlite database.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

const JOB_ID = "10000000-0000-4000-8000-000000000001";

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests;
let repository: typeof import("../user-voices").userVoicesRepository;

beforeAll(async () => {
  process.env.DATABASE_URL = "pglite://memory";
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  const client = await import("../../client");
  dbWrite = client.dbWrite;
  closeDb = client.closeDatabaseConnectionsForTests;
  ({ userVoicesRepository: repository } = await import("../user-voices"));

  const pglite = client.getPgliteClientForTests();
  if (!pglite) throw new Error("PGlite test client was not initialized");
  await pglite.exec(`
    CREATE TABLE voice_cloning_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      job_type text NOT NULL,
      voice_name text NOT NULL,
      voice_description text,
      status text NOT NULL DEFAULT 'pending',
      progress integer NOT NULL DEFAULT 0,
      user_voice_id uuid,
      elevenlabs_voice_id text,
      error_message text,
      retry_count integer NOT NULL DEFAULT 0,
      idempotency_key text,
      request_digest text,
      response_payload jsonb,
      metadata jsonb NOT NULL DEFAULT '{}',
      started_at timestamp,
      completed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX voice_cloning_jobs_tenant_idempotency_uidx
      ON voice_cloning_jobs (organization_id, user_id, idempotency_key);
  `);
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM voice_cloning_jobs`);
  await dbWrite.execute(sql`
    INSERT INTO voice_cloning_jobs (
      id, organization_id, user_id, job_type, voice_name, status, metadata
    ) VALUES (
      ${JOB_ID},
      '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      'professional',
      'Receipt Test',
      'processing',
      '{"fileCount":1}'::jsonb
    )
  `);
});

test("appends step receipts and retains the provider voice locator", async () => {
  await repository.recordCloningJobProviderReceipt({
    jobId: JOB_ID,
    step: "create",
    state: "submitted",
    now: new Date("2026-09-02T12:00:00.000Z"),
  });
  await repository.recordCloningJobProviderReceipt({
    jobId: JOB_ID,
    step: "create",
    state: "accepted",
    elevenlabsVoiceId: "pvc-receipt-1",
    now: new Date("2026-09-02T12:00:01.000Z"),
  });
  await repository.recordCloningJobProviderReceipt({
    jobId: JOB_ID,
    step: "samples",
    state: "submission_unknown",
    elevenlabsVoiceId: "pvc-receipt-1",
    errorMessage: "upstream connection closed",
    now: new Date("2026-09-02T12:00:02.000Z"),
  });
  await repository.markCloningJobReconciliationRequired(
    JOB_ID,
    "ElevenLabs samples submission outcome is unknown",
    new Date("2026-09-02T12:00:03.000Z"),
  );

  const result = await dbWrite.execute(sql`
    SELECT elevenlabs_voice_id, error_message, metadata
    FROM voice_cloning_jobs
    WHERE id = ${JOB_ID}
  `);
  const row = result.rows[0] as {
    elevenlabs_voice_id: string;
    error_message: string;
    metadata: {
      fileCount: number;
      providerSubmissionState: string;
      providerLastStep: string;
      providerReceipts: Array<Record<string, unknown>>;
    };
  };

  expect(row.elevenlabs_voice_id).toBe("pvc-receipt-1");
  expect(row.error_message).toBe("ElevenLabs samples submission outcome is unknown");
  expect(row.metadata).toMatchObject({
    fileCount: 1,
    providerSubmissionState: "submission_unknown",
    providerLastStep: "samples",
    reconciliationRequired: true,
    reconciliationRequestedAt: "2026-09-02T12:00:03.000Z",
  });
  expect(row.metadata.providerReceipts).toEqual([
    {
      provider: "elevenlabs",
      step: "create",
      state: "submitted",
      recordedAt: "2026-09-02T12:00:00.000Z",
    },
    {
      provider: "elevenlabs",
      step: "create",
      state: "accepted",
      recordedAt: "2026-09-02T12:00:01.000Z",
      elevenlabsVoiceId: "pvc-receipt-1",
    },
    {
      provider: "elevenlabs",
      step: "samples",
      state: "submission_unknown",
      recordedAt: "2026-09-02T12:00:02.000Z",
      elevenlabsVoiceId: "pvc-receipt-1",
      errorMessage: "upstream connection closed",
    },
  ]);
});

test("atomically fences tenant-scoped idempotency keys", async () => {
  await dbWrite.execute(sql`DELETE FROM voice_cloning_jobs`);
  const organizationId = "20000000-0000-4000-8000-000000000001";
  const userId = "30000000-0000-4000-8000-000000000001";
  const base = {
    organizationId,
    userId,
    jobType: "instant" as const,
    voiceName: "Fence Test",
    status: "processing" as const,
    idempotencyKey: "voice-fence-1",
    requestDigest: "digest-a",
  };

  const first = await repository.createOrReadCloningJob(base);
  const replay = await repository.createOrReadCloningJob(base);
  const conflict = await repository.createOrReadCloningJob({
    ...base,
    requestDigest: "digest-b",
  });
  const otherUser = await repository.createOrReadCloningJob({
    ...base,
    userId: "30000000-0000-4000-8000-000000000002",
  });

  expect(first.created).toBe(true);
  expect(replay).toMatchObject({
    created: false,
    job: { id: first.job.id, requestDigest: "digest-a" },
  });
  expect(conflict).toMatchObject({
    created: false,
    job: { id: first.job.id, requestDigest: "digest-a" },
  });
  expect(otherUser.created).toBe(true);
  expect(otherUser.job.id).not.toBe(first.job.id);
});

test("elects exactly one winner under concurrent same-key inserts", async () => {
  await dbWrite.execute(sql`DELETE FROM voice_cloning_jobs`);
  const input = {
    organizationId: "20000000-0000-4000-8000-000000000001",
    userId: "30000000-0000-4000-8000-000000000001",
    jobType: "instant" as const,
    voiceName: "Concurrent Fence Test",
    status: "processing" as const,
    idempotencyKey: "voice-concurrent-1",
    requestDigest: "digest-concurrent",
  };

  const results = await Promise.all(
    Array.from({ length: 8 }, () => repository.createOrReadCloningJob(input)),
  );

  expect(results.filter((result) => result.created)).toHaveLength(1);
  expect(new Set(results.map((result) => result.job.id))).toEqual(new Set([results[0]?.job.id]));
});
