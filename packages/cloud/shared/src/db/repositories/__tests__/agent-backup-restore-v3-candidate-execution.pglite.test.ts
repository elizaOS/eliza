/** PGlite proof of exact candidate execution and cleanup repository semantics. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupRestoreV3OperationControl,
} from "@elizaos/shared";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } from "../../client";
import {
  type AgentBackupRestoreV3CandidateCleanupFence,
  claimAgentBackupRestoreV3CandidateCleanup,
  deferAgentBackupRestoreV3CandidateCleanup,
  quarantineAgentBackupRestoreV3CandidateCleanup,
  settleAgentBackupRestoreV3CandidateCleanup,
} from "../agent-backup-restore-v3-candidate-cleanup";
import { sha256Utf8 } from "../agent-backup-restore-v3-candidate-codec";
import {
  isAgentBackupRestoreV3AmbiguousCommitResponse,
  throwIfAgentBackupRestoreV3DatabaseDeadline,
} from "../agent-backup-restore-v3-candidate-database-control";
import { createAgentBackupRestoreV3CandidateExecution } from "../agent-backup-restore-v3-candidate-execution";
import {
  applyCandidateMigrations,
  buildCandidateFixture,
  CANDIDATE_IDS,
  type CandidateFixture,
  createCandidatePrerequisiteSchema,
  fixtureSha256,
  seedCandidateAuthority,
} from "./agent-backup-restore-v3-candidate-test-fixture";

const CLAIM_GENERATION_A = "20000000-0000-4000-8000-000000000001";
const CLAIM_GENERATION_B = "20000000-0000-4000-8000-000000000002";
const CLAIM_GENERATION_C = "20000000-0000-4000-8000-000000000003";
const CLAIM_GENERATION_D = "20000000-0000-4000-8000-000000000004";
const EXTRA_CLEANUP = "20000000-0000-4000-8000-000000000005";
const EXTRA_ATTEMPT = "20000000-0000-4000-8000-000000000006";
const CONTROL: Readonly<AgentBackupRestoreV3OperationControl> = Object.freeze({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + 300_000,
});

let fixture: CandidateFixture;

function cleanupFence(
  claim: NonNullable<Awaited<ReturnType<typeof claimAgentBackupRestoreV3CandidateCleanup>>>,
): AgentBackupRestoreV3CandidateCleanupFence {
  return {
    cleanupId: claim.cleanupId,
    ownerId: claim.ownerId,
    generation: claim.generation,
    attempt: claim.attempt,
  };
}

beforeAll(async () => {
  const database = getPgliteClientForTests();
  fixture = await buildCandidateFixture();
  await createCandidatePrerequisiteSchema(database);
  await applyCandidateMigrations(database);
  await seedCandidateAuthority(database, fixture);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("restore-v3 candidate execution repository", () => {
  test("classifies only exact commit ambiguity and fails closed on database cancellation", async () => {
    expect(isAgentBackupRestoreV3AmbiguousCommitResponse({ code: "08006" })).toBe(true);
    expect(isAgentBackupRestoreV3AmbiguousCommitResponse({ code: "57P01" })).toBe(true);
    expect(isAgentBackupRestoreV3AmbiguousCommitResponse({ code: "57014" })).toBe(false);
    expect(
      isAgentBackupRestoreV3AmbiguousCommitResponse(
        new Error("Connection terminated unexpectedly"),
      ),
    ).toBe(true);
    expect(isAgentBackupRestoreV3AmbiguousCommitResponse(new Error("application failure"))).toBe(
      false,
    );
    let cancellation: unknown;
    try {
      throwIfAgentBackupRestoreV3DatabaseDeadline(
        { code: "57014" },
        "Restore-v3 cancellation classification test",
      );
    } catch (cause) {
      cancellation = cause;
    }
    expect(cancellation).toBeInstanceOf(DOMException);
    expect((cancellation as DOMException).name).toBe("AbortError");
    await expect(
      claimAgentBackupRestoreV3CandidateCleanup({
        control: {
          signal: new AbortController().signal,
          deadlineEpochMs: Date.now() - 1,
        },
        ownerId: "expired-control",
        generation: CLAIM_GENERATION_A,
        leaseMs: 10_000,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("replays exact slots, keeps payload plaintext out of DB, aborts through a command, and fences cleanup", async () => {
    const execution = createAgentBackupRestoreV3CandidateExecution(fixture.sourceAuthority);
    const beginRequest = { authority: fixture.authority, manifest: fixture.manifest };
    await expect(
      execution.begin(
        {
          ...beginRequest,
          authority: {
            ...fixture.authority,
            restoreAttemptId: "20000000-0000-4000-8000-000000000099",
          },
        },
        CONTROL,
      ),
    ).rejects.toThrow();
    const session = await execution.begin(beginRequest, CONTROL);
    const beginReplay = await execution.begin(beginRequest, CONTROL);
    expect(beginReplay).toEqual(session);
    expect(session.executionToken).not.toMatch(/^[0-9a-f]{64}$/);
    expect(session.cleanupRegistered).toBe(true);
    expect(session.isolatedCandidate).toBe(true);

    const divergentExecution = createAgentBackupRestoreV3CandidateExecution(
      fixture.sourceAuthority,
    );
    await expect(divergentExecution.begin(beginRequest, CONTROL)).rejects.toThrow(
      /replay differs from durable candidate authority/,
    );

    const firstPlaintext = new TextEncoder().encode("candidate-secret-one");
    const firstExpectedSha256 = fixtureSha256(firstPlaintext);
    const firstPromise = execution.stageRecord(
      session,
      {
        componentIndex: 0,
        componentName: "character",
        dataIndex: 0,
        offsetBytes: 0,
        entry: null,
        payload: firstPlaintext,
      },
      CONTROL,
    );
    firstPlaintext.fill(0);
    const first = await firstPromise;
    expect(first.payloadSha256).toBe(firstExpectedSha256);
    expect(first.entry).toBeNull();

    const exactFirst = await execution.stageRecord(
      session,
      {
        componentIndex: 0,
        componentName: "character",
        dataIndex: 0,
        offsetBytes: 0,
        entry: null,
        payload: new TextEncoder().encode("candidate-secret-one"),
      },
      CONTROL,
    );
    expect(exactFirst).toEqual(first);
    await expect(
      execution.stageRecord(
        session,
        {
          componentIndex: 0,
          componentName: "character",
          dataIndex: 0,
          offsetBytes: 0,
          entry: null,
          payload: new TextEncoder().encode("divergent-payload"),
        },
        CONTROL,
      ),
    ).rejects.toThrow(/replay differs from its durable slot/);

    const secondPayload = new TextEncoder().encode("candidate-secret-two");
    const second = await execution.stageRecord(
      session,
      {
        componentIndex: 0,
        componentName: "character",
        dataIndex: 1,
        offsetBytes: first.payloadBytes,
        entry: null,
        payload: secondPayload,
      },
      CONTROL,
    );

    const componentOneEmpty = {
      componentIndex: 1,
      componentName: "database" as const,
      descriptor: AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[1],
      dataFrameCount: 0,
      payloadBytes: 0,
      payloadSha256: fixtureSha256("database-empty"),
      recordStreamContentHmacSha256: fixtureSha256("database-hmac"),
    };
    await expect(execution.finishComponent(session, componentOneEmpty, CONTROL)).rejects.toThrow();

    const characterReceipt = {
      componentIndex: 0,
      componentName: "character" as const,
      descriptor: AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0],
      dataFrameCount: 2,
      payloadBytes: first.payloadBytes + second.payloadBytes,
      payloadSha256: fixtureSha256("decoded-character"),
      recordStreamContentHmacSha256: fixtureSha256("character-hmac"),
    };
    const finished = await execution.finishComponent(session, characterReceipt, CONTROL);
    expect(finished).toEqual(characterReceipt);
    await expect(execution.finishComponent(session, characterReceipt, CONTROL)).rejects.toThrow();
    await expect(
      execution.finishComponent(
        session,
        { ...characterReceipt, payloadSha256: fixtureSha256("divergent-finish") },
        CONTROL,
      ),
    ).rejects.toThrow();

    const rawLedger = await getPgliteClientForTests().query<{
      data_index: number;
      entry_metadata_sha256: string;
      payload_sha256: string;
      command_sha256: string;
      receipt_sha256: string;
    }>(`SELECT data_index, entry_metadata_sha256, payload_sha256,
      command_sha256, receipt_sha256
      FROM agent_backup_restore_v3_candidate_stage_ledger
      WHERE command_kind = 'record' ORDER BY data_index`);
    expect(rawLedger.rows).toHaveLength(2);
    expect(rawLedger.rows[0]?.entry_metadata_sha256).toBe(sha256Utf8("null"));
    expect(rawLedger.rows[0]?.payload_sha256).toBe(firstExpectedSha256);
    for (const row of rawLedger.rows) {
      expect(row.command_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const allLedgerText = JSON.stringify(rawLedger.rows);
    expect(allLedgerText).not.toContain("candidate-secret-one");
    expect(allLedgerText).not.toContain("candidate-secret-two");
    const bearerRows = await getPgliteClientForTests().query<{
      execution_token_sha256: string;
      source_authority_canonical: string;
    }>(`SELECT execution_token_sha256, source_authority_canonical
      FROM agent_backup_restore_v3_candidates`);
    expect(bearerRows.rows[0]?.execution_token_sha256).toBe(fixtureSha256(session.executionToken));
    expect(JSON.stringify(bearerRows.rows)).not.toContain(session.executionToken);

    expect(await execution.abort(session, "staging-failed", CONTROL)).toBe(true);
    expect(await execution.abort(session, "staging-failed", CONTROL)).toBe(true);
    const terminal = await getPgliteClientForTests().query<{
      state: string;
      cleanup_state: string;
      terminal_commands: number;
    }>(`SELECT candidate.state, cleanup.state AS cleanup_state,
      (SELECT count(*)::integer FROM agent_backup_restore_v3_candidate_terminal_commands)
        AS terminal_commands
      FROM agent_backup_restore_v3_candidates AS candidate
      JOIN agent_backup_restore_v3_candidate_cleanup_outbox AS cleanup
        ON cleanup.id = candidate.cleanup_outbox_id`);
    expect(terminal.rows).toEqual([
      { state: "aborted", cleanup_state: "pending", terminal_commands: 1 },
    ]);
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
        CONTROL,
      ),
    ).rejects.toThrow();

    const firstClaim = await claimAgentBackupRestoreV3CandidateCleanup({
      control: CONTROL,
      ownerId: "cleanup-worker-a",
      generation: CLAIM_GENERATION_A,
      leaseMs: 10_000,
    });
    expect(firstClaim?.attempt).toBe(1);
    expect(firstClaim?.replayed).toBe(false);
    const claimReplay = await claimAgentBackupRestoreV3CandidateCleanup({
      control: CONTROL,
      ownerId: "cleanup-worker-a",
      generation: CLAIM_GENERATION_A,
      leaseMs: 10_000,
    });
    expect(claimReplay?.cleanupId).toBe(firstClaim?.cleanupId);
    expect(claimReplay?.replayed).toBe(true);
    if (!firstClaim) throw new Error("missing first cleanup claim");
    await expect(
      settleAgentBackupRestoreV3CandidateCleanup({
        control: CONTROL,
        fence: { ...cleanupFence(firstClaim), generation: CLAIM_GENERATION_B },
        cleanupReceiptSha256: fixtureSha256("cleanup-receipt"),
      }),
    ).rejects.toThrow(/exact live owner, generation, and attempt/);
    const deferred = await deferAgentBackupRestoreV3CandidateCleanup({
      control: CONTROL,
      fence: cleanupFence(firstClaim),
      delayMs: 1,
    });
    expect(deferred.state).toBe("pending");
    expect(deferred.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(deferred.databaseNow.getTime());
    await Bun.sleep(5);
    const secondClaim = await claimAgentBackupRestoreV3CandidateCleanup({
      control: CONTROL,
      ownerId: "cleanup-worker-b",
      generation: CLAIM_GENERATION_B,
      leaseMs: 10_000,
    });
    expect(secondClaim?.attempt).toBe(2);
    if (!secondClaim) throw new Error("missing second cleanup claim");
    const cleanupReceiptSha256 = fixtureSha256("cleanup-receipt");
    const settled = await settleAgentBackupRestoreV3CandidateCleanup({
      control: CONTROL,
      fence: cleanupFence(secondClaim),
      cleanupReceiptSha256,
    });
    expect(settled.state).toBe("completed");
    expect(settled.replayed).toBe(false);
    const settledReplay = await settleAgentBackupRestoreV3CandidateCleanup({
      control: CONTROL,
      fence: cleanupFence(secondClaim),
      cleanupReceiptSha256,
    });
    expect(settledReplay.state).toBe("completed");
    expect(settledReplay.replayed).toBe(true);
    await expect(
      settleAgentBackupRestoreV3CandidateCleanup({
        control: CONTROL,
        fence: cleanupFence(secondClaim),
        cleanupReceiptSha256: fixtureSha256("different-cleanup-receipt"),
      }),
    ).rejects.toThrow(/receipt differs/);

    await dbWrite.execute(sql`INSERT INTO agent_backup_restore_v3_candidate_cleanup_outbox (
      id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
      cleanup_command_sha256
    ) VALUES (${EXTRA_CLEANUP}::uuid, ${CANDIDATE_IDS.organization}::uuid,
      ${CANDIDATE_IDS.agent}::uuid, ${CANDIDATE_IDS.backup}::uuid,
      ${EXTRA_ATTEMPT}::uuid, ${CANDIDATE_IDS.operation}::uuid,
      ${fixtureSha256("extra-cleanup-command")})`);
    await dbWrite.execute(sql`UPDATE agent_backup_restore_v3_candidate_cleanup_outbox
      SET state = 'pending'
      WHERE id = ${EXTRA_CLEANUP}::uuid`);
    const expiring = await claimAgentBackupRestoreV3CandidateCleanup({
      control: CONTROL,
      ownerId: "cleanup-worker-c",
      generation: CLAIM_GENERATION_C,
      leaseMs: 1_000,
    });
    expect(expiring?.attempt).toBe(1);
    await Bun.sleep(1_050);
    const recovered = await claimAgentBackupRestoreV3CandidateCleanup({
      control: CONTROL,
      ownerId: "cleanup-worker-d",
      generation: CLAIM_GENERATION_D,
      leaseMs: 10_000,
    });
    expect(recovered?.cleanupId).toBe(EXTRA_CLEANUP);
    expect(recovered?.attempt).toBe(2);
    if (!recovered) throw new Error("missing recovered cleanup claim");
    if (expiring) {
      await expect(
        settleAgentBackupRestoreV3CandidateCleanup({
          control: CONTROL,
          fence: cleanupFence(expiring),
          cleanupReceiptSha256: fixtureSha256("stale-cleanup"),
        }),
      ).rejects.toThrow(/exact live owner, generation, and attempt/);
    }
    const quarantined = await quarantineAgentBackupRestoreV3CandidateCleanup({
      control: CONTROL,
      fence: cleanupFence(recovered),
      reason: "provider-object-generation-diverged",
    });
    expect(quarantined.state).toBe("quarantined");
    expect(
      (
        await quarantineAgentBackupRestoreV3CandidateCleanup({
          control: CONTROL,
          fence: cleanupFence(recovered),
          reason: "provider-object-generation-diverged",
        })
      ).replayed,
    ).toBe(true);
    await expect(
      quarantineAgentBackupRestoreV3CandidateCleanup({
        control: CONTROL,
        fence: cleanupFence(recovered),
        reason: "different-quarantine-reason",
      }),
    ).rejects.toThrow(/reason differs/);
    const storedQuarantine = await getPgliteClientForTests().query<{
      quarantine_reason_sha256: string;
    }>(`SELECT quarantine_reason_sha256
      FROM agent_backup_restore_v3_candidate_cleanup_outbox WHERE id = '${EXTRA_CLEANUP}'`);
    expect(storedQuarantine.rows[0]?.quarantine_reason_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(storedQuarantine.rows)).not.toContain(
      "provider-object-generation-diverged",
    );
  }, 60_000);
});
