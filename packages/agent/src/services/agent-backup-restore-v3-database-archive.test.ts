/** Exercises archive rejection and real PGlite state recovery through the decoder. */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { materializeAgentBackupRestoreV3CandidateDatabase } from "./agent-backup-restore-v3-candidate-database-materialize";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { stageAgentBackupRestoreV3CandidateRecord } from "./agent-backup-restore-v3-candidate-records";
import { decodeCandidateDatabaseArchive } from "./agent-backup-restore-v3-database-archive";

const SESSION = Object.freeze({
  restoreAttemptId: "10000000-0000-4000-8000-000000000001",
  operationId: "20000000-0000-4000-8000-000000000002",
  expectedManifestSha256: "a".repeat(64),
  stagingHandle: "30000000-0000-4000-8000-000000000003",
  cleanupHandle: "40000000-0000-4000-8000-000000000004",
  executionToken: "candidate-database-test-execution",
  cleanupRegistered: true as const,
  isolatedCandidate: true as const,
}) satisfies AgentBackupRestoreV3StagingSession;

async function stageDatabase(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  bytes: Uint8Array,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  fragmentBytes = 128 * 1024,
) {
  let dataIndex = 0;
  for (
    let offsetBytes = 0;
    offsetBytes < bytes.byteLength;
    offsetBytes += fragmentBytes
  ) {
    await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      control,
      record: {
        componentIndex: 1,
        componentName: "database",
        dataIndex: dataIndex++,
        offsetBytes,
        entry: null,
        payload: Uint8Array.from(
          bytes.subarray(offsetBytes, offsetBytes + fragmentBytes),
        ),
      },
    });
  }
  const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[1];
  if (!descriptor) throw new Error("Database descriptor unavailable");
  return {
    componentIndex: 1,
    componentName: "database" as const,
    descriptor,
    dataFrameCount: dataIndex,
    payloadBytes: bytes.byteLength,
    payloadSha256: createHash("sha256").update(bytes).digest("hex"),
    recordStreamContentHmacSha256: "b".repeat(64),
  };
}

function entry(name: string, value = "state", type = "0"): Buffer {
  const data = Buffer.from(value);
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000600\0", 100);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}
async function* fragments(bytes: Uint8Array, size = 137) {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}
async function decode(bytes: Uint8Array, maximumBytes = 1024) {
  const records = [];
  for await (const record of decodeCandidateDatabaseArchive(fragments(bytes), {
    maximumBytes,
    maximumEntries: 20,
  }))
    records.push({ ...record, payload: Uint8Array.from(record.payload) });
  return records;
}
const finish = Buffer.alloc(1024);

describe("candidate database archive", () => {
  it("preserves a fragmented file under its archive-relative path", async () => {
    const result = await decode(
      Buffer.concat([entry("/base/record", "complete database bytes"), finish]),
    );
    expect(
      result.map((r) => [r.path, Buffer.from(r.payload).toString()]),
    ).toEqual([["base/record", "complete database bytes"]]);
  });
  it.each([
    "/../outside",
    "//outside",
    "base/../outside",
    "C:/outside",
    "/base\\outside",
  ])("rejects path escape %s before yielding a record", async (name) => {
    await expect(decode(Buffer.concat([entry(name), finish]))).rejects.toThrow(
      "candidate-relative",
    );
  });
  it.each(["1", "2", "3", "4", "x", "g", "S"])(
    "rejects entry type %s",
    async (type) => {
      await expect(
        decode(Buffer.concat([entry("/base", "", type), finish])),
      ).rejects.toThrow("unsupported entry");
    },
  );
  it("rejects checksum corruption, truncation, duplicate paths and trailing data", async () => {
    const corrupt = entry("/base");
    corrupt[12] = 65;
    await expect(decode(Buffer.concat([corrupt, finish]))).rejects.toThrow(
      "checksum",
    );
    await expect(decode(entry("/base"))).rejects.toThrow("complete framing");
    await expect(
      decode(Buffer.concat([entry("/base"), entry("/base"), finish])),
    ).rejects.toThrow("repeats");
    await expect(
      decode(Buffer.concat([entry("/base"), finish, Buffer.from([1])])),
    ).rejects.toThrow("trailing");
    await expect(
      decode(Buffer.concat([entry("/base", "oversized"), finish]), 2),
    ).rejects.toThrow("expanded byte");
  });
  it("restores real database rows from the installed PGlite archive format", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "candidate-database-decoder-"),
    );
    const source = new PGlite();
    let restored: PGlite | undefined;
    let candidateFs: AgentBackupRestoreV3CandidateFs | undefined;
    try {
      await source.waitReady;
      await source.exec(
        "CREATE TABLE continuity (id integer PRIMARY KEY, value text NOT NULL)",
      );
      await source.query("INSERT INTO continuity VALUES ($1, $2)", [
        7,
        "persisted across candidate extraction",
      ]);
      const archive = Buffer.from(
        await (await source.dumpDataDir("gzip")).arrayBuffer(),
      );
      await fs.chmod(root, 0o700);
      const attemptRoot = path.join(root, "attempt");
      await fs.mkdir(attemptRoot, { mode: 0o700 });
      const control = {
        signal: new AbortController().signal,
        deadlineEpochMs: Date.now() + 600_000,
      };
      candidateFs = await openAgentBackupRestoreV3CandidateFs({
        trustedRoot: await fs.realpath(root),
        attemptRoot: await fs.realpath(attemptRoot),
        control,
        ...(process.platform === "linux"
          ? {}
          : { testOnlyAllowNonLinuxFdEmulation: true as const }),
      });
      const receipt = await stageDatabase(candidateFs, archive, control);
      await materializeAgentBackupRestoreV3CandidateDatabase({
        candidateFs,
        session: SESSION,
        receipt,
        control,
        limits: {
          maximumBytes: 64 * 1024 * 1024,
          maximumFiles: 2000,
          maximumDirectories: 2000,
        },
      });
      await source.close();
      restored = new PGlite(path.join(root, "attempt/components/database"));
      await restored.waitReady;
      expect(
        (await restored.query("SELECT id, value FROM continuity")).rows,
      ).toEqual([{ id: 7, value: "persisted across candidate extraction" }]);
    } finally {
      if (restored) await restored.close();
      if (!source.closed) await source.close();
      if (candidateFs) await candidateFs.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("authenticated candidate database materialization", () => {
  it("withholds completion on a digest mismatch, then replays the exact finished state", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "candidate-database-replay-"),
    );
    await fs.chmod(root, 0o700);
    const attemptRoot = path.join(root, "attempt");
    await fs.mkdir(attemptRoot, { mode: 0o700 });
    const control = {
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 120_000,
    };
    const candidateFs = await openAgentBackupRestoreV3CandidateFs({
      trustedRoot: root,
      attemptRoot,
      control,
      ...(process.platform === "linux"
        ? {}
        : { testOnlyAllowNonLinuxFdEmulation: true as const }),
    });
    try {
      const archive = gzipSync(
        Buffer.concat([
          entry("/empty", "", "5"),
          entry("/PG_VERSION", "17\n"),
          finish,
        ]),
      );
      const receipt = await stageDatabase(candidateFs, archive, control, 7);
      await expect(
        materializeAgentBackupRestoreV3CandidateDatabase({
          candidateFs,
          session: SESSION,
          receipt: { ...receipt, payloadSha256: "0".repeat(64) },
          control,
        }),
      ).rejects.toThrow();
      expect(
        await candidateFs.readDurableJson(
          ".restore-v3-materialize-c1.finished.json",
          { maximumBytes: 32 * 1024 },
          control,
        ),
      ).toBeNull();
      const first = await materializeAgentBackupRestoreV3CandidateDatabase({
        candidateFs,
        session: SESSION,
        receipt,
        control,
      });
      expect(
        await fs.readFile(
          path.join(attemptRoot, "components/database/PG_VERSION"),
          "utf8",
        ),
      ).toBe("17\n");
      expect(
        await materializeAgentBackupRestoreV3CandidateDatabase({
          candidateFs,
          session: SESSION,
          receipt,
          control,
        }),
      ).toEqual(first);
      await expect(
        materializeAgentBackupRestoreV3CandidateDatabase({
          candidateFs,
          session: { ...SESSION, executionToken: "different-execution" },
          receipt,
          control,
        }),
      ).rejects.toThrow();
      expect(
        await materializeAgentBackupRestoreV3CandidateDatabase({
          candidateFs,
          session: SESSION,
          receipt,
          control,
        }),
      ).toEqual(first);
    } finally {
      await candidateFs.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
