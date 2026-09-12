/** Independent-client PostgreSQL races for candidate seal authorization and terminal replay. */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import {
  applyCandidateMigrations,
  buildCandidateFixture,
  type CandidateFixture,
  completeCandidate,
  createCandidatePrerequisiteSchema,
  seedAdditionalCandidateAttempt,
  seedCandidateAuthority,
  withAdditionalAttempt,
} from "./agent-backup-restore-v3-candidate-test-fixture";

const dbHelpersActual = await import("../../helpers");
const dbHelpersSnapshot = { ...dbHelpersActual };
interface CommitAcknowledgmentLoss {
  readonly sqlState: "08006" | "40003" | "57P01" | "57P02";
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
        throw Object.assign(new Error("simulated lost PostgreSQL COMMIT acknowledgement"), {
          code: loss.sqlState,
          committedResult: committed,
        });
      };
    }
    return Reflect.get(target, property, receiver);
  },
});
mock.module("../../helpers", () => ({ ...dbHelpersSnapshot, dbWrite: wrappedDbWrite }));

const APPLICATION_NAME = "restore-v3-candidate-seal-postgres-test";
const TEST_TIMEOUT = 120_000;
const REQUIRE_REAL_POSTGRES =
  process.env.REQUIRE_REAL_POSTGRES_RESTORE_V3_CANDIDATE_SEAL_TESTS === "1";
const SKIP_REASON =
  "[restore-v3 candidate seal PostgreSQL] SKIPPED - no real PostgreSQL available. " +
  "Provide APPS_TENANT_DB_TEST_DSN or opt into the named ephemeral harness.";

const ATTEMPT_B = {
  restoreAttemptId: "50000000-0000-4000-8000-000000000001",
  leaseId: "50000000-0000-4000-8000-000000000002",
  leaseGeneration: "50000000-0000-4000-8000-000000000003",
  restoreOperationId: "50000000-0000-4000-8000-000000000004",
} as const;
const ATTEMPT_C = {
  restoreAttemptId: "50000000-0000-4000-8000-000000000011",
  leaseId: "50000000-0000-4000-8000-000000000012",
  leaseGeneration: "50000000-0000-4000-8000-000000000013",
  restoreOperationId: "50000000-0000-4000-8000-000000000014",
} as const;
const ATTEMPT_D = {
  restoreAttemptId: "50000000-0000-4000-8000-000000000021",
  leaseId: "50000000-0000-4000-8000-000000000022",
  leaseGeneration: "50000000-0000-4000-8000-000000000023",
  restoreOperationId: "50000000-0000-4000-8000-000000000024",
} as const;
const ATTEMPT_E = {
  restoreAttemptId: "50000000-0000-4000-8000-000000000031",
  leaseId: "50000000-0000-4000-8000-000000000032",
  leaseGeneration: "50000000-0000-4000-8000-000000000033",
  restoreOperationId: "50000000-0000-4000-8000-000000000034",
} as const;
const ATTEMPT_F = {
  restoreAttemptId: "50000000-0000-4000-8000-000000000041",
  leaseId: "50000000-0000-4000-8000-000000000042",
  leaseGeneration: "50000000-0000-4000-8000-000000000043",
  restoreOperationId: "50000000-0000-4000-8000-000000000044",
} as const;
const ATTEMPT_G = {
  restoreAttemptId: "50000000-0000-4000-8000-000000000051",
  leaseId: "50000000-0000-4000-8000-000000000052",
  leaseGeneration: "50000000-0000-4000-8000-000000000053",
  restoreOperationId: "50000000-0000-4000-8000-000000000054",
} as const;
const ATTEMPT_H = {
  restoreAttemptId: "50000000-0000-4000-8000-000000000061",
  leaseId: "50000000-0000-4000-8000-000000000062",
  leaseGeneration: "50000000-0000-4000-8000-000000000063",
  restoreOperationId: "50000000-0000-4000-8000-000000000064",
} as const;

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

type ClientModule = typeof import("../../client");
type ExecutionRepository = typeof import("../agent-backup-restore-v3-candidate-execution");
type SealRepository = typeof import("../agent-backup-restore-v3-candidate-seal-authority");

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let control: Client | null = null;
let clientModule: ClientModule | undefined;
let executionRepository: ExecutionRepository | undefined;
let sealRepository: SealRepository | undefined;
let fixture: CandidateFixture;
let cleanupPromise: Promise<void> | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  readonly databaseName: string;
  readonly dsn: string;
}> {
  const databaseName = `eliza_restore_v3_candidate_seal_${randomUUID().replaceAll("-", "")}`;
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
    throw new AggregateError(errors, "restore-v3 candidate seal PostgreSQL teardown failed");
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
  [clientModule, executionRepository, sealRepository] = await Promise.all([
    import("../../client"),
    import("../agent-backup-restore-v3-candidate-execution"),
    import("../agent-backup-restore-v3-candidate-seal-authority"),
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

function withLeaseSnapshotExpiry(
  candidateFixture: CandidateFixture,
  leaseExpiresAtEpochMs: number,
): CandidateFixture {
  return Object.freeze({
    ...candidateFixture,
    authority: Object.freeze({
      ...candidateFixture.authority,
      leaseExpiresAtEpochMs,
    }),
  });
}

async function waitForCandidateInsertLockWaiter(relation: string): Promise<number | null> {
  if (!control) throw new Error("PostgreSQL control client is unavailable");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await control.query<{ pid: number }>(
      `
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = '${APPLICATION_NAME}'
        AND wait_event_type = 'Lock'
        AND query ILIKE $1
      ORDER BY pid LIMIT 1`,
      [`%${relation}%`],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await Bun.sleep(20);
  }
  return null;
}

async function settleAcrossBackupLockPastExpiry<T>(input: {
  readonly relation: string;
  readonly expiresAtEpochMs: number;
  readonly run: () => Promise<T>;
}): Promise<PromiseSettledResult<T>> {
  if (!isolatedDsn) throw new Error("PostgreSQL candidate seal DSN is unavailable");
  const locker = new Client({
    connectionString: isolatedDsn,
    application_name: `${APPLICATION_NAME}-expiry-locker`,
  });
  await locker.connect();
  let pending: Promise<T> | undefined;
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM agent_sandbox_backups WHERE id = $1 FOR UPDATE", [
      fixture.authority.backupId,
    ]);
    pending = input.run();
    const waiter = await waitForCandidateInsertLockWaiter(input.relation);
    if (waiter === null) throw new Error(`No PostgreSQL lock waiter for ${input.relation}`);
    await Bun.sleep(Math.max(1, input.expiresAtEpochMs - Date.now() + 75));
    await locker.query("COMMIT");
    const [outcome] = await Promise.allSettled([pending]);
    if (!outcome) throw new Error("PostgreSQL expiry outcome is missing");
    return outcome;
  } finally {
    await locker.query("ROLLBACK").catch(() => {});
    await locker.end();
    if (pending) await Promise.allSettled([pending]);
  }
}

function errorChainText(cause: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = cause;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string") messages.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join("\n");
}

async function withLostNextCommitAcknowledgment<T>(input: {
  readonly sqlState: "08006" | "40003" | "57P01" | "57P02";
  readonly afterCommit?: () => Promise<void>;
  readonly run: () => Promise<T>;
}): Promise<T> {
  if (nextCommitAcknowledgmentLoss) {
    throw new Error("lost-COMMIT-acknowledgement seam is already armed");
  }
  const loss: CommitAcknowledgmentLoss = {
    sqlState: input.sqlState,
    afterCommit: input.afterCommit,
    intercepted: false,
  };
  nextCommitAcknowledgmentLoss = loss;
  try {
    const result = await input.run();
    if (!loss.intercepted) throw new Error("lost-COMMIT-acknowledgement seam was not exercised");
    return result;
  } finally {
    if (nextCommitAcknowledgmentLoss === loss) nextCommitAcknowledgmentLoss = undefined;
  }
}

describe("restore-v3 candidate seal repository on real PostgreSQL", () => {
  realPostgresTest(
    "serializes authority invalidation, two seals, seal/abort, and lost-COMMIT replay",
    async () => {
      if (!control || !isolatedDsn || !executionRepository || !sealRepository) {
        throw new Error("PostgreSQL candidate seal harness is unavailable");
      }
      const operationControl = Object.freeze({
        signal: new AbortController().signal,
        deadlineEpochMs: Date.now() + 90_000,
      });
      const queryClient = {
        query: (text: string, values?: readonly unknown[]) =>
          control!.query(text, values ? [...values] : undefined),
      };

      const executionA = executionRepository.createAgentBackupRestoreV3CandidateExecution(
        fixture.sourceAuthority,
      );
      const candidateA = await completeCandidate(executionA, fixture, operationControl);
      const authorizationA = await sealRepository
        .createAgentBackupRestoreV3CandidateSealAuthority()
        .authorize(candidateA.authorizationRequest, operationControl);

      const fixtureB = withAdditionalAttempt(fixture, ATTEMPT_B);
      await seedAdditionalCandidateAttempt(queryClient, fixtureB, ATTEMPT_B);
      const executionB = executionRepository.createAgentBackupRestoreV3CandidateExecution(
        fixtureB.sourceAuthority,
      );
      const candidateB = await completeCandidate(executionB, fixtureB, operationControl);
      const authorizationB = await sealRepository
        .createAgentBackupRestoreV3CandidateSealAuthority()
        .authorize(candidateB.authorizationRequest, operationControl);

      const fixtureC = withAdditionalAttempt(fixture, ATTEMPT_C);
      await seedAdditionalCandidateAttempt(queryClient, fixtureC, ATTEMPT_C);
      const executionC = executionRepository.createAgentBackupRestoreV3CandidateExecution(
        fixtureC.sourceAuthority,
      );
      const candidateC = await completeCandidate(executionC, fixtureC, operationControl);
      const authorityC = sealRepository.createAgentBackupRestoreV3CandidateSealAuthority();
      const authorizationC = await authorityC.authorize(
        candidateC.authorizationRequest,
        operationControl,
      );
      expect(await authorityC.authorize(candidateC.authorizationRequest, operationControl)).toEqual(
        authorizationC,
      );
      const authorityLocker = new Client({
        connectionString: isolatedDsn,
        application_name: `${APPLICATION_NAME}-authority-locker`,
      });
      await authorityLocker.connect();
      try {
        await authorityLocker.query("BEGIN");
        await authorityLocker.query(
          "SELECT id FROM agent_sandbox_backups WHERE id = $1 FOR UPDATE",
          [fixture.authority.backupId],
        );
        const pendingAuthorization = authorityC.authorize(
          candidateC.authorizationRequest,
          operationControl,
        );
        expect(
          await waitForCandidateInsertLockWaiter(
            "agent_backup_restore_v3_candidate_seal_authorizations",
          ),
        ).not.toBeNull();
        await authorityLocker.query(
          "UPDATE agent_sandbox_backups SET catalog_state = 'deleted' WHERE id = $1",
          [fixture.authority.backupId],
        );
        await authorityLocker.query("COMMIT");
        await expect(pendingAuthorization).rejects.toThrow();
        const absentAuthorization = await control.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM agent_backup_restore_v3_candidate_seal_authorizations
           WHERE candidate_id = $1`,
          [candidateC.session.stagingHandle],
        );
        expect(absentAuthorization.rows[0]?.count).toBe(1);
      } finally {
        await authorityLocker.query("ROLLBACK").catch(() => {});
        await authorityLocker.end();
      }
      await control.query(
        "UPDATE agent_sandbox_backups SET catalog_state = 'protected' WHERE id = $1",
        [fixture.authority.backupId],
      );
      await executionC.abort(candidateC.session, "staging-failed", operationControl);

      const authorizeExpiry = Date.now() + 2_500;
      const fixtureE = withLeaseSnapshotExpiry(
        withAdditionalAttempt(fixture, ATTEMPT_E),
        authorizeExpiry,
      );
      await seedAdditionalCandidateAttempt(queryClient, fixtureE, ATTEMPT_E);
      const executionE = executionRepository.createAgentBackupRestoreV3CandidateExecution(
        fixtureE.sourceAuthority,
      );
      const candidateE = await completeCandidate(executionE, fixtureE, operationControl);
      const expiredAuthorize = await settleAcrossBackupLockPastExpiry({
        relation: "agent_backup_restore_v3_candidate_seal_authorizations",
        expiresAtEpochMs: authorizeExpiry,
        run: async () =>
          await sealRepository!
            .createAgentBackupRestoreV3CandidateSealAuthority()
            .authorize(candidateE.authorizationRequest, operationControl),
      });
      expect(expiredAuthorize.status).toBe("rejected");
      if (expiredAuthorize.status === "rejected") {
        expect(errorChainText(expiredAuthorize.reason)).toMatch(
          /seal authorization lacks current candidate authority/,
        );
      }
      await Bun.sleep(50);
      const noLateAuthorize = await control.query<{
        authorization_count: number;
        candidate_state: string;
        terminal_count: number;
      }>(
        `SELECT candidate.state AS candidate_state,
          (SELECT count(*)::integer
           FROM agent_backup_restore_v3_candidate_seal_authorizations AS seal_auth
           WHERE seal_auth.candidate_id = candidate.id) AS authorization_count,
          (SELECT count(*)::integer
           FROM agent_backup_restore_v3_candidate_terminal_commands AS terminal
           WHERE terminal.candidate_id = candidate.id) AS terminal_count
         FROM agent_backup_restore_v3_candidates AS candidate WHERE candidate.id = $1`,
        [candidateE.session.stagingHandle],
      );
      expect(noLateAuthorize.rows).toEqual([
        { authorization_count: 0, candidate_state: "active", terminal_count: 0 },
      ]);
      await executionE.abort(candidateE.session, "staging-failed", operationControl);

      const sealExpiry = Date.now() + 2_500;
      const fixtureF = withLeaseSnapshotExpiry(
        withAdditionalAttempt(fixture, ATTEMPT_F),
        sealExpiry,
      );
      await seedAdditionalCandidateAttempt(queryClient, fixtureF, ATTEMPT_F);
      const executionF = executionRepository.createAgentBackupRestoreV3CandidateExecution(
        fixtureF.sourceAuthority,
      );
      const candidateF = await completeCandidate(executionF, fixtureF, operationControl);
      const authorityF = sealRepository.createAgentBackupRestoreV3CandidateSealAuthority();
      const authorizationF = await authorityF.authorize(
        candidateF.authorizationRequest,
        operationControl,
      );
      const expiredSeal = await settleAcrossBackupLockPastExpiry({
        relation: "agent_backup_restore_v3_candidate_terminal_commands",
        expiresAtEpochMs: authorizationF.expiresAtEpochMs,
        run: () =>
          sealRepository!.sealAgentBackupRestoreV3Candidate(
            candidateF.session,
            candidateF.receipt,
            authorizationF,
            operationControl,
          ),
      });
      expect(expiredSeal.status).toBe("rejected");
      if (expiredSeal.status === "rejected") {
        expect(errorChainText(expiredSeal.reason)).toMatch(
          /seal command proof is stale, consumed, or divergent/,
        );
      }
      await Bun.sleep(50);
      const noLateSeal = await control.query<{
        authorization_state: string;
        candidate_state: string;
        terminal_count: number;
      }>(
        `SELECT candidate.state AS candidate_state, seal_auth.state AS authorization_state,
          (SELECT count(*)::integer
           FROM agent_backup_restore_v3_candidate_terminal_commands AS terminal
           WHERE terminal.candidate_id = candidate.id) AS terminal_count
         FROM agent_backup_restore_v3_candidates AS candidate
         JOIN agent_backup_restore_v3_candidate_seal_authorizations AS seal_auth
           ON seal_auth.candidate_id = candidate.id
         WHERE candidate.id = $1`,
        [candidateF.session.stagingHandle],
      );
      expect(noLateSeal.rows).toEqual([
        { authorization_state: "active", candidate_state: "active", terminal_count: 0 },
      ]);
      await executionF.abort(candidateF.session, "staging-failed", operationControl);

      const fixtureG = withAdditionalAttempt(fixture, ATTEMPT_G);
      await seedAdditionalCandidateAttempt(queryClient, fixtureG, ATTEMPT_G);
      const executionG = executionRepository.createAgentBackupRestoreV3CandidateExecution(
        fixtureG.sourceAuthority,
      );
      const candidateG = await completeCandidate(executionG, fixtureG, operationControl);
      const authorityG = sealRepository.createAgentBackupRestoreV3CandidateSealAuthority();
      const lostAuthorizationController = new AbortController();
      const lostAuthorizationControl = Object.freeze({
        signal: lostAuthorizationController.signal,
        deadlineEpochMs: Date.now() + 30_000,
      });
      const authorizationG = await withLostNextCommitAcknowledgment({
        sqlState: "40003",
        afterCommit: async () => lostAuthorizationController.abort(),
        run: async () =>
          await authorityG.authorize(candidateG.authorizationRequest, lostAuthorizationControl),
      });
      expect(await authorityG.authorize(candidateG.authorizationRequest, operationControl)).toEqual(
        authorizationG,
      );
      await executionG.abort(candidateG.session, "staging-failed", operationControl);

      const fixtureH = withAdditionalAttempt(fixture, ATTEMPT_H);
      await seedAdditionalCandidateAttempt(queryClient, fixtureH, ATTEMPT_H);
      const executionH = executionRepository.createAgentBackupRestoreV3CandidateExecution(
        fixtureH.sourceAuthority,
      );
      const candidateH = await completeCandidate(executionH, fixtureH, operationControl);
      const authorizationH = await sealRepository
        .createAgentBackupRestoreV3CandidateSealAuthority()
        .authorize(candidateH.authorizationRequest, operationControl);
      const inFlightLocker = new Client({
        connectionString: isolatedDsn,
        application_name: `${APPLICATION_NAME}-in-flight-seal-locker`,
      });
      await inFlightLocker.connect();
      let firstInFlightSeal: Promise<unknown> | undefined;
      try {
        await inFlightLocker.query("BEGIN");
        await inFlightLocker.query(
          "SELECT id FROM agent_sandbox_backups WHERE id = $1 FOR UPDATE",
          [fixture.authority.backupId],
        );
        firstInFlightSeal = sealRepository.sealAgentBackupRestoreV3Candidate(
          candidateH.session,
          candidateH.receipt,
          authorizationH,
          operationControl,
        );
        expect(
          await waitForCandidateInsertLockWaiter(
            "agent_backup_restore_v3_candidate_terminal_commands",
          ),
        ).not.toBeNull();
        const inFlightReplay = sealRepository.sealAgentBackupRestoreV3Candidate(
          candidateH.session,
          candidateH.receipt,
          authorizationH,
          {
            signal: new AbortController().signal,
            deadlineEpochMs: Date.now() - 1,
          },
        );
        await Bun.sleep(100);
        await inFlightLocker.query("COMMIT");
        const [firstReceipt, replayedReceipt] = await Promise.all([
          firstInFlightSeal,
          inFlightReplay,
        ]);
        expect(firstReceipt).toEqual(candidateH.receipt);
        expect(replayedReceipt).toEqual(candidateH.receipt);
      } finally {
        await inFlightLocker.query("ROLLBACK").catch(() => {});
        await inFlightLocker.end();
        if (firstInFlightSeal) await Promise.allSettled([firstInFlightSeal]);
      }

      const concurrentSeals = await Promise.all([
        sealRepository.sealAgentBackupRestoreV3Candidate(
          candidateA.session,
          candidateA.receipt,
          authorizationA,
          operationControl,
        ),
        sealRepository.sealAgentBackupRestoreV3Candidate(
          candidateA.session,
          candidateA.receipt,
          authorizationA,
          operationControl,
        ),
      ]);
      expect(concurrentSeals[0]).toEqual(concurrentSeals[1]);
      const oneSeal = await control.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM agent_backup_restore_v3_candidate_terminal_commands
         WHERE candidate_id = $1 AND command_kind = 'seal'`,
        [candidateA.session.stagingHandle],
      );
      expect(oneSeal.rows[0]?.count).toBe(1);

      const sealAbortRace = await Promise.allSettled([
        sealRepository.sealAgentBackupRestoreV3Candidate(
          candidateB.session,
          candidateB.receipt,
          authorizationB,
          operationControl,
        ),
        executionB.abort(candidateB.session, "staging-failed", operationControl),
      ]);
      expect(sealAbortRace[1]?.status).toBe("fulfilled");
      const racedTerminal = await control.query<{
        candidate_state: string;
        authorization_state: string;
        command_kind: string;
        count: number;
      }>(
        `SELECT candidate.state AS candidate_state, auth.state AS authorization_state,
          terminal.command_kind, count(*)::integer AS count
         FROM agent_backup_restore_v3_candidates AS candidate
         JOIN agent_backup_restore_v3_candidate_seal_authorizations AS auth
           ON auth.candidate_id = candidate.id
         JOIN agent_backup_restore_v3_candidate_terminal_commands AS terminal
           ON terminal.candidate_id = candidate.id
         WHERE candidate.id = $1
         GROUP BY candidate.state, auth.state, terminal.command_kind`,
        [candidateB.session.stagingHandle],
      );
      expect(racedTerminal.rows).toHaveLength(1);
      expect(racedTerminal.rows[0]?.count).toBe(1);
      if (racedTerminal.rows[0]?.candidate_state === "sealed") {
        expect(racedTerminal.rows[0]).toMatchObject({
          authorization_state: "consumed",
          command_kind: "seal",
        });
        expect(sealAbortRace[0]?.status).toBe("fulfilled");
      } else {
        expect(racedTerminal.rows[0]).toMatchObject({
          candidate_state: "aborted",
          authorization_state: "revoked",
          command_kind: "abort",
        });
        expect(sealAbortRace[0]?.status).toBe("rejected");
      }

      const fixtureD = withAdditionalAttempt(fixture, ATTEMPT_D);
      await seedAdditionalCandidateAttempt(queryClient, fixtureD, ATTEMPT_D);
      const executionD = executionRepository.createAgentBackupRestoreV3CandidateExecution(
        fixtureD.sourceAuthority,
      );
      const candidateD = await completeCandidate(executionD, fixtureD, operationControl);
      const authorizationD = await sealRepository
        .createAgentBackupRestoreV3CandidateSealAuthority()
        .authorize(candidateD.authorizationRequest, operationControl);
      const recovered = await withLostNextCommitAcknowledgment({
        sqlState: "57P01",
        afterCommit: async () => {
          await control!.query(
            `UPDATE agent_backup_restore_leases
             SET released_at = clock_timestamp() WHERE id = $1`,
            [ATTEMPT_D.leaseId],
          );
          await control!.query(
            `UPDATE agent_backup_catalog_authorities
             SET catalog_revision = catalog_revision + 1
             WHERE organization_id = $1 AND agent_id = $2`,
            [fixture.authority.organizationId, fixture.authority.agentId],
          );
          await control!.query(
            "UPDATE agent_sandbox_backups SET catalog_state = 'deleted' WHERE id = $1",
            [fixture.authority.backupId],
          );
        },
        run: () =>
          sealRepository!.sealAgentBackupRestoreV3Candidate(
            candidateD.session,
            candidateD.receipt,
            authorizationD,
            operationControl,
          ),
      });
      expect(recovered).toEqual(candidateD.receipt);
      expect(
        await sealRepository.sealAgentBackupRestoreV3Candidate(
          candidateD.session,
          candidateD.receipt,
          authorizationD,
          operationControl,
        ),
      ).toEqual(candidateD.receipt);
      const durableLostAck = await control.query<{
        candidate_state: string;
        authorization_state: string;
        terminal_count: number;
      }>(
        `SELECT candidate.state AS candidate_state, auth.state AS authorization_state,
          count(terminal.*)::integer AS terminal_count
         FROM agent_backup_restore_v3_candidates AS candidate
         JOIN agent_backup_restore_v3_candidate_seal_authorizations AS auth
           ON auth.candidate_id = candidate.id
         JOIN agent_backup_restore_v3_candidate_terminal_commands AS terminal
           ON terminal.candidate_id = candidate.id
         WHERE candidate.id = $1
         GROUP BY candidate.state, auth.state`,
        [candidateD.session.stagingHandle],
      );
      expect(durableLostAck.rows).toEqual([
        {
          candidate_state: "sealed",
          authorization_state: "consumed",
          terminal_count: 1,
        },
      ]);
    },
    TEST_TIMEOUT,
  );
});
