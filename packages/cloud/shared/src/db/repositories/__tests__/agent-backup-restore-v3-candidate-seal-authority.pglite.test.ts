/** PGlite proof for digest-only authorization and byte-exact terminal seal replay. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3OperationControl,
} from "@elizaos/shared";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../client";
import { createAgentBackupRestoreV3CandidateExecution } from "../agent-backup-restore-v3-candidate-execution";
import {
  createAgentBackupRestoreV3CandidateSealAuthority,
  sealAgentBackupRestoreV3Candidate,
} from "../agent-backup-restore-v3-candidate-seal-authority";
import {
  applyCandidateMigrations,
  buildCandidateFixture,
  buildCandidateSealAuthorizationRequest,
  buildCandidateSealReceipt,
  CANDIDATE_IDS,
  type CandidateFixture,
  completeCandidate,
  createCandidatePrerequisiteSchema,
  fixtureSha256,
  seedAdditionalCandidateAttempt,
  seedCandidateAuthority,
  stageAndFinishCandidateComponent,
  withAdditionalAttempt,
} from "./agent-backup-restore-v3-candidate-test-fixture";

const SECOND_ATTEMPT = {
  restoreAttemptId: "40000000-0000-4000-8000-000000000001",
  leaseId: "40000000-0000-4000-8000-000000000002",
  leaseGeneration: "40000000-0000-4000-8000-000000000003",
  restoreOperationId: "40000000-0000-4000-8000-000000000004",
} as const;

const CONTROL: Readonly<AgentBackupRestoreV3OperationControl> = Object.freeze({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + 300_000,
});

let fixture: CandidateFixture;

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

describe("restore-v3 candidate seal authority on PGlite", () => {
  test("issues only after five finishes, persists digests only, and replays exact sealed bytes after authority loss", async () => {
    const database = getPgliteClientForTests();
    const execution = createAgentBackupRestoreV3CandidateExecution(fixture.sourceAuthority);
    const session = await execution.begin(
      { authority: fixture.authority, manifest: fixture.manifest },
      CONTROL,
    );
    const components: AgentBackupRestoreV3ComponentReceipt[] = [];
    for (let index = 0; index < 4; index += 1) {
      components.push(await stageAndFinishCandidateComponent(execution, session, index, CONTROL));
    }

    const notYetDurableReceipt = buildCandidateSealReceipt(
      fixture,
      AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map((componentName, index) => {
        const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[index];
        if (!descriptor) throw new Error(`Missing descriptor ${index}`);
        return {
          componentIndex: index,
          componentName,
          descriptor,
          dataFrameCount: 0,
          payloadBytes: 0,
          payloadSha256: fixtureSha256(`unfinished-payload-${index}`),
          recordStreamContentHmacSha256: fixtureSha256(`unfinished-hmac-${index}`),
        };
      }),
    );
    await expect(
      createAgentBackupRestoreV3CandidateSealAuthority().authorize(
        buildCandidateSealAuthorizationRequest(fixture, session, notYetDurableReceipt),
        CONTROL,
      ),
    ).rejects.toThrow();
    const beforeFifth = await database.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM agent_backup_restore_v3_candidate_seal_authorizations",
    );
    expect(beforeFifth.rows[0]?.count).toBe(0);

    components.push(await stageAndFinishCandidateComponent(execution, session, 4, CONTROL));
    const receipt = buildCandidateSealReceipt(fixture, components);
    const request = buildCandidateSealAuthorizationRequest(fixture, session, receipt);
    const authority = createAgentBackupRestoreV3CandidateSealAuthority();
    const authorizationControl = Object.freeze({
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 2_000,
    });
    const authorization = await authority.authorize(request, authorizationControl);
    // Simulate an application-level lost response: the exact retry before
    // expiry recovers the same process-held proof without a second DB row.
    const authorizationReplay = await authority.authorize(request, authorizationControl);
    expect(authorizationReplay).toEqual(authorization);
    expect(JSON.stringify(authority)).not.toContain(authorization.proofToken);
    expect(authorization.expiresAtEpochMs).toBeLessThanOrEqual(
      fixture.authority.leaseExpiresAtEpochMs,
    );
    expect(authorization.expiresAtEpochMs).toBeLessThanOrEqual(
      authorizationControl.deadlineEpochMs,
    );

    const durableAuthorization = await database.query<{
      authorization_count: number;
      authorization_request_sha256: string;
      execution_token_sha256: string;
      proof_token_sha256: string;
    }>(`SELECT (count(*) OVER ())::integer AS authorization_count,
      authorization_request_sha256, execution_token_sha256, proof_token_sha256
      FROM agent_backup_restore_v3_candidate_seal_authorizations`);
    expect(durableAuthorization.rows).toHaveLength(1);
    expect(durableAuthorization.rows[0]?.authorization_count).toBe(1);
    expect(durableAuthorization.rows[0]?.authorization_request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(durableAuthorization.rows[0]?.execution_token_sha256).toBe(
      fixtureSha256(session.executionToken),
    );
    expect(durableAuthorization.rows[0]?.proof_token_sha256).toBe(
      fixtureSha256(authorization.proofToken),
    );
    expect(JSON.stringify(durableAuthorization.rows)).not.toContain(session.executionToken);
    expect(JSON.stringify(durableAuthorization.rows)).not.toContain(authorization.proofToken);

    const inFlightAbort = new AbortController();
    const mutableControl = {
      signal: inFlightAbort.signal,
      deadlineEpochMs: Date.now() + 60_000,
    };
    const cancelledInFlight = sealAgentBackupRestoreV3Candidate(
      session,
      receipt,
      authorization,
      mutableControl,
    );
    mutableControl.signal = new AbortController().signal;
    mutableControl.deadlineEpochMs += 60_000;
    inFlightAbort.abort(new Error("synthetic in-flight cancellation"));
    await expect(cancelledInFlight).rejects.toHaveProperty("name", "AbortError");

    const stillActive = await database.query<{
      candidate_state: string;
      authorization_state: string;
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
      [session.stagingHandle],
    );
    expect(stillActive.rows).toEqual([
      { authorization_state: "active", candidate_state: "active", terminal_count: 0 },
    ]);

    const sealed = await sealAgentBackupRestoreV3Candidate(
      session,
      receipt,
      authorization,
      CONTROL,
    );
    expect(sealed).toEqual(receipt);
    expect(
      await sealAgentBackupRestoreV3Candidate(session, receipt, authorization, CONTROL),
    ).toEqual(receipt);
    expect(
      await sealAgentBackupRestoreV3Candidate(session, receipt, authorization, {
        signal: new AbortController().signal,
        deadlineEpochMs: Date.now() - 1,
      }),
    ).toEqual(receipt);
    await Bun.sleep(Math.max(1, authorization.expiresAtEpochMs - Date.now() + 25));
    expect(() => authority.authorize(request, CONTROL)).toThrow(
      /proof material is expired or was disposed/,
    );
    expect(JSON.stringify(authority)).not.toContain(authorization.proofToken);

    const secondFixture = withAdditionalAttempt(fixture, SECOND_ATTEMPT);
    await seedAdditionalCandidateAttempt(database, secondFixture, SECOND_ATTEMPT);
    const secondExecution = createAgentBackupRestoreV3CandidateExecution(
      secondFixture.sourceAuthority,
    );
    const second = await completeCandidate(secondExecution, secondFixture, CONTROL);
    const secondAuthorization = await createAgentBackupRestoreV3CandidateSealAuthority().authorize(
      second.authorizationRequest,
      CONTROL,
    );
    const terminalRace = await Promise.allSettled([
      sealAgentBackupRestoreV3Candidate(
        second.session,
        second.receipt,
        secondAuthorization,
        CONTROL,
      ),
      secondExecution.abort(second.session, "staging-failed", CONTROL),
    ]);
    expect(terminalRace[1]?.status).toBe("fulfilled");
    const raced = await database.query<{
      state: string;
      authorization_state: string;
      command_kind: string;
      terminal_count: number;
    }>(
      `SELECT candidate.state, auth.state AS authorization_state,
      terminal.command_kind, (count(*) OVER ())::integer AS terminal_count
      FROM agent_backup_restore_v3_candidates AS candidate
      JOIN agent_backup_restore_v3_candidate_seal_authorizations AS auth
        ON auth.candidate_id = candidate.id
      JOIN agent_backup_restore_v3_candidate_terminal_commands AS terminal
        ON terminal.candidate_id = candidate.id
      WHERE candidate.restore_attempt_id = $1`,
      [SECOND_ATTEMPT.restoreAttemptId],
    );
    expect(raced.rows).toHaveLength(1);
    expect(raced.rows[0]?.terminal_count).toBe(1);
    if (raced.rows[0]?.state === "sealed") {
      expect(raced.rows[0]).toMatchObject({
        authorization_state: "consumed",
        command_kind: "seal",
      });
      expect(terminalRace[0]?.status).toBe("fulfilled");
    } else {
      expect(raced.rows[0]).toMatchObject({
        state: "aborted",
        authorization_state: "revoked",
        command_kind: "abort",
      });
      expect(terminalRace[0]?.status).toBe("rejected");
    }

    await database.query(
      `UPDATE agent_backup_restore_leases
       SET released_at = clock_timestamp() WHERE id = $1`,
      [CANDIDATE_IDS.lease],
    );
    await database.query(
      `UPDATE agent_backup_catalog_authorities
       SET catalog_revision = catalog_revision + 1
       WHERE organization_id = $1 AND agent_id = $2`,
      [CANDIDATE_IDS.organization, CANDIDATE_IDS.agent],
    );
    await database.query(
      "UPDATE agent_sandbox_backups SET catalog_state = 'deleted' WHERE id = $1",
      [CANDIDATE_IDS.backup],
    );
    expect(
      await sealAgentBackupRestoreV3Candidate(session, receipt, authorization, CONTROL),
    ).toEqual(receipt);
    await expect(
      sealAgentBackupRestoreV3Candidate(
        session,
        receipt,
        { ...authorization, proofToken: `${authorization.proofToken}-divergent` },
        CONTROL,
      ),
    ).rejects.toThrow(/divergent/);

    const durableSeal = await database.query<{
      candidate_state: string;
      authorization_state: string;
      terminal_count: number;
      sealed_receipt_canonical: string;
    }>(
      `SELECT candidate.state AS candidate_state,
      auth.state AS authorization_state,
      count(terminal.*)::integer AS terminal_count,
      max(terminal.sealed_receipt_canonical) AS sealed_receipt_canonical
      FROM agent_backup_restore_v3_candidates AS candidate
      JOIN agent_backup_restore_v3_candidate_seal_authorizations AS auth
        ON auth.candidate_id = candidate.id
      JOIN agent_backup_restore_v3_candidate_terminal_commands AS terminal
        ON terminal.candidate_id = candidate.id
      WHERE candidate.restore_attempt_id = $1
      GROUP BY candidate.state, auth.state`,
      [fixture.authority.restoreAttemptId],
    );
    expect(durableSeal.rows).toHaveLength(1);
    expect(durableSeal.rows[0]).toMatchObject({
      candidate_state: "sealed",
      authorization_state: "consumed",
      terminal_count: 1,
    });
    expect(JSON.stringify(durableSeal.rows)).not.toContain(session.executionToken);
    expect(JSON.stringify(durableSeal.rows)).not.toContain(authorization.proofToken);
  });
});
