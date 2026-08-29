/** Real-PostgreSQL races for restore-v3 candidate slots and cleanup fences. */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS } from "@elizaos/shared";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import {
  applyCandidateMigrations,
  buildCandidateFixture,
  type CandidateFixture,
  createCandidatePrerequisiteSchema,
  fixtureSha256,
  seedCandidateAuthority,
} from "./agent-backup-restore-v3-candidate-test-fixture";

const dbHelpersActual = await import("../../helpers");
const dbHelpersSnapshot = { ...dbHelpersActual };
interface CommitAcknowledgmentLoss {
  readonly sqlState: "08006" | "57P01";
  readonly afterCommit?: () => Promise<void>;
  intercepted: boolean;
}
let nextCommitAcknowledgmentLoss: CommitAcknowledgmentLoss | undefined;
const realDbWrite = dbHelpersSnapshot.dbWrite;
const wrappedDbWrite = new Proxy(realDbWrite, {
  get(target, property, receiver) {
    if (property === "transaction" && nextCommitAcknowledgmentLoss) {
      return async (...args: Parameters<typeof realDbWrite.transaction>) => {
        const loss = nextCommitAcknowledgmentLoss;
        if (!loss) return target.transaction(...args);
        loss.intercepted = true;
        nextCommitAcknowledgmentLoss = undefined;
        const committed = await target.transaction(...args);
        await loss.afterCommit?.();
        throw Object.assign(new Error("simulated lost PostgreSQL commit acknowledgment"), {
          code: loss.sqlState,
          committedResult: committed,
        });
      };
    }
    return Reflect.get(target, property, receiver);
  },
});
mock.module("../../helpers", () => ({ ...dbHelpersSnapshot, dbWrite: wrappedDbWrite }));

const APPLICATION_NAME = "restore-v3-candidate-postgres-test";
const TEST_TIMEOUT = 120_000;
const REQUIRE_REAL_POSTGRES = process.env.REQUIRE_REAL_POSTGRES_RESTORE_V3_CANDIDATE_TESTS === "1";
const SKIP_REASON =
  "[restore-v3 candidate PostgreSQL] SKIPPED - no real PostgreSQL available. " +
  "Provide APPS_TENANT_DB_TEST_DSN or opt into the ephemeral harness.";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  LOCAL_PG_POOL_MAX: process.env.LOCAL_PG_POOL_MAX,
  RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,
  DISABLE_LOCAL_PGLITE_FALLBACK: process.env.DISABLE_LOCAL_PGLITE_FALLBACK,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
};

type ExecutionRepository = typeof import("../agent-backup-restore-v3-candidate-execution");
type CleanupRepository = typeof import("../agent-backup-restore-v3-candidate-cleanup");
type ClientModule = typeof import("../../client");

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let control: Client | null = null;
let clientModule: ClientModule | undefined;
let executionRepository: ExecutionRepository | undefined;
let cleanupRepository: CleanupRepository | undefined;
let fixture: CandidateFixture;
let cleanupPromise: Promise<void> | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const databaseName = `eliza_restore_v3_candidate_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return { databaseName, dsn: url.toString() };
}

async function cleanupHarnessOnce(): Promise<void> {
  const errors: unknown[] = [];
  const capture = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (cause) {
      errors.push(cause);
    }
  };
  if (clientModule) await capture(() => clientModule!.closeDatabaseConnectionsForTests());
  if (control) await capture(() => control!.end());
  control = null;
  if (postgres && isolatedDatabaseName) {
    const admin = new Client({ connectionString: postgres.dsn });
    await capture(() => admin.connect());
    await capture(() =>
      admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
          "WHERE datname = $1 AND pid <> pg_backend_pid()",
        [isolatedDatabaseName],
      ),
    );
    await capture(() => admin.query(`DROP DATABASE IF EXISTS "${isolatedDatabaseName}"`));
    await capture(() => admin.end());
  }
  if (postgres) await capture(() => postgres!.stop());
  postgres = null;
  isolatedDatabaseName = null;
  isolatedDsn = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "restore-v3 candidate PostgreSQL teardown failed");
  }
}

function cleanupHarness(): Promise<void> {
  cleanupPromise ??= cleanupHarnessOnce();
  return cleanupPromise;
}

async function initializeHarness(): Promise<void> {
  fixture = await buildCandidateFixture();
  if (!postgres) {
    if (REQUIRE_REAL_POSTGRES) throw new Error("Real PostgreSQL is required");
    process.stderr.write(`${SKIP_REASON}\n`);
    return;
  }
  const isolated = await createIsolatedDatabase(postgres.dsn);
  isolatedDatabaseName = isolated.databaseName;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.LOCAL_PG_POOL_MAX = "12";
  process.env.RAILWAY_SERVICE_NAME = APPLICATION_NAME;
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  process.env.NODE_ENV = "test";
  process.env.MOCK_REDIS = "1";
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
  [clientModule, executionRepository, cleanupRepository] = await Promise.all([
    import("../../client"),
    import("../agent-backup-restore-v3-candidate-execution"),
    import("../agent-backup-restore-v3-candidate-cleanup"),
  ]);
  control = new Client({
    connectionString: isolated.dsn,
    application_name: `${APPLICATION_NAME}-control`,
  });
  await control.connect();
}

try {
  await initializeHarness();
} catch (cause) {
  let cleanupFailure: unknown;
  try {
    await cleanupHarness();
  } catch (nested) {
    cleanupFailure = nested;
  }
  if (cleanupFailure !== undefined) {
    throw new AggregateError([cause, cleanupFailure], "PostgreSQL harness setup failed");
  }
  throw cause;
}

const realPostgresTest = postgres ? test : test.skip;

beforeAll(async () => {
  if (!control) return;
  const queryClient = {
    query: (text: string, values?: readonly unknown[]) =>
      control!.query(text, values ? [...values] : undefined),
  };
  await createCandidatePrerequisiteSchema(queryClient);
  await applyCandidateMigrations(queryClient);
  await seedCandidateAuthority(queryClient, fixture);
}, TEST_TIMEOUT);

afterAll(cleanupHarness, TEST_TIMEOUT);

async function waitForCandidateLockWaiters(minimum: number): Promise<number[]> {
  if (!control) throw new Error("PostgreSQL control client is unavailable");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await control.query<{ pid: number }>(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = '${APPLICATION_NAME}'
        AND wait_event_type = 'Lock'
        AND query ILIKE '%agent_backup_restore_v3_candidate_stage_ledger%'
      ORDER BY pid`);
    if (result.rows.length >= minimum) return result.rows.map(({ pid }) => pid);
    await Bun.sleep(20);
  }
  return [];
}

/** Let one real COMMIT finish, then reject its driver promise as a lost ACK. */
async function withLostNextCommitAcknowledgment<T>(input: {
  readonly sqlState: "08006" | "57P01";
  readonly afterCommit?: () => Promise<void>;
  readonly run: () => Promise<T>;
}): Promise<T> {
  if (nextCommitAcknowledgmentLoss) {
    throw new Error("lost-commit-acknowledgment seam is already armed");
  }
  const loss: CommitAcknowledgmentLoss = {
    sqlState: input.sqlState,
    afterCommit: input.afterCommit,
    intercepted: false,
  };
  nextCommitAcknowledgmentLoss = loss;
  try {
    const result = await input.run();
    if (!loss.intercepted) throw new Error("lost-commit-acknowledgment seam was not exercised");
    return result;
  } finally {
    if (nextCommitAcknowledgmentLoss === loss) nextCommitAcknowledgmentLoss = undefined;
  }
}

describe("restore-v3 candidate repository on real PostgreSQL", () => {
  realPostgresTest(
    "serializes exact and divergent slot races across independent sessions",
    async () => {
      if (!isolatedDsn || !control || !executionRepository) {
        throw new Error("PostgreSQL candidate harness is unavailable");
      }
      const execution = executionRepository.createAgentBackupRestoreV3CandidateExecution(
        fixture.sourceAuthority,
      );
      const controlSignal = new AbortController();
      const operationControl = {
        signal: controlSignal.signal,
        deadlineEpochMs: Date.now() + 60_000,
      };
      const session = await execution.begin(
        { authority: fixture.authority, manifest: fixture.manifest },
        operationControl,
      );
      const locker = new Client({
        connectionString: isolatedDsn,
        application_name: `${APPLICATION_NAME}-candidate-locker`,
      });
      await locker.connect();
      try {
        await locker.query("BEGIN");
        await locker.query(
          `SELECT id FROM agent_backup_restore_v3_candidates WHERE id = $1 FOR UPDATE`,
          [session.stagingHandle],
        );
        const exactRecord = {
          componentIndex: 0,
          componentName: "character" as const,
          dataIndex: 0,
          offsetBytes: 0,
          entry: null,
          payload: new TextEncoder().encode("postgres-exact-record"),
        };
        const exactRace = [
          execution.stageRecord(session, exactRecord, operationControl),
          execution.stageRecord(session, exactRecord, operationControl),
        ] as const;
        const waitingPids = await waitForCandidateLockWaiters(2);
        expect(new Set(waitingPids).size).toBeGreaterThanOrEqual(2);
        await locker.query("COMMIT");
        const exactResults = await Promise.all(exactRace);
        expect(exactResults[0]).toEqual(exactResults[1]);
        expect(exactResults[0].payloadSha256).toBe(fixtureSha256("postgres-exact-record"));

        await locker.query("BEGIN");
        await locker.query(
          `SELECT id FROM agent_backup_restore_v3_candidates WHERE id = $1 FOR UPDATE`,
          [session.stagingHandle],
        );
        const divergentRace = [
          execution.stageRecord(
            session,
            {
              componentIndex: 0,
              componentName: "character",
              dataIndex: 1,
              offsetBytes: exactResults[0].payloadBytes,
              entry: null,
              payload: new TextEncoder().encode("postgres-race-left"),
            },
            operationControl,
          ),
          execution.stageRecord(
            session,
            {
              componentIndex: 0,
              componentName: "character",
              dataIndex: 1,
              offsetBytes: exactResults[0].payloadBytes,
              entry: null,
              payload: new TextEncoder().encode("postgres-race-right"),
            },
            operationControl,
          ),
        ] as const;
        const divergentWaiters = await waitForCandidateLockWaiters(2);
        expect(new Set(divergentWaiters).size).toBeGreaterThanOrEqual(2);
        await locker.query("COMMIT");
        const divergentResults = await Promise.allSettled(divergentRace);
        expect(divergentResults.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        expect(divergentResults.filter(({ status }) => status === "rejected")).toHaveLength(1);
        const durable = await control.query<{
          payload_bytes: number | string;
          payload_sha256: string;
        }>(
          `SELECT payload_bytes, payload_sha256
          FROM agent_backup_restore_v3_candidate_stage_ledger
          WHERE candidate_id = $1 AND command_kind = 'record' AND data_index = 1`,
          [session.stagingHandle],
        );
        expect([
          fixtureSha256("postgres-race-left"),
          fixtureSha256("postgres-race-right"),
        ]).toContain(durable.rows[0]?.payload_sha256);
        const divergentPayloadBytes = Number(durable.rows[0]?.payload_bytes);
        expect(Number.isSafeInteger(divergentPayloadBytes)).toBe(true);

        await locker.query("BEGIN");
        await locker.query(
          `SELECT id FROM agent_backup_restore_v3_candidates WHERE id = $1 FOR UPDATE`,
          [session.stagingHandle],
        );
        const deadlineControl = {
          signal: new AbortController().signal,
          deadlineEpochMs: Date.now() + 250,
        };
        const deadlineFailure = await execution
          .stageRecord(
            session,
            {
              componentIndex: 0,
              componentName: "character",
              dataIndex: 2,
              offsetBytes: exactResults[0].payloadBytes + divergentPayloadBytes,
              entry: null,
              payload: new TextEncoder().encode("must-not-land-after-deadline"),
            },
            deadlineControl,
          )
          .then(
            () => null,
            (cause: unknown) => cause,
          );
        expect(deadlineFailure).toBeInstanceOf(DOMException);
        expect((deadlineFailure as DOMException).name).toBe("AbortError");
        await locker.query("COMMIT");
        await Bun.sleep(100);
        const lateMutation = await control.query<{ count: number }>(
          `SELECT count(*)::integer AS count
          FROM agent_backup_restore_v3_candidate_stage_ledger
          WHERE candidate_id = $1 AND command_kind = 'record' AND data_index = 2`,
          [session.stagingHandle],
        );
        expect(lateMutation.rows[0]?.count).toBe(0);

        const finishReceipt = {
          componentIndex: 0,
          componentName: "character" as const,
          descriptor: AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0],
          dataFrameCount: 2,
          payloadBytes: exactResults[0].payloadBytes + divergentPayloadBytes,
          payloadSha256: fixtureSha256("postgres-finished-character"),
          recordStreamContentHmacSha256: fixtureSha256("postgres-character-stream-hmac"),
        };
        const recoveredFinish = await withLostNextCommitAcknowledgment({
          sqlState: "57P01",
          run: () => execution.finishComponent(session, finishReceipt, operationControl),
        });
        expect(recoveredFinish).toEqual(finishReceipt);
        await expect(
          execution.finishComponent(session, finishReceipt, operationControl),
        ).rejects.toThrow();

        await expect(
          execution.stageRecord(
            { ...session, executionToken: "stale-invalid-bearer" },
            {
              componentIndex: 1,
              componentName: "database",
              dataIndex: 0,
              offsetBytes: 0,
              entry: null,
              payload: new Uint8Array(),
            },
            operationControl,
          ),
        ).rejects.toThrow(/differs from this exact execution/);
        await execution.abort(session, "staging-failed", operationControl);
        await expect(
          execution.stageRecord(
            session,
            {
              componentIndex: 1,
              componentName: "database",
              dataIndex: 0,
              offsetBytes: 0,
              entry: null,
              payload: new Uint8Array(),
            },
            operationControl,
          ),
        ).rejects.toThrow();
      } finally {
        await locker.query("ROLLBACK").catch(() => {});
        await locker.end();
      }
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "admits one cleanup claimant, recovers an expired lease atomically, and fences settlement",
    async () => {
      if (!control || !cleanupRepository) {
        throw new Error("PostgreSQL cleanup harness is unavailable");
      }
      const cleanupControl = {
        signal: new AbortController().signal,
        deadlineEpochMs: Date.now() + 60_000,
      };
      await control.query(`
        CREATE OR REPLACE FUNCTION delay_restore_v3_cleanup_claim_for_test()
        RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          IF OLD.state = 'pending' AND NEW.state = 'leased' THEN
            PERFORM pg_sleep(0.2);
          END IF;
          RETURN NEW;
        END
        $body$;
        CREATE TRIGGER aa_delay_restore_v3_cleanup_claim_for_test
        BEFORE UPDATE ON agent_backup_restore_v3_candidate_cleanup_outbox
        FOR EACH ROW EXECUTE FUNCTION delay_restore_v3_cleanup_claim_for_test();
      `);
      const firstGeneration = "30000000-0000-4000-8000-000000000001";
      const competingGeneration = "30000000-0000-4000-8000-000000000002";
      const firstRace = await Promise.all([
        cleanupRepository.claimAgentBackupRestoreV3CandidateCleanup({
          control: cleanupControl,
          ownerId: "postgres-cleanup-a",
          generation: firstGeneration,
          leaseMs: 1_000,
        }),
        cleanupRepository.claimAgentBackupRestoreV3CandidateCleanup({
          control: cleanupControl,
          ownerId: "postgres-cleanup-b",
          generation: competingGeneration,
          leaseMs: 1_000,
        }),
      ]);
      const firstClaims = firstRace.filter((claim) => claim !== null);
      expect(firstClaims).toHaveLength(1);
      expect(firstRace.filter((claim) => claim === null)).toHaveLength(1);
      const firstClaim = firstClaims[0];
      if (!firstClaim) throw new Error("cleanup race produced no winner");
      expect(firstClaim.attempt).toBe(1);
      expect(
        (
          await cleanupRepository.claimAgentBackupRestoreV3CandidateCleanup({
            control: cleanupControl,
            ownerId: firstClaim.ownerId,
            generation: firstClaim.generation,
            leaseMs: 1_000,
          })
        )?.replayed,
      ).toBe(true);

      await control.query("SELECT pg_sleep(1.05)");
      const recoveryGenerationA = "30000000-0000-4000-8000-000000000003";
      const recoveryGenerationB = "30000000-0000-4000-8000-000000000004";
      const recoveryRace = await Promise.all([
        cleanupRepository.claimAgentBackupRestoreV3CandidateCleanup({
          control: cleanupControl,
          ownerId: "postgres-cleanup-c",
          generation: recoveryGenerationA,
          leaseMs: 10_000,
        }),
        cleanupRepository.claimAgentBackupRestoreV3CandidateCleanup({
          control: cleanupControl,
          ownerId: "postgres-cleanup-d",
          generation: recoveryGenerationB,
          leaseMs: 10_000,
        }),
      ]);
      const recoveredClaims = recoveryRace.filter((claim) => claim !== null);
      expect(recoveredClaims).toHaveLength(1);
      expect(recoveryRace.filter((claim) => claim === null)).toHaveLength(1);
      const recovered = recoveredClaims[0];
      if (!recovered) throw new Error("expired cleanup race produced no winner");
      expect(recovered.attempt).toBe(2);
      await expect(
        cleanupRepository.settleAgentBackupRestoreV3CandidateCleanup({
          control: cleanupControl,
          fence: {
            cleanupId: firstClaim.cleanupId,
            ownerId: firstClaim.ownerId,
            generation: firstClaim.generation,
            attempt: firstClaim.attempt,
          },
          cleanupReceiptSha256: fixtureSha256("stale-postgres-cleanup"),
        }),
      ).rejects.toThrow(/exact live owner, generation, and attempt/);
      const receipt = fixtureSha256("postgres-cleanup-receipt");
      const settled = await cleanupRepository.settleAgentBackupRestoreV3CandidateCleanup({
        control: cleanupControl,
        fence: {
          cleanupId: recovered.cleanupId,
          ownerId: recovered.ownerId,
          generation: recovered.generation,
          attempt: recovered.attempt,
        },
        cleanupReceiptSha256: receipt,
      });
      expect(settled.state).toBe("completed");
      const row = await control.query<{
        state: string;
        attempts: number;
        receipt_sha256: string;
        claim_owner: string | null;
        claim_generation: string | null;
        lease_expires_at: Date | null;
      }>(
        `SELECT state, attempts, receipt_sha256, claim_owner,
        claim_generation, lease_expires_at
        FROM agent_backup_restore_v3_candidate_cleanup_outbox
        WHERE id = $1`,
        [recovered.cleanupId],
      );
      expect(row.rows).toEqual([
        {
          state: "completed",
          attempts: 2,
          receipt_sha256: receipt,
          claim_owner: null,
          claim_generation: null,
          lease_expires_at: null,
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "serializes one owner generation across multiple rows and rejects stale lost-ACK recovery",
    async () => {
      if (!control || !cleanupRepository) {
        throw new Error("PostgreSQL cleanup harness is unavailable");
      }
      const cleanupControl = {
        signal: new AbortController().signal,
        deadlineEpochMs: Date.now() + 60_000,
      };
      const insertPending = async (): Promise<string> => {
        const cleanupId = randomUUID();
        const restoreAttemptId = randomUUID();
        await control!.query(
          `INSERT INTO agent_backup_restore_v3_candidate_cleanup_outbox (
            id, organization_id, agent_id, backup_id, restore_attempt_id,
            operation_id, cleanup_command_sha256
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            cleanupId,
            fixture.authority.organizationId,
            fixture.authority.agentId,
            fixture.authority.backupId,
            restoreAttemptId,
            fixture.authority.operationId,
            fixtureSha256(`cleanup-command:${cleanupId}`),
          ],
        );
        await control!.query(
          `UPDATE agent_backup_restore_v3_candidate_cleanup_outbox
          SET state = 'pending' WHERE id = $1`,
          [cleanupId],
        );
        return cleanupId;
      };

      await insertPending();
      await insertPending();
      const sharedOwner = "postgres-cleanup-same-owner";
      const sharedGeneration = "30000000-0000-4000-8000-000000000010";
      const sameGenerationRace = await Promise.all([
        cleanupRepository.claimAgentBackupRestoreV3CandidateCleanup({
          control: cleanupControl,
          ownerId: sharedOwner,
          generation: sharedGeneration,
          leaseMs: 10_000,
        }),
        cleanupRepository.claimAgentBackupRestoreV3CandidateCleanup({
          control: cleanupControl,
          ownerId: sharedOwner,
          generation: sharedGeneration,
          leaseMs: 10_000,
        }),
      ]);
      expect(sameGenerationRace[0]?.cleanupId).toBe(sameGenerationRace[1]?.cleanupId);
      expect(sameGenerationRace.map((claim) => claim?.replayed).sort()).toEqual([false, true]);
      const sharedLeases = await control.query<{ count: number }>(
        `SELECT count(*)::integer AS count
        FROM agent_backup_restore_v3_candidate_cleanup_outbox
        WHERE state = 'leased' AND claim_owner = $1 AND claim_generation = $2`,
        [sharedOwner, sharedGeneration],
      );
      expect(sharedLeases.rows[0]?.count).toBe(1);
      const sharedClaim = sameGenerationRace[0];
      if (!sharedClaim) throw new Error("same-generation race returned no cleanup authority");
      await cleanupRepository.settleAgentBackupRestoreV3CandidateCleanup({
        control: cleanupControl,
        fence: {
          cleanupId: sharedClaim.cleanupId,
          ownerId: sharedClaim.ownerId,
          generation: sharedClaim.generation,
          attempt: sharedClaim.attempt,
        },
        cleanupReceiptSha256: fixtureSha256("same-generation-cleanup-receipt"),
      });

      const lostOwner = "postgres-cleanup-lost-terminal";
      const lostGeneration = "30000000-0000-4000-8000-000000000011";
      let terminalizedCleanupId: string | undefined;
      const lostTerminal = await withLostNextCommitAcknowledgment({
        sqlState: "08006",
        afterCommit: async () => {
          const exact = await control!.query<{ id: string; attempts: number }>(
            `SELECT id, attempts
            FROM agent_backup_restore_v3_candidate_cleanup_outbox
            WHERE state = 'leased' AND claim_owner = $1 AND claim_generation = $2`,
            [lostOwner, lostGeneration],
          );
          const row = exact.rows[0];
          if (!row) throw new Error("lost-ACK cleanup commit did not create its lease");
          terminalizedCleanupId = row.id;
          await cleanupRepository!.settleAgentBackupRestoreV3CandidateCleanup({
            control: cleanupControl,
            fence: {
              cleanupId: row.id,
              ownerId: lostOwner,
              generation: lostGeneration,
              attempt: row.attempts,
            },
            cleanupReceiptSha256: fixtureSha256("lost-ack-terminal-receipt"),
          });
        },
        run: () =>
          cleanupRepository!.claimAgentBackupRestoreV3CandidateCleanup({
            control: cleanupControl,
            ownerId: lostOwner,
            generation: lostGeneration,
            leaseMs: 10_000,
          }),
      }).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect((lostTerminal as { code?: string }).code).toBe("08006");
      const terminalized = await control.query<{ state: string }>(
        `SELECT state FROM agent_backup_restore_v3_candidate_cleanup_outbox WHERE id = $1`,
        [terminalizedCleanupId],
      );
      expect(terminalized.rows[0]?.state).toBe("completed");

      const reassignedSourceId = await insertPending();
      const staleOwner = "postgres-cleanup-lost-reassigned";
      const staleGeneration = "30000000-0000-4000-8000-000000000012";
      const survivorGeneration = "30000000-0000-4000-8000-000000000013";
      let survivor:
        | NonNullable<
            Awaited<ReturnType<CleanupRepository["claimAgentBackupRestoreV3CandidateCleanup"]>>
          >
        | undefined;
      const lostReassigned = await withLostNextCommitAcknowledgment({
        sqlState: "08006",
        afterCommit: async () => {
          const exact = await control!.query<{ id: string; attempts: number }>(
            `SELECT id, attempts
            FROM agent_backup_restore_v3_candidate_cleanup_outbox
            WHERE state = 'leased' AND claim_owner = $1 AND claim_generation = $2`,
            [staleOwner, staleGeneration],
          );
          const row = exact.rows[0];
          if (!row) throw new Error("lost-ACK reassignment source lease is missing");
          await cleanupRepository!.deferAgentBackupRestoreV3CandidateCleanup({
            control: cleanupControl,
            fence: {
              cleanupId: row.id,
              ownerId: staleOwner,
              generation: staleGeneration,
              attempt: row.attempts,
            },
            delayMs: 1,
          });
          await Bun.sleep(5);
          survivor =
            (await cleanupRepository!.claimAgentBackupRestoreV3CandidateCleanup({
              control: cleanupControl,
              ownerId: "postgres-cleanup-survivor",
              generation: survivorGeneration,
              leaseMs: 10_000,
            })) ?? undefined;
        },
        run: () =>
          cleanupRepository!.claimAgentBackupRestoreV3CandidateCleanup({
            control: cleanupControl,
            ownerId: staleOwner,
            generation: staleGeneration,
            leaseMs: 10_000,
          }),
      }).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect((lostReassigned as { code?: string }).code).toBe("08006");
      expect(survivor?.cleanupId).toBe(reassignedSourceId);
      if (!survivor) throw new Error("cleanup reassignment produced no survivor fence");
      await cleanupRepository.settleAgentBackupRestoreV3CandidateCleanup({
        control: cleanupControl,
        fence: {
          cleanupId: survivor.cleanupId,
          ownerId: survivor.ownerId,
          generation: survivor.generation,
          attempt: survivor.attempt,
        },
        cleanupReceiptSha256: fixtureSha256("reassigned-survivor-receipt"),
      });
    },
    TEST_TIMEOUT,
  );
});
