/** Real PGlite round-trip and adversarial physical archive parsing proofs. */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { extractAgentBackupRestoreV3CandidateDatabase } from "./agent-backup-restore-v3-candidate-database";
import { validateAgentBackupRestoreV3CandidateDatabase } from "./agent-backup-restore-v3-candidate-database-validation";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { stageAgentBackupRestoreV3CandidateRecord } from "./agent-backup-restore-v3-candidate-records";
import {
  type AgentBackupRestoreV3PgliteArchiveLimits,
  readAgentBackupRestoreV3PgliteArchive,
} from "./agent-backup-restore-v3-pglite-archive";

const roots = new Set<string>();
const candidates = new Set<AgentBackupRestoreV3CandidateFs>();
const databases = new Set<PGlite>();
const SESSION = Object.freeze({
  restoreAttemptId: "10000000-0000-4000-8000-000000000001",
  operationId: "20000000-0000-4000-8000-000000000002",
  expectedManifestSha256: "a".repeat(64),
  stagingHandle: "30000000-0000-4000-8000-000000000003",
  cleanupHandle: "40000000-0000-4000-8000-000000000004",
  executionToken: "exact-database-execution-token",
  cleanupRegistered: true,
  isolatedCandidate: true,
}) satisfies AgentBackupRestoreV3StagingSession;

async function stageDatabase(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  bytes: Uint8Array,
): Promise<AgentBackupRestoreV3ComponentReceipt> {
  let dataFrameCount = 0;
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
    const payload = Uint8Array.from(
      bytes.subarray(offset, offset + 256 * 1024),
    );
    try {
      await stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: {
          componentIndex: 1,
          componentName: "database",
          dataIndex: dataFrameCount++,
          offsetBytes: offset,
          entry: null,
          payload,
        },
        control: control(),
      });
    } finally {
      payload.fill(0);
    }
  }
  const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[1];
  if (!descriptor) throw new Error("Missing database descriptor");
  return {
    componentIndex: 1,
    componentName: "database",
    descriptor,
    dataFrameCount,
    payloadBytes: bytes.length,
    payloadSha256: createHash("sha256").update(bytes).digest("hex"),
    recordStreamContentHmacSha256: "b".repeat(64),
  };
}

function control() {
  return {
    signal: new AbortController().signal,
    deadlineEpochMs: Date.now() + 60_000,
  };
}

async function extractionFixture(payload = gzipSync(archive(minimumEntries))) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "restore-v3-database-inbox-"),
  );
  roots.add(root);
  await fs.chmod(root, 0o700);
  const attemptRoot = path.join(root, "attempt");
  await fs.mkdir(attemptRoot, { mode: 0o700 });
  const candidateFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot: root,
    attemptRoot,
    control: control(),
    ...(process.platform === "linux"
      ? {}
      : { testOnlyAllowNonLinuxFdEmulation: true }),
  });
  candidates.add(candidateFs);
  const receipt = await stageDatabase(candidateFs, payload);
  const input = { candidateFs, session: SESSION, receipt, control: control() };
  return {
    input,
    attemptRoot,
    finish: path.join(
      attemptRoot,
      ".restore-v3-component-c1.database-extracted.json",
    ),
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

function checksum(header: Buffer) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}

function header(name: string, size: number, type = "0"): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, "utf8");
  bytes.write("0000600\0", 100, "ascii");
  bytes.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  bytes.write(type, 156, "ascii");
  bytes.write("ustar\0" + "00", 257, "ascii");
  checksum(bytes);
  return bytes;
}

function archive(
  entries: { name: string; payload?: string; type?: string }[],
): Buffer {
  return Buffer.concat([
    ...entries.flatMap((entry) => {
      const bytes = Buffer.from(entry.payload ?? "");
      return [
        header(entry.name, bytes.length, entry.type),
        bytes,
        Buffer.alloc((512 - (bytes.length % 512)) % 512),
      ];
    }),
    Buffer.alloc(1024),
  ]);
}

async function* fragments(bytes: Uint8Array, width = 117) {
  for (let offset = 0; offset < bytes.length; offset += width)
    yield bytes.subarray(offset, offset + width);
}

const minimumEntries = [
  { name: "/PG_VERSION", payload: "17\n" },
  { name: "/global/pg_control", payload: "fixture-control" },
];

function parse(
  bytes: Uint8Array,
  limits?: Partial<AgentBackupRestoreV3PgliteArchiveLimits>,
) {
  return readAgentBackupRestoreV3PgliteArchive({
    tar: fragments(bytes),
    control: control(),
    limits,
    visit: async (_entry, consume) => {
      await consume(async () => {});
    },
  });
}

describe("physical PGlite archive", () => {
  it("never validates an archive containing corrupt physical database control files", async () => {
    const { input, attemptRoot } = await extractionFixture();
    await expect(
      validateAgentBackupRestoreV3CandidateDatabase({
        ...input,
        control: { ...control(), deadlineEpochMs: Date.now() + 15_000 },
      }),
    ).rejects.toThrow();
    await expect(
      fs.stat(
        path.join(
          attemptRoot,
          ".restore-v3-component-c1.database-validated.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(attemptRoot, ".restore-v3-database-validation")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await fs.readFile(
        path.join(attemptRoot, "components/database/PG_VERSION"),
        "utf8",
      ),
    ).toBe("17\n");
  }, 20_000);
  it("never publishes extraction on payload mismatch, then safely replays the correct finish", async () => {
    const { input, finish } = await extractionFixture();
    await expect(
      extractAgentBackupRestoreV3CandidateDatabase({
        ...input,
        receipt: { ...input.receipt, payloadSha256: "c".repeat(64) },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_PAYLOAD_MISMATCH",
    });
    await expect(fs.stat(finish)).rejects.toMatchObject({ code: "ENOENT" });
    const first = await extractAgentBackupRestoreV3CandidateDatabase(input);
    expect(await extractAgentBackupRestoreV3CandidateDatabase(input)).toEqual(
      first,
    );
  });

  it("rejects truncated gzip without a durable extraction receipt", async () => {
    const bytes = gzipSync(archive(minimumEntries));
    const { input, finish } = await extractionFixture(
      bytes.subarray(0, bytes.length - 7),
    );
    await expect(
      extractAgentBackupRestoreV3CandidateDatabase(input),
    ).rejects.toThrow();
    await expect(fs.stat(finish)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an extra authenticated record rather than ignoring its suffix", async () => {
    const { input, finish } = await extractionFixture();
    await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs: input.candidateFs,
      session: SESSION,
      record: {
        componentIndex: 1,
        componentName: "database",
        dataIndex: input.receipt.dataFrameCount,
        offsetBytes: input.receipt.payloadBytes,
        entry: null,
        payload: new Uint8Array([1]),
      },
      control: control(),
    });
    await expect(
      extractAgentBackupRestoreV3CandidateDatabase(input),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_RECORD_COUNT_MISMATCH",
    });
    await expect(fs.stat(finish)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses replay when a quarantined file has changed, without overwriting it", async () => {
    const { input, attemptRoot } = await extractionFixture();
    const first = await extractAgentBackupRestoreV3CandidateDatabase(input);
    const target = path.join(attemptRoot, first.outputDirectory, "PG_VERSION");
    await fs.writeFile(target, "18\n");
    await fs.utimes(target, 0, 0);
    await expect(
      extractAgentBackupRestoreV3CandidateDatabase(input),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_FILE_CONFLICT",
    });
    expect(await fs.readFile(target, "utf8")).toBe("18\n");
  });

  it("rejects a different attempt authority before creating database output", async () => {
    const { input, attemptRoot } = await extractionFixture();
    await expect(
      extractAgentBackupRestoreV3CandidateDatabase({
        ...input,
        session: { ...SESSION, expectedManifestSha256: "d".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(attemptRoot, "components/database")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reopens a real gzip dump in an isolated candidate and recovers the saved fact", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "restore-v3-pglite-"),
    );
    roots.add(root);
    await fs.chmod(root, 0o700);
    const source = new PGlite(path.join(root, "source"));
    databases.add(source);
    await source.exec(
      "CREATE TABLE restore_fact (id integer PRIMARY KEY, fact text NOT NULL)",
    );
    await source.query("INSERT INTO restore_fact VALUES ($1, $2)", [
      1,
      "The remembered comet is indigo-20732",
    ]);
    const dump = await source.dumpDataDir("gzip");
    await source.close();
    databases.delete(source);
    await fs.rm(path.join(root, "source"), { recursive: true });

    const attemptRoot = path.join(root, "attempt");
    await fs.mkdir(attemptRoot, { mode: 0o700 });
    const candidate = await openAgentBackupRestoreV3CandidateFs({
      trustedRoot: root,
      attemptRoot,
      control: control(),
      ...(process.platform === "linux"
        ? {}
        : { testOnlyAllowNonLinuxFdEmulation: true }),
    });
    candidates.add(candidate);
    const bytes = new Uint8Array(await dump.arrayBuffer());
    const receipt = await stageDatabase(candidate, bytes);
    bytes.fill(0);
    const result = await extractAgentBackupRestoreV3CandidateDatabase({
      candidateFs: candidate,
      session: SESSION,
      receipt,
      control: control(),
    });
    expect(result.tree.files).toBeGreaterThan(10);
    expect(result.tree.bytes).toBeGreaterThan(1024 * 1024);
    // The first response may have been lost; retry before opening the database.
    expect(
      await extractAgentBackupRestoreV3CandidateDatabase({
        candidateFs: candidate,
        session: SESSION,
        receipt,
        control: control(),
      }),
    ).toEqual(result);
    const beforeValidation = await fs.stat(
      path.join(attemptRoot, result.outputDirectory, "PG_VERSION"),
    );
    const validation = await validateAgentBackupRestoreV3CandidateDatabase({
      candidateFs: candidate,
      session: SESSION,
      receipt,
      control: control(),
    });
    expect(validation.extractionFinishSha256).toBe(result.finishSha256);
    expect(validation.serverVersion).toMatch(/^[1-9][0-9]{4,5}$/);
    expect(
      await validateAgentBackupRestoreV3CandidateDatabase({
        candidateFs: candidate,
        session: SESSION,
        receipt,
        control: control(),
      }),
    ).toEqual(validation);
    expect(
      (
        await fs.stat(
          path.join(attemptRoot, result.outputDirectory, "PG_VERSION"),
        )
      ).mtimeMs,
    ).toBe(beforeValidation.mtimeMs);
    await expect(
      fs.stat(path.join(attemptRoot, ".restore-v3-database-validation")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const restored = new PGlite(path.join(attemptRoot, result.outputDirectory));
    databases.add(restored);
    expect(
      (await restored.query("SELECT id, fact FROM restore_fact")).rows,
    ).toEqual([{ id: 1, fact: "The remembered comet is indigo-20732" }]);
    await restored.close();
    databases.delete(restored);
    const restarted = new PGlite(
      path.join(attemptRoot, result.outputDirectory),
    );
    databases.add(restarted);
    expect(
      (
        await restarted.query(
          "SELECT count(*)::integer AS count FROM restore_fact",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  }, 90_000);

  it.each([
    "../escape",
    "/../escape",
    "//absolute",
    "a/../../escape",
    "a\\b",
    "a//b",
    "./relative",
    "a/\u0001",
    ".restore-v3-control",
  ])("rejects unsafe archive path %j", async (name) => {
    await expect(
      parse(archive([...minimumEntries, { name, payload: "bad" }])),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_PATH_INVALID",
    });
  });

  it.each(["1", "2", "3", "4", "6", "x", "g", "L", "S"])(
    "refuses link/special/extended type %s before consuming its contents",
    async (type) => {
      await expect(
        parse(archive([...minimumEntries, { name: "bad", type }])),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_TYPE_FORBIDDEN",
      });
    },
  );

  it("rejects normalized duplicates and file/directory collisions", async () => {
    await expect(
      parse(archive([...minimumEntries, { name: "PG_VERSION" }])),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_DUPLICATE",
    });
    await expect(
      parse(archive([...minimumEntries, { name: "global" }])),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_PATH_COLLISION",
    });
    await expect(
      parse(archive([...minimumEntries, { name: "PG_VERSION/child" }])),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_PATH_COLLISION",
    });
  });

  it("rejects header tamper, hidden octal values and nonzero padding", async () => {
    const tampered = archive(minimumEntries);
    tampered[0] = 88;
    await expect(parse(tampered)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_CHECKSUM_MISMATCH",
    });
    const hidden = archive(minimumEntries);
    hidden[101] = 0;
    checksum(hidden.subarray(0, 512));
    await expect(parse(hidden)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_HEADER_INVALID",
    });
    const reserved = archive(minimumEntries);
    reserved[505] = 7;
    checksum(reserved.subarray(0, 512));
    await expect(parse(reserved)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_HEADER_INVALID",
    });
    const padding = archive(minimumEntries);
    padding[520] = 1;
    await expect(parse(padding)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_PADDING_INVALID",
    });
  });

  it("rejects high-bit aliases of USTAR magic and canonically equivalent paths", async () => {
    const magic = archive(minimumEntries);
    magic[257] = magic.readUInt8(257) | 128;
    checksum(magic.subarray(0, 512));
    await expect(parse(magic)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_HEADER_INVALID",
    });
    await expect(
      parse(
        archive([...minimumEntries, { name: "café" }, { name: "cafe\u0301" }]),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_DUPLICATE",
    });
  });

  it("requires both end blocks and rejects appended archives or partial padding", async () => {
    const valid = archive(minimumEntries);
    await expect(
      parse(valid.subarray(0, valid.length - 512)),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_TRUNCATED",
    });
    await expect(parse(Buffer.concat([valid, valid]))).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_TRAILING_DATA",
    });
    await expect(
      parse(Buffer.concat([valid, Buffer.alloc(1)])),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_TRUNCATED",
    });
  });

  it("rejects archives missing the physical database rather than booting empty", async () => {
    await expect(
      parse(archive([{ name: "PG_VERSION", payload: "17\n" }])),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_DATABASE_MISSING",
    });
    await expect(parse(archive([]))).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_DATABASE_MISSING",
    });
  });

  it.each([
    [{ maximumFileBytes: 2 }, "FILE_LIMIT"],
    [{ maximumTarBytes: 512 }, "TAR_LIMIT"],
    [{ maximumExtractedBytes: 3 }, "EXTRACTED_LIMIT"],
    [{ maximumFiles: 1 }, "FILE_COUNT_LIMIT"],
    [{ maximumDepth: 1 }, "PATH_INVALID"],
  ] as const)("enforces extraction budget %j", async (limits, code) => {
    await expect(parse(archive(minimumEntries), limits)).rejects.toMatchObject({
      code: `AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_${code}`,
    });
  });

  it("closes its source on cancellation and stops calling the consumer", async () => {
    const abort = new AbortController();
    let closed = false;
    let visits = 0;
    async function* source() {
      try {
        yield* fragments(archive(minimumEntries));
      } finally {
        closed = true;
      }
    }
    await expect(
      readAgentBackupRestoreV3PgliteArchive({
        tar: source(),
        control: { ...control(), signal: abort.signal },
        visit: async (_entry, consume) => {
          visits++;
          await consume(async () => {
            abort.abort();
          });
        },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ABORTED",
    });
    expect(closed).toBe(true);
    expect(visits).toBe(1);
  });

  it("does not mutate borrowed source buffers and zeroizes consumed copies", async () => {
    const bytes = archive(minimumEntries);
    const before = Buffer.from(bytes);
    const borrowed: Uint8Array[] = [];
    await readAgentBackupRestoreV3PgliteArchive({
      tar: fragments(bytes),
      control: control(),
      visit: async (_entry, consume) => {
        await consume(async (chunk) => {
          borrowed.push(chunk);
        });
      },
    });
    expect(bytes).toEqual(before);
    expect(borrowed.length).toBeGreaterThan(0);
    expect(borrowed.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
      true,
    );
  });
});
