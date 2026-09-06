/**
 * Real process/filesystem tests of the private Agent materializer transport.
 * macOS uses explicitly test-only pathname emulation, not a Linux flock proof.
 * Parser tests exercise fragmented binary ingress and fail before dispatch.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import { afterEach, expect, it } from "vitest";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import { snapshotAgentBackupRestoreV3CandidateRecord } from "./agent-backup-restore-v3-candidate-records";
import { createAgentBackupRestoreV3ProcessMaterializer } from "./agent-backup-restore-v3-materializer-process";
import {
  MATERIALIZER_METADATA_MAX_BYTES,
  readMaterializerRequest,
} from "./agent-backup-restore-v3-materializer-wire";

const roots = new Set<string>();
const candidates = new Set<AgentBackupRestoreV3CandidateFs>();
const control = () => ({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + 60_000,
});
const options = () =>
  process.platform === "linux"
    ? {}
    : { testOnlyAllowNonLinuxFdEmulation: true as const };
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "restore-process-"),
  );
  roots.add(root);
  await fs.chmod(root, 0o700);
  const attemptRoot = path.join(root, "attempt");
  await fs.mkdir(attemptRoot, { mode: 0o700 });
  const candidateFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot: root,
    attemptRoot,
    control: control(),
    ...options(),
  });
  candidates.add(candidateFs);
  const session: AgentBackupRestoreV3StagingSession = {
    restoreAttemptId: randomUUID(),
    operationId: randomUUID(),
    expectedManifestSha256: "a".repeat(64),
    stagingHandle: randomUUID(),
    cleanupHandle: randomUUID(),
    executionToken: randomUUID(),
    cleanupRegistered: true,
    isolatedCandidate: true,
  };
  const payload = new TextEncoder().encode(
    '{"name":"Transport QA","bio":["private fact"],"plugins":[]}',
  );
  const record = {
    componentIndex: 0,
    componentName: "character" as const,
    dataIndex: 0,
    offsetBytes: 0,
    entry: null,
    payload,
  };
  const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0];
  if (!descriptor) throw new Error("Missing character descriptor");
  const receipt: AgentBackupRestoreV3ComponentReceipt = {
    componentIndex: 0,
    componentName: "character",
    descriptor,
    dataFrameCount: 1,
    payloadBytes: payload.length,
    payloadSha256: hash(payload),
    recordStreamContentHmacSha256: "b".repeat(64),
  };
  const snapshot = snapshotAgentBackupRestoreV3CandidateRecord(
    record,
    control(),
  );
  snapshot.payload.fill(0);
  const request = {
    version: 2,
    trustedRoot: root,
    attemptRoot,
    trustedRootIdentity: candidateFs.trustedRootIdentity,
    attemptRootIdentity: candidateFs.attemptRootIdentity,
    session,
    deadlineEpochMs: control().deadlineEpochMs,
    method: "stageRecord",
    receipt: snapshot.receipt,
  };
  const metadata = Buffer.from(candidateFsCanonicalJson(request));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(metadata.length);
  return {
    root,
    attemptRoot,
    candidateFs,
    session,
    record,
    receipt,
    request,
    wire: Buffer.concat([prefix, metadata, payload]),
    materializer: createAgentBackupRestoreV3ProcessMaterializer({
      candidateFs,
      ...options(),
    }),
  };
}

afterEach(async () => {
  for (const candidate of candidates) await candidate.close();
  candidates.clear();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

it("snapshots caller bytes and authority, replays in another process, and rejects a conflicting session", async () => {
  const f = await fixture();
  const expected = Uint8Array.from(f.record.payload);
  const session = { ...f.session };
  const sent = f.materializer.stageRecord(session, f.record, control());
  f.record.payload.fill(0);
  session.executionToken = randomUUID();
  const ack = await sent;
  expect(ack.payloadSha256).toBe(hash(expected));
  expect(
    await f.materializer.stageRecord(
      f.session,
      { ...f.record, payload: expected },
      control(),
    ),
  ).toEqual(ack);
  await expect(
    f.materializer.stageRecord(
      session,
      { ...f.record, payload: expected },
      control(),
    ),
  ).rejects.toMatchObject({
    code: "AGENT_BACKUP_RESTORE_V3_MATERIALIZER_RECEIPT_UNPROVEN",
  });
  await f.materializer.finishComponent(f.session, f.receipt, control());
  const filename = path.join(
    f.attemptRoot,
    "components/character/character.json",
  );
  const before = await fs.stat(filename, { bigint: true });
  expect(await fs.readFile(filename)).toEqual(Buffer.from(expected));
  await f.materializer.finishComponent(f.session, f.receipt, control());
  expect((await fs.stat(filename, { bigint: true })).ino).toBe(before.ino);
}, 60_000);

it("joins a cancelled worker and permits exact retry without a late writer", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const pending = f.materializer.stageRecord(f.session, f.record, {
    ...control(),
    signal: abort.signal,
  });
  // Let the adapter's authority checks and actual child spawn run first.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  abort.abort();
  await expect(pending).rejects.toThrow();
  await f.materializer.stageRecord(f.session, f.record, control());
  await f.materializer.finishComponent(f.session, f.receipt, control());
  expect(
    await fs.readFile(
      path.join(f.attemptRoot, "components/character/character.json"),
    ),
  ).toEqual(Buffer.from(f.record.payload));
}, 60_000);

it("refuses a replaced root before it can mutate either occurrence", async () => {
  const f = await fixture();
  const old = path.join(f.root, "old-attempt");
  await fs.rename(f.attemptRoot, old);
  await fs.mkdir(f.attemptRoot, { mode: 0o700 });
  await expect(
    f.materializer.stageRecord(f.session, f.record, control()),
  ).rejects.toThrow();
  expect(await fs.readdir(f.attemptRoot)).toEqual([]);
  expect(await fs.readdir(old)).toEqual([]);
});

it("losslessly reads byte-fragmented binary ingress and zeroes transport buffers", async () => {
  const f = await fixture();
  const chunks = Array.from(f.wire, (byte) => Buffer.from([byte]));
  const parsed = await readMaterializerRequest(Readable.from(chunks));
  expect(parsed.request).toEqual(f.request);
  expect(parsed.payload).toEqual(f.record.payload);
  expect(chunks.every((chunk) => chunk[0] === 0)).toBe(true);
  parsed.payload.fill(0);
});

it("returns a complete frame while preserving the open liveness stream", async () => {
  const f = await fixture();
  const input = new PassThrough();
  const pending = readMaterializerRequest(input);
  input.write(f.wire);
  try {
    const parsed = await pending;
    expect(parsed.request).toEqual(f.request);
    expect(parsed.payload).toEqual(f.record.payload);
    expect(input.destroyed).toBe(false);
    expect(input.readableEnded).toBe(false);
    parsed.payload.fill(0);
    const trailing = Buffer.from([7]);
    input.write(trailing);
    expect(input.read()).toEqual(trailing);
    trailing.fill(0);
  } finally {
    input.destroy();
  }
});

it.each(["oversize", "truncated", "trailing", "tampered"] as const)(
  "rejects %s ingress without filesystem effects or exposed input",
  async (kind) => {
    const f = await fixture();
    let bytes = Buffer.from(f.wire);
    if (kind === "oversize")
      bytes.writeUInt32BE(MATERIALIZER_METADATA_MAX_BYTES + 1);
    if (kind === "truncated") bytes = bytes.subarray(0, bytes.length - 1);
    if (kind === "trailing") bytes = Buffer.concat([bytes, Buffer.from([1])]);
    if (kind === "tampered") bytes[bytes.length - 1] ^= 1;
    await expect(
      readMaterializerRequest(Readable.from([bytes])),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_MATERIALIZER_INPUT_INVALID",
      message: "Quarantined Agent materialization did not complete",
    });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(await fs.readdir(f.attemptRoot)).toEqual([]);
  },
);
