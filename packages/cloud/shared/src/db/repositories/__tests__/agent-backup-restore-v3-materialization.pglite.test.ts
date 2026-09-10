/**
 * Real coordinator PGlite transactions joined to the Agent filesystem adapter.
 * Faults are injected after actual Agent effects to prove rollback and replay;
 * this does not substitute for HTTP transport or multi-connection PostgreSQL.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3OperationControl,
} from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "../../../../../../agent/src/services/agent-backup-restore-v3-candidate-fs";
import { createAgentBackupRestoreV3CandidateMaterializer } from "../../../../../../agent/src/services/agent-backup-restore-v3-candidate-materializer";
import { readAgentBackupRestoreV3CandidateRecord } from "../../../../../../agent/src/services/agent-backup-restore-v3-candidate-records";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../client";
import { createAgentBackupRestoreV3MaterializingCandidateExecution } from "../agent-backup-restore-v3-candidate-execution";
import {
  applyCandidateMigrations,
  buildCandidateFixture,
  type CandidateFixture,
  createCandidatePrerequisiteSchema,
  fixtureSha256,
  seedCandidateAuthority,
} from "./agent-backup-restore-v3-candidate-test-fixture";

const control = (): Readonly<AgentBackupRestoreV3OperationControl> => ({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + 900_000,
});
let fixture: CandidateFixture;
let root: string;
let candidateFs: AgentBackupRestoreV3CandidateFs;

beforeAll(async () => {
  const database = getPgliteClientForTests();
  fixture = await buildCandidateFixture();
  await createCandidatePrerequisiteSchema(database);
  await applyCandidateMigrations(database);
  await seedCandidateAuthority(database, fixture);
  root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "restore-v3-coordinator-agent-"),
  );
  await fs.chmod(root, 0o700);
  const attemptRoot = path.join(root, "attempt");
  await fs.mkdir(attemptRoot, { mode: 0o700 });
  candidateFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot: root,
    attemptRoot,
    control: control(),
    ...(process.platform === "linux" ? {} : { testOnlyAllowNonLinuxFdEmulation: true }),
  });
});

afterAll(async () => {
  if (candidateFs) await candidateFs.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
  await closeDatabaseConnectionsForTests();
});

async function ledgerCount(kind: "record" | "finish"): Promise<number> {
  const result = await getPgliteClientForTests().query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM agent_backup_restore_v3_candidate_stage_ledger WHERE command_kind = $1",
    [kind],
  );
  const count = result.rows[0]?.count;
  if (count === undefined) throw new Error("Missing ledger count");
  return count;
}

test("requires real Agent acknowledgements, replays partial effects and prevents stale writes", async () => {
  const agent = createAgentBackupRestoreV3CandidateMaterializer(candidateFs);
  let recordCalls = 0;
  let finishCalls = 0;
  let recordFault: "mismatch" | "lost" | null = "mismatch";
  let finishFault = true;
  const borrowedCopies: Uint8Array[] = [];
  const execution = createAgentBackupRestoreV3MaterializingCandidateExecution(
    fixture.sourceAuthority,
    {
      assembleCandidate: agent.assembleCandidate,
      async stageRecord(session, record, effectControl) {
        recordCalls++;
        borrowedCopies.push(record.payload);
        expect(effectControl.deadlineEpochMs).toBeLessThanOrEqual(fixture.leaseExpiresAt.getTime());
        const receipt = await agent.stageRecord(session, record, effectControl);
        if (recordFault === "lost") throw new Error("injected lost Agent acknowledgement");
        return recordFault === "mismatch" ? { ...receipt, payloadSha256: "f".repeat(64) } : receipt;
      },
      async finishComponent(session, component, effectControl) {
        finishCalls++;
        const receipt = await agent.finishComponent(session, component, effectControl);
        return finishFault ? { ...receipt, payloadSha256: "f".repeat(64) } : receipt;
      },
    },
  );
  const session = await execution.begin(
    { authority: fixture.authority, manifest: fixture.manifest },
    control(),
  );
  expect(await fs.readdir(candidateFs.attemptRoot)).toEqual([]);
  const cleanup = await getPgliteClientForTests().query<{ state: string }>(
    "SELECT state FROM agent_backup_restore_v3_candidate_cleanup_outbox WHERE id = $1",
    [session.cleanupHandle],
  );
  expect(cleanup.rows).toEqual([{ state: "held" }]);
  const text = '{"name":"Coordinator restore QA","bio":["private coordinator fact"],"plugins":[]}';
  const record = () => ({
    componentIndex: 0,
    componentName: "character" as const,
    dataIndex: 0,
    offsetBytes: 0,
    entry: null,
    payload: new TextEncoder().encode(text),
  });
  await expect(execution.stageRecord(session, record(), control())).rejects.toMatchObject({
    code: "AGENT_BACKUP_RESTORE_V3_MATERIALIZATION_CONFLICT",
  });
  expect(await ledgerCount("record")).toBe(0);
  expect(borrowedCopies.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  const staged = await readAgentBackupRestoreV3CandidateRecord({
    candidateFs,
    session,
    componentIndex: 0,
    dataIndex: 0,
    control: control(),
  });
  expect(new TextDecoder().decode(staged.payload)).toBe(text);
  staged.payload.fill(0);

  recordFault = "lost";
  await expect(execution.stageRecord(session, record(), control())).rejects.toThrow(
    "injected lost",
  );
  expect(await ledgerCount("record")).toBe(0);
  recordFault = null;
  const mutableSession = { ...session };
  const callerRecord = record();
  const running = execution.stageRecord(mutableSession, callerRecord, control());
  mutableSession.executionToken = "not-the-authorized-execution";
  callerRecord.payload.fill(0);
  const accepted = await running;
  expect(accepted.payloadSha256).toBe(fixtureSha256(text));
  expect(await ledgerCount("record")).toBe(1);
  expect(borrowedCopies.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  const beforeReplay = recordCalls;
  expect(await execution.stageRecord(session, record(), control())).toEqual(accepted);
  expect(recordCalls).toBe(beforeReplay);

  const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0];
  if (!descriptor) throw new Error("Missing character descriptor");
  const component: AgentBackupRestoreV3ComponentReceipt = {
    componentIndex: 0,
    componentName: "character",
    descriptor,
    dataFrameCount: 1,
    payloadBytes: new TextEncoder().encode(text).length,
    payloadSha256: fixtureSha256(text),
    recordStreamContentHmacSha256: "b".repeat(64),
  };
  await expect(execution.finishComponent(session, component, control())).rejects.toMatchObject({
    code: "AGENT_BACKUP_RESTORE_V3_MATERIALIZATION_CONFLICT",
  });
  expect(await ledgerCount("finish")).toBe(0);
  const outputPath = path.join(candidateFs.attemptRoot, "components/character/character.json");
  expect(await fs.readFile(outputPath, "utf8")).toBe(text);
  const inode = (await fs.stat(outputPath, { bigint: true })).ino;
  finishFault = false;
  expect(await execution.finishComponent(session, component, control())).toEqual(component);
  expect(await ledgerCount("finish")).toBe(1);
  expect((await fs.stat(outputPath, { bigint: true })).ino).toBe(inode);
  const beforeClosedFinish = finishCalls;
  await expect(execution.finishComponent(session, component, control())).rejects.toThrow();
  expect(finishCalls).toBe(beforeClosedFinish);
  await expect(execution.stageRecord(session, record(), control())).rejects.toThrow();
  expect(recordCalls).toBe(beforeReplay);

  await getPgliteClientForTests().query(
    "UPDATE agent_backup_restore_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [fixture.authority.leaseId],
  );
  await expect(
    execution.stageRecord(
      session,
      {
        componentIndex: 1,
        componentName: "database",
        dataIndex: 0,
        offsetBytes: 0,
        entry: null,
        payload: new Uint8Array([7]),
      },
      control(),
    ),
  ).rejects.toThrow();
  expect(recordCalls).toBe(beforeReplay);
  expect(await execution.abort(session, "staging-failed", control())).toBe(true);
  await expect(execution.stageRecord(session, record(), control())).rejects.toThrow();
  expect(recordCalls).toBe(beforeReplay);
  const terminal = await getPgliteClientForTests().query<{ state: string }>(
    "SELECT state FROM agent_backup_restore_v3_candidate_cleanup_outbox WHERE id = $1",
    [session.cleanupHandle],
  );
  expect(terminal.rows).toEqual([{ state: "pending" }]);
  expect(await fs.readFile(outputPath, "utf8")).toBe(text);
}, 120_000);
