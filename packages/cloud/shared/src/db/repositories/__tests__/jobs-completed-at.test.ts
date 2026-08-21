/**
 * Exercises the terminal-timestamp contract: every transition into a terminal
 * status (failed, cancelled, completed) sets `completed_at` transactionally,
 * and retry transitions back to `pending` clear it. Uses real PGlite state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "../../../lib/storage/r2-runtime-binding";
import { type Job, jobs } from "../../schemas/jobs";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const PGLITE_TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-000000009000";
const ACTOR_ID = "00000000-0000-4000-8000-000000009001";
const AGENT_ID = "00000000-0000-4000-8000-000000009002";
const JOB_STARTED_AT = new Date("2020-01-01T00:00:00.000Z");

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let repo: typeof import("../jobs").jobsRepository;

function memoryBucket(objects: Map<string, string>): RuntimeR2Bucket {
  return {
    async get(key) {
      const value = objects.get(key);
      return value === undefined
        ? null
        : {
            async text() {
              return value;
            },
          };
    },
    async put(key, value) {
      objects.set(key, typeof value === "string" ? value : String(value ?? ""));
      return {};
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
  };
}

async function seedJob(params: {
  id: string;
  maxAttempts: number;
  attempts?: number;
  type?: string;
}): Promise<void> {
  await dbWrite.insert(jobs).values({
    id: params.id,
    type: params.type ?? "agent_message",
    status: "in_progress",
    data: {},
    data_storage: "inline",
    attempts: params.attempts ?? 0,
    max_attempts: params.maxAttempts,
    organization_id: ORG_ID,
    user_id: ACTOR_ID,
    agent_id: AGENT_ID,
    scheduled_for: JOB_STARTED_AT,
    started_at: JOB_STARTED_AT,
    created_at: JOB_STARTED_AT,
    updated_at: JOB_STARTED_AT,
  });
}

async function seedLease(jobId: string, generation: string, ownerId: string): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO job_execution_leases (job_id, execution_generation, owner_id, expires_at) VALUES ('${jobId}', '${generation}', '${ownerId}', NOW() + INTERVAL '60 seconds')`,
  );
}

async function getJob(id: string): Promise<Job | undefined> {
  return await repo.findById(id);
}

beforeAll(async () => {
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
				execution_interruptions integer NOT NULL DEFAULT 0,
				retryable_requeues integer NOT NULL DEFAULT 0,
				organization_id uuid NOT NULL,
				user_id uuid,
				api_key_id uuid,
				generation_id uuid,
				webhook_url text,
				webhook_status text,
				estimated_completion_at timestamp,
				scheduled_for timestamp NOT NULL DEFAULT now(),
				started_at timestamp,
				execution_generation uuid,
				execution_quiesced_at timestamp,
				completed_at timestamp,
				created_at timestamp NOT NULL DEFAULT now(),
				updated_at timestamp NOT NULL DEFAULT now()
			)`,
  );
  await dbWrite.execute(
    `CREATE TABLE IF NOT EXISTS job_execution_leases (
				job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
				execution_generation uuid NOT NULL,
				owner_id text NOT NULL,
				expires_at timestamp NOT NULL,
				heartbeat_at timestamp NOT NULL DEFAULT now(),
				created_at timestamp NOT NULL DEFAULT now(),
				PRIMARY KEY (job_id, execution_generation, owner_id)
			)`,
  );
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("completed_at terminal-timestamp contract", () => {
  beforeEach(async () => {
    setRuntimeR2Bucket(null);
    delete process.env.SQL_HEAVY_PAYLOAD_STORAGE;
    delete process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES;
    await dbWrite.execute("DELETE FROM jobs;");
  });

  describe("updateStatus", () => {
    test("sets completed_at when status is failed", async () => {
      const id = "00000000-0000-4900-8000-000000000001";
      await seedJob({ id, maxAttempts: 1 });
      await repo.updateStatus(id, "failed");
      const job = await getJob(id);
      expect(job?.status).toBe("failed");
      expect(job?.completed_at).not.toBeNull();
    });

    test("sets completed_at when status is cancelled", async () => {
      const id = "00000000-0000-4900-8000-000000000002";
      await seedJob({ id, maxAttempts: 1 });
      await repo.updateStatus(id, "cancelled");
      const job = await getJob(id);
      expect(job?.status).toBe("cancelled");
      expect(job?.completed_at).not.toBeNull();
    });

    test("sets completed_at when status is completed", async () => {
      const id = "00000000-0000-4900-8000-000000000003";
      await seedJob({ id, maxAttempts: 1 });
      await repo.updateStatus(id, "completed");
      const job = await getJob(id);
      expect(job?.status).toBe("completed");
      expect(job?.completed_at).not.toBeNull();
    });

    test("clears completed_at when status transitions to pending", async () => {
      const id = "00000000-0000-4900-8000-000000000004";
      await seedJob({ id, maxAttempts: 1 });
      await repo.updateStatus(id, "completed");
      let job = await getJob(id);
      expect(job?.completed_at).not.toBeNull();
      await repo.updateStatus(id, "pending");
      job = await getJob(id);
      expect(job?.status).toBe("pending");
      expect(job?.completed_at).toBeNull();
    });

    test("respects explicit completed_at in additionalFields", async () => {
      const id = "00000000-0000-4900-8000-000000000005";
      const explicitDate = new Date("2021-06-15T12:00:00.000Z");
      await seedJob({ id, maxAttempts: 1 });
      await repo.updateStatus(id, "failed", { completed_at: explicitDate });
      const job = await getJob(id);
      expect(job?.completed_at).toEqual(explicitDate);
    });

    test("does not move completed_at when a terminal row is updated again", async () => {
      const id = "00000000-0000-4900-8000-000000000006";
      await seedJob({ id, maxAttempts: 1 });
      await repo.updateStatus(id, "failed");
      const terminalAt = (await getJob(id))?.completed_at;
      expect(terminalAt).not.toBeNull();

      await repo.updateStatus(id, "failed", { webhook_status: "delivered" });
      const job = await getJob(id);
      expect(job?.completed_at).toEqual(terminalAt);
      expect(job?.webhook_status).toBe("delivered");
    });

    test("replaces a stale timestamp when a non-terminal row becomes terminal", async () => {
      const id = "00000000-0000-4900-8000-000000000007";
      const staleDate = new Date("2021-06-15T12:00:00.000Z");
      await seedJob({ id, maxAttempts: 1 });
      await dbWrite.update(jobs).set({ completed_at: staleDate }).where(eq(jobs.id, id));

      await repo.updateStatus(id, "failed");

      const job = await getJob(id);
      expect(job?.status).toBe("failed");
      expect(job?.completed_at).not.toEqual(staleDate);
      expect(job?.completed_at?.getTime()).toBeGreaterThan(staleDate.getTime());
    });
  });

  describe("incrementAttempt", () => {
    test("sets completed_at when attempt exhaustion flips to failed", async () => {
      const id = "00000000-0000-4900-8000-000000000010";
      await seedJob({ id, maxAttempts: 1, attempts: 0 });
      await repo.incrementAttempt(id, "boom", 1);
      const job = await getJob(id);
      expect(job?.status).toBe("failed");
      expect(job?.completed_at).not.toBeNull();
    });

    test("terminalizes a JSON-round-tripped deletion job without calling toISOString on a string", async () => {
      const id = "00000000-0000-4900-8000-000000000012";
      await seedJob({ id, maxAttempts: 1, attempts: 0, type: "agent_delete" });
      const stored = await repo.findById(id);
      if (!stored) throw new Error("seeded job not found");
      const roundTripped = JSON.parse(JSON.stringify(stored)) as Job;
      const findSpy = spyOn(repo, "findByIdForWrite").mockResolvedValueOnce(roundTripped);
      const objects = new Map<string, string>();
      setRuntimeR2Bucket(memoryBucket(objects));
      process.env.SQL_HEAVY_PAYLOAD_STORAGE = "r2";
      process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES = "1";

      try {
        const failed = await repo.incrementAttempt(id, "delete failed", 1);
        expect(failed?.status).toBe("failed");
        expect(failed?.scheduled_for).toEqual(JOB_STARTED_AT);
        expect(failed?.completed_at).not.toBeNull();
        expect(failed?.error).toBe("delete failed");
        expect([...objects.keys()]).toEqual([`job-payloads/${ORG_ID}/2020-01-01/${id}/error.txt`]);
      } finally {
        findSpy.mockRestore();
        setRuntimeR2Bucket(null);
        delete process.env.SQL_HEAVY_PAYLOAD_STORAGE;
        delete process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES;
      }
    });

    test("keeps completed_at null on retry (not yet exhausted)", async () => {
      const id = "00000000-0000-4900-8000-000000000011";
      await seedJob({ id, maxAttempts: 3, attempts: 0 });
      await repo.incrementAttempt(id, "transient", 3);
      const job = await getJob(id);
      expect(job?.status).toBe("pending");
      expect(job?.completed_at).toBeNull();
    });
  });

  describe("settleExecution", () => {
    test("sets completed_at when status is completed", async () => {
      const id = "00000000-0000-4900-8000-000000000020";
      const generation = "a0000000-0000-4000-8000-000000000020";
      const ownerId = "owner-1";
      await seedJob({ id, maxAttempts: 1 });
      await dbWrite.update(jobs).set({ execution_generation: generation }).where(eq(jobs.id, id));
      await seedLease(id, generation, ownerId);
      const claimed = await repo.findById(id);
      if (!claimed) throw new Error("seeded job not found");
      await repo.settleExecution(claimed, "completed", undefined, ownerId);
      const job = await getJob(id);
      expect(job?.status).toBe("completed");
      expect(job?.completed_at).not.toBeNull();
    });

    test("sets completed_at when status is cancelled", async () => {
      const id = "00000000-0000-4900-8000-000000000021";
      const generation = "a0000000-0000-4000-8000-000000000021";
      const ownerId = "owner-2";
      await seedJob({ id, maxAttempts: 1 });
      await dbWrite.update(jobs).set({ execution_generation: generation }).where(eq(jobs.id, id));
      await seedLease(id, generation, ownerId);
      const claimed = await repo.findById(id);
      if (!claimed) throw new Error("seeded job not found");
      await repo.settleExecution(claimed, "cancelled", undefined, ownerId);
      const job = await getJob(id);
      expect(job?.status).toBe("cancelled");
      expect(job?.completed_at).not.toBeNull();
    });

    test("replaces a stale timestamp when settling a claimed execution", async () => {
      const id = "00000000-0000-4900-8000-000000000022";
      const generation = "a0000000-0000-4000-8000-000000000022";
      const ownerId = "owner-3";
      const staleDate = new Date("2021-06-15T12:00:00.000Z");
      await seedJob({ id, maxAttempts: 1 });
      await dbWrite
        .update(jobs)
        .set({ execution_generation: generation, completed_at: staleDate })
        .where(eq(jobs.id, id));
      await seedLease(id, generation, ownerId);
      const claimed = await repo.findById(id);
      if (!claimed) throw new Error("seeded job not found");

      await repo.settleExecution(claimed, "completed", undefined, ownerId);

      const job = await getJob(id);
      expect(job?.status).toBe("completed");
      expect(job?.completed_at).not.toEqual(staleDate);
      expect(job?.completed_at?.getTime()).toBeGreaterThan(staleDate.getTime());
    });
  });

  describe("retryLaterWithoutIncrementingAttempts", () => {
    test("clears completed_at on retry", async () => {
      const id = "00000000-0000-4900-8000-000000000030";
      const generation = "b0000000-0000-4000-8000-000000000030";
      const ownerId = "owner-3";
      await seedJob({ id, maxAttempts: 1 });
      await dbWrite.update(jobs).set({ execution_generation: generation }).where(eq(jobs.id, id));
      await seedLease(id, generation, ownerId);
      const claimed = await repo.findById(id);
      if (!claimed) throw new Error("seeded job not found");
      await repo.retryLaterWithoutIncrementingAttempts(claimed, "ambiguity", 5000, ownerId);
      const job = await getJob(id);
      expect(job?.status).toBe("pending");
      expect(job?.completed_at).toBeNull();
    });

    test("requires and accepts the fresh row after an intermediate result write", async () => {
      const id = "00000000-0000-4900-8000-000000000031";
      const generation = "b0000000-0000-4000-8000-000000000031";
      const ownerId = "owner-fresh";
      await seedJob({ id, maxAttempts: 3 });
      await dbWrite.update(jobs).set({ execution_generation: generation }).where(eq(jobs.id, id));
      await seedLease(id, generation, ownerId);
      const claimed = await repo.findById(id);
      if (!claimed) throw new Error("seeded job not found");

      const fresh = await repo.updateForExecution(
        claimed,
        { result: { error: "transport unresolved" } },
        ownerId,
      );
      const staleTransition = await repo.retryLaterWithoutIncrementingAttempts(
        claimed,
        "transport unresolved",
        5000,
        ownerId,
        { maxRequeues: 5 },
      );
      expect(staleTransition).toBeUndefined();

      const transitioned = await repo.retryLaterWithoutIncrementingAttempts(
        fresh,
        "transport unresolved",
        5000,
        ownerId,
        { maxRequeues: 5 },
      );
      expect(transitioned).toMatchObject({
        status: "pending",
        attempts: 0,
        retryable_requeues: 1,
        result: { error: "transport unresolved" },
      });
    });

    test("allows the exact bounded requeue before terminal exhaustion", async () => {
      const id = "00000000-0000-4900-8000-000000000035";
      const generation = "b0000000-0000-4000-8000-000000000035";
      const ownerId = "owner-bound-edge";
      await seedJob({ id, maxAttempts: 3 });
      await dbWrite
        .update(jobs)
        .set({ execution_generation: generation, retryable_requeues: 4 })
        .where(eq(jobs.id, id));
      await seedLease(id, generation, ownerId);
      const claimed = await repo.findById(id);
      if (!claimed) throw new Error("seeded job not found");

      const transitioned = await repo.retryLaterWithoutIncrementingAttempts(
        claimed,
        "last bounded retry",
        5000,
        ownerId,
        { maxRequeues: 5 },
      );

      expect(transitioned).toMatchObject({
        status: "pending",
        retryable_requeues: 5,
        completed_at: null,
      });
    });

    test("settles terminally with its dependent write when the bound is exhausted", async () => {
      const id = "00000000-0000-4900-8000-000000000032";
      const generation = "b0000000-0000-4000-8000-000000000032";
      const ownerId = "owner-bound";
      await seedJob({ id, maxAttempts: 3 });
      await dbWrite
        .update(jobs)
        .set({ execution_generation: generation, retryable_requeues: 5 })
        .where(eq(jobs.id, id));
      await seedLease(id, generation, ownerId);
      const claimed = await repo.findById(id);
      if (!claimed) throw new Error("seeded job not found");

      const transitioned = await repo.retryLaterWithoutIncrementingAttempts(
        claimed,
        "transport still unresolved",
        5000,
        ownerId,
        {
          maxRequeues: 5,
          onExhaustedInTx: async (tx, failedJob) => {
            expect(failedJob).toMatchObject({ status: "failed", retryable_requeues: 6 });
            await tx
              .update(jobs)
              .set({ webhook_status: "dependent-settled" })
              .where(eq(jobs.id, failedJob.id));
          },
        },
      );

      expect(transitioned).toMatchObject({ status: "failed", retryable_requeues: 6 });
      const persisted = await getJob(id);
      expect(persisted).toMatchObject({
        status: "failed",
        attempts: 0,
        retryable_requeues: 6,
        webhook_status: "dependent-settled",
      });
      expect(persisted?.completed_at).not.toBeNull();
    });

    test("rolls the terminal transition back when its dependent write fails", async () => {
      const id = "00000000-0000-4900-8000-000000000034";
      const generation = "b0000000-0000-4000-8000-000000000034";
      const ownerId = "owner-bound-rollback";
      await seedJob({ id, maxAttempts: 3 });
      await dbWrite
        .update(jobs)
        .set({ execution_generation: generation, retryable_requeues: 5 })
        .where(eq(jobs.id, id));
      await seedLease(id, generation, ownerId);
      const claimed = await repo.findById(id);
      if (!claimed) throw new Error("seeded job not found");

      await expect(
        repo.retryLaterWithoutIncrementingAttempts(
          claimed,
          "transport still unresolved",
          5000,
          ownerId,
          {
            maxRequeues: 5,
            onExhaustedInTx: async () => {
              throw new Error("dependent write rejected");
            },
          },
        ),
      ).rejects.toThrow("dependent write rejected");

      expect(await getJob(id)).toMatchObject({
        status: "in_progress",
        retryable_requeues: 5,
        completed_at: null,
      });
    });

    test("lets only one contender spend a bounded transition", async () => {
      const id = "00000000-0000-4900-8000-000000000033";
      const generation = "b0000000-0000-4000-8000-000000000033";
      const ownerId = "owner-race";
      await seedJob({ id, maxAttempts: 3 });
      await dbWrite.update(jobs).set({ execution_generation: generation }).where(eq(jobs.id, id));
      await seedLease(id, generation, ownerId);
      const claimed = await repo.findById(id);
      if (!claimed) throw new Error("seeded job not found");

      const transitions = await Promise.all([
        repo.retryLaterWithoutIncrementingAttempts(claimed, "retry", 5000, ownerId, {
          maxRequeues: 5,
        }),
        repo.retryLaterWithoutIncrementingAttempts(claimed, "retry", 5000, ownerId, {
          maxRequeues: 5,
        }),
      ]);

      expect(transitions.filter(Boolean)).toHaveLength(1);
      expect(await getJob(id)).toMatchObject({ status: "pending", retryable_requeues: 1 });
    });
  });

  describe("recoverStaleJobs", () => {
    test("sets completed_at when stale recovery exhausts attempts", async () => {
      const id = "00000000-0000-4900-8000-000000000040";
      await seedJob({ id, maxAttempts: 1 });

      const result = await repo.recoverStaleJobs({
        type: "agent_message",
        staleThresholdMs: 1,
      });

      expect(result).toMatchObject({ permanentlyFailed: 1, retried: 0, failures: [] });
      const job = await getJob(id);
      expect(job?.status).toBe("failed");
      expect(job?.completed_at).not.toBeNull();
    });

    test("keeps completed_at null when stale recovery requeues", async () => {
      const id = "00000000-0000-4900-8000-000000000041";
      await seedJob({ id, maxAttempts: 3 });

      const result = await repo.recoverStaleJobs({
        type: "agent_message",
        staleThresholdMs: 1,
      });

      expect(result).toMatchObject({ permanentlyFailed: 0, retried: 1, failures: [] });
      const job = await getJob(id);
      expect(job?.status).toBe("pending");
      expect(job?.completed_at).toBeNull();
    });

    test("rolls completed_at back with the terminal flip when a dependent write fails", async () => {
      const id = "00000000-0000-4900-8000-000000000042";
      await seedJob({ id, maxAttempts: 1 });

      const result = await repo.recoverStaleJobs({
        type: "agent_message",
        staleThresholdMs: 1,
        buildFailureWriteback: () => async () => {
          throw new Error("dependent row is locked");
        },
      });

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.cause).toEqual(
        expect.objectContaining({ message: "dependent row is locked" }),
      );
      const job = await getJob(id);
      expect(job?.status).toBe("in_progress");
      expect(job?.attempts).toBe(0);
      expect(job?.completed_at).toBeNull();
    });
  });
});
