/**
 * Real filesystem/PGlite integration for five-component candidate assembly.
 * Stream authority receipts are fixture inputs: this is not provider crypto,
 * an Agent boot, a routing proof or a live-model restore drill.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
  type AgentBackupRestoreV3CandidateReceipt,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { assembleAgentBackupRestoreV3Candidate } from "./agent-backup-restore-v3-candidate-assembly";
import { materializeAgentBackupRestoreV3CandidateCharacter } from "./agent-backup-restore-v3-candidate-character";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { stageAgentBackupRestoreV3CandidateRecord } from "./agent-backup-restore-v3-candidate-records";
import { createAgentBackupRestoreV3ProcessMaterializer } from "./agent-backup-restore-v3-materializer-process";

const roots = new Set<string>();
const candidates = new Set<AgentBackupRestoreV3CandidateFs>();
const databases = new Set<PGlite>();
const control = () => ({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + 120_000,
});
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);
const FACT = "The restored lighthouse is amber-20732";
const CHARACTER = encode(
  '{"name":"Restore QA","bio":["remembers a lighthouse"],"plugins":[]}',
);
const MEDIA = encode("private-media-20732");
const STATE = encode('{"pluginFact":"tide-20732"}');
const VAULT = encode("opaque-vault-ciphertext-20732");
const platformOptions = () =>
  process.platform === "linux"
    ? {}
    : { testOnlyAllowNonLinuxFdEmulation: true as const };

async function fixture(realDatabase = false, processTransport = false) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "restore-v3-assembly-"),
  );
  roots.add(root);
  await fs.chmod(root, 0o700);
  const attemptRoot = path.join(root, "attempt");
  await fs.mkdir(attemptRoot, { mode: 0o700 });
  const candidateFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot: root,
    attemptRoot,
    control: control(),
    ...platformOptions(),
  });
  candidates.add(candidateFs);
  const materializer = createAgentBackupRestoreV3ProcessMaterializer({
    candidateFs,
    ...platformOptions(),
  });
  const session: AgentBackupRestoreV3StagingSession = Object.freeze({
    restoreAttemptId: randomUUID(),
    operationId: randomUUID(),
    expectedManifestSha256: "a".repeat(64),
    stagingHandle: randomUUID(),
    cleanupHandle: randomUUID(),
    executionToken: randomUUID(),
    cleanupRegistered: true,
    isolatedCandidate: true,
  });
  let databaseBytes = new Uint8Array([1]);
  if (realDatabase) {
    const sourcePath = path.join(root, "source");
    const db = new PGlite(sourcePath);
    databases.add(db);
    await db.exec(
      "CREATE TABLE assembly_fact (id integer PRIMARY KEY, fact text NOT NULL)",
    );
    await db.query("INSERT INTO assembly_fact VALUES ($1, $2)", [1, FACT]);
    databaseBytes = new Uint8Array(
      await (await db.dumpDataDir("gzip")).arrayBuffer(),
    );
    await db.close();
    databases.delete(db);
    await fs.rm(sourcePath, { recursive: true });
  }
  const contents = [CHARACTER, databaseBytes, MEDIA, STATE, VAULT];
  const paths = [null, null, "photo.bin", "plugin/state.json", "vault.json"];
  const components: AgentBackupRestoreV3ComponentReceipt[] = [];
  try {
    for (const [
      componentIndex,
      descriptor,
    ] of AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS.entries()) {
      const bytes = contents[componentIndex];
      if (!bytes) throw new Error("Missing fixture component");
      const filePath = paths[componentIndex];
      let dataFrameCount = 0;
      for (
        let offsetBytes = 0;
        offsetBytes < bytes.length;
        offsetBytes += 256 * 1024
      ) {
        const payload = Uint8Array.from(
          bytes.subarray(offsetBytes, offsetBytes + 256 * 1024),
        );
        try {
          const record = {
            componentIndex,
            componentName: descriptor.name,
            dataIndex: dataFrameCount++,
            offsetBytes,
            payload,
            entry: filePath
              ? {
                  path: filePath,
                  fileOffsetBytes: offsetBytes,
                  fileSizeBytes: bytes.length,
                  mode: componentIndex === 4 ? 0o400 : 0o600,
                  mtimeMs: 0,
                }
              : null,
          };
          if (processTransport)
            await materializer.stageRecord(session, record, control());
          else
            await stageAgentBackupRestoreV3CandidateRecord({
              candidateFs,
              session,
              control: control(),
              record,
            });
        } finally {
          payload.fill(0);
        }
      }
      components.push({
        componentIndex,
        componentName: descriptor.name,
        descriptor,
        dataFrameCount,
        payloadBytes: bytes.length,
        payloadSha256: hash(bytes),
        recordStreamContentHmacSha256: "b".repeat(64),
      });
    }
  } finally {
    databaseBytes.fill(0);
  }
  const receipt: AgentBackupRestoreV3CandidateReceipt = {
    format: AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
    restoreAttemptId: session.restoreAttemptId,
    operationId: session.operationId,
    expectedManifestSha256: session.expectedManifestSha256,
    keyBundleGenerationId: randomUUID(),
    sourceCopyRole: "primary",
    sourceAuthorityDerivation:
      AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
    sourceAuthoritySha256: "c".repeat(64),
    objectCount: 5,
    stagedPayloadBytes: components.reduce((n, c) => n + c.payloadBytes, 0),
    stagedDataRecordCount: components.reduce((n, c) => n + c.dataFrameCount, 0),
    sourceObjects: components.map((c) => ({
      componentIndex: c.componentIndex,
      componentName: c.componentName,
      chunkIndex: 0,
      copyRole: "primary",
      objectId: randomUUID(),
      exactReadReceiptDerivation:
        AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
      exactReadReceiptSha256: "d".repeat(64),
      ciphertextSha256: "e".repeat(64),
      sizeBytes: c.payloadBytes,
    })),
    components,
    authorityRevalidated: true,
  };
  return {
    root,
    attemptRoot,
    materializer,
    input: { candidateFs, session, receipt, control: control() },
  };
}

afterEach(async () => {
  for (const db of databases) await db.close();
  databases.clear();
  for (const candidate of candidates) await candidate.close();
  candidates.clear();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("five-component candidate assembly", () => {
  it("transports every component through private Agent processes without booting a runtime", async () => {
    const { root, attemptRoot, input, materializer } = await fixture(
      true,
      true,
    );
    for (const receipt of input.receipt.components) {
      expect(
        await materializer.finishComponent(input.session, receipt, control()),
      ).toEqual(receipt);
    }
    expect(
      await materializer.assembleCandidate(
        input.session,
        input.receipt,
        control(),
      ),
    ).toEqual(input.receipt);
    const markerPath = path.join(
      attemptRoot,
      ".restore-v3-candidate-assembled.json",
    );
    const marker = await fs.readFile(markerPath, "utf8");
    const inode = (await fs.stat(markerPath, { bigint: true })).ino;
    expect(
      await materializer.assembleCandidate(
        input.session,
        input.receipt,
        control(),
      ),
    ).toEqual(input.receipt);
    expect(await fs.readFile(markerPath, "utf8")).toBe(marker);
    expect((await fs.stat(markerPath, { bigint: true })).ino).toBe(inode);
    expect(marker).not.toContain(input.session.executionToken);
    expect(
      await fs.readFile(
        path.join(attemptRoot, "components/character/character.json"),
      ),
    ).toEqual(Buffer.from(CHARACTER));
    expect(
      await fs.readFile(path.join(attemptRoot, "components/media/photo.bin")),
    ).toEqual(Buffer.from(MEDIA));
    expect(
      await fs.readFile(
        path.join(attemptRoot, "components/state-files/plugin/state.json"),
      ),
    ).toEqual(Buffer.from(STATE));
    expect(
      await fs.readFile(path.join(attemptRoot, "components/vault/vault.json")),
    ).toEqual(Buffer.from(VAULT));
    const probe = path.join(root, "probe");
    await fs.cp(path.join(attemptRoot, "components/database"), probe, {
      recursive: true,
    });
    const db = new PGlite(probe);
    databases.add(db);
    expect((await db.query("SELECT id, fact FROM assembly_fact")).rows).toEqual(
      [{ id: 1, fact: FACT }],
    );
  }, 150_000);

  it("resumes partial materialization, replays on a fresh FS authority, and rejects later tamper", async () => {
    const { root, attemptRoot, input } = await fixture(true);
    const character = input.receipt.components[0];
    if (!character) throw new Error("Missing character");
    await materializeAgentBackupRestoreV3CandidateCharacter({
      ...input,
      receipt: character,
    });
    const characterPath = path.join(
      attemptRoot,
      "components/character/character.json",
    );
    const before = await fs.stat(characterPath, { bigint: true });
    const held = await input.candidateFs.acquireLock(
      ".restore-v3-competing-operation.lock",
      control(),
    );
    try {
      await expect(
        assembleAgentBackupRestoreV3Candidate(input),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_BUSY",
      });
    } finally {
      await held.release(control());
    }

    await expect(
      assembleAgentBackupRestoreV3Candidate({
        ...input,
        receipt: {
          ...input.receipt,
          components: input.receipt.components.map((component) =>
            component.componentName === "vault"
              ? { ...component, payloadSha256: "f".repeat(64) }
              : component,
          ),
        },
      }),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(attemptRoot, ".restore-v3-candidate-assembled.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const mutable = structuredClone(input.receipt);
    const assembly = assembleAgentBackupRestoreV3Candidate({
      ...input,
      receipt: mutable,
    });
    // Caller mutation after dispatch must not rebind the in-flight assembly.
    Object.assign(mutable, { expectedManifestSha256: "f".repeat(64) });
    const assembled = await assembly;
    expect(await fs.readFile(characterPath)).toEqual(Buffer.from(CHARACTER));
    expect((await fs.stat(characterPath, { bigint: true })).ino).toBe(
      before.ino,
    );
    expect(
      await fs.readFile(path.join(attemptRoot, "components/media/photo.bin")),
    ).toEqual(Buffer.from(MEDIA));
    expect(
      await fs.readFile(
        path.join(attemptRoot, "components/state-files/plugin/state.json"),
      ),
    ).toEqual(Buffer.from(STATE));
    const vaultPath = path.join(attemptRoot, "components/vault/vault.json");
    expect(await fs.readFile(vaultPath)).toEqual(Buffer.from(VAULT));
    expect((await fs.stat(vaultPath)).mode & 0o777).toBe(0o400);
    await expect(
      fs.stat(path.join(attemptRoot, ".restore-v3-database-validation")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const markerPath = path.join(
      attemptRoot,
      ".restore-v3-candidate-assembled.json",
    );
    const marker = await fs.readFile(markerPath, "utf8");
    expect(JSON.parse(marker)).toEqual(assembled);
    expect(marker).not.toContain(input.session.executionToken);
    expect(marker).not.toContain(FACT);

    await input.candidateFs.close();
    candidates.delete(input.candidateFs);
    const reopened = await openAgentBackupRestoreV3CandidateFs({
      trustedRoot: root,
      attemptRoot,
      control: control(),
      ...platformOptions(),
    });
    candidates.add(reopened);
    const retry = { ...input, candidateFs: reopened, control: control() };
    expect(await assembleAgentBackupRestoreV3Candidate(retry)).toEqual(
      assembled,
    );
    await expect(
      assembleAgentBackupRestoreV3Candidate({
        ...retry,
        receipt: { ...input.receipt, keyBundleGenerationId: randomUUID() },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_ASSEMBLY_RECEIPT_CONFLICT",
    });

    await fs.chmod(vaultPath, 0o600);
    await fs.writeFile(vaultPath, "conflicting-vault");
    await fs.chmod(vaultPath, 0o400);
    await expect(
      assembleAgentBackupRestoreV3Candidate(retry),
    ).rejects.toThrow();
    expect(await fs.readFile(vaultPath, "utf8")).toBe("conflicting-vault");
    expect(await fs.readFile(markerPath, "utf8")).toBe(marker);
    const db = new PGlite(path.join(attemptRoot, "components/database"));
    databases.add(db);
    expect((await db.query("SELECT id, fact FROM assembly_fact")).rows).toEqual(
      [{ id: 1, fact: FACT }],
    );
  }, 150_000);

  it.each([
    "missing-component",
    "other-session",
    "aborted",
    "nested-accessor",
  ] as const)("rejects %s before any materialized output", async (kind) => {
    const { attemptRoot, input } = await fixture();
    let getterCalls = 0;
    if (kind === "missing-component")
      input.receipt = {
        ...input.receipt,
        components: input.receipt.components.slice(0, 4),
      };
    if (kind === "other-session")
      input.session = { ...input.session, operationId: randomUUID() };
    if (kind === "aborted") {
      const abort = new AbortController();
      abort.abort();
      input.control = { ...control(), signal: abort.signal };
    }
    if (kind === "nested-accessor") {
      const components = structuredClone(input.receipt.components);
      Object.defineProperty(components[0], "payloadBytes", {
        enumerable: true,
        get: () => {
          getterCalls++;
          return 1;
        },
      });
      input.receipt = { ...input.receipt, components };
    }
    await expect(
      assembleAgentBackupRestoreV3Candidate(input),
    ).rejects.toThrow();
    expect(getterCalls).toBe(0);
    await expect(
      fs.stat(path.join(attemptRoot, "components")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(attemptRoot, ".restore-v3-candidate-assembled.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
