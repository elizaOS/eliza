/** Adversarial proofs for exact character and file-set materialization. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupCaptureV2FileEntry,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3StagedRecord,
  type AgentBackupRestoreV3StagingSession,
  type AgentBackupRestoreV3StreamComponentName,
} from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_MAXIMUM_BYTES,
  materializeAgentBackupRestoreV3CandidateCharacter,
} from "./agent-backup-restore-v3-candidate-character";
import { materializeAgentBackupRestoreV3CandidateFileSet } from "./agent-backup-restore-v3-candidate-file-set";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import { stageAgentBackupRestoreV3CandidateRecord } from "./agent-backup-restore-v3-candidate-records";

const roots = new Set<string>();
const candidates = new Set<AgentBackupRestoreV3CandidateFs>();
const EMPTY_SHA256 = createHash("sha256").digest("hex");

const SESSION = Object.freeze({
  restoreAttemptId: "10000000-0000-4000-8000-000000000001",
  operationId: "20000000-0000-4000-8000-000000000002",
  expectedManifestSha256: "a".repeat(64),
  stagingHandle: "30000000-0000-4000-8000-000000000003",
  cleanupHandle: "40000000-0000-4000-8000-000000000004",
  executionToken: "exact-materializer-execution-token",
  cleanupRegistered: true as const,
  isolatedCandidate: true as const,
}) satisfies AgentBackupRestoreV3StagingSession;

function operationControl() {
  return {
    signal: new AbortController().signal,
    deadlineEpochMs: Date.now() + 30_000,
  };
}

function platformTestOption() {
  return process.platform === "linux"
    ? {}
    : ({ testOnlyAllowNonLinuxFdEmulation: true as const } as const);
}

async function fixture(): Promise<{
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly trustedRoot: string;
  readonly attemptRoot: string;
}> {
  const trustedRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "restore-v3-materializer-"),
  );
  roots.add(trustedRoot);
  await fs.chmod(trustedRoot, 0o700);
  const attemptRoot = path.join(trustedRoot, "attempt");
  await fs.mkdir(attemptRoot, { mode: 0o700 });
  const candidateFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot,
    attemptRoot,
    control: operationControl(),
    ...platformTestOption(),
  });
  candidates.add(candidateFs);
  return { candidateFs, trustedRoot, attemptRoot };
}

interface TestDataRecord {
  readonly payload: Uint8Array;
  readonly entry: AgentBackupCaptureV2FileEntry | null;
}

function descriptorIndex(
  name: AgentBackupRestoreV3StreamComponentName,
): number {
  return ["character", "database", "media", "state-files", "vault"].indexOf(
    name,
  );
}

async function stageComponent(
  candidateFs: AgentBackupRestoreV3CandidateFs,
  componentName: AgentBackupRestoreV3StreamComponentName,
  records: readonly TestDataRecord[],
): Promise<Readonly<AgentBackupRestoreV3ComponentReceipt>> {
  const componentIndex = descriptorIndex(componentName);
  const hash = createHash("sha256");
  let offsetBytes = 0;
  for (const [dataIndex, record] of records.entries()) {
    hash.update(record.payload);
    const staged: AgentBackupRestoreV3StagedRecord = {
      componentIndex,
      componentName,
      dataIndex,
      offsetBytes,
      entry: record.entry,
      payload: record.payload,
    };
    await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: staged,
      control: operationControl(),
    });
    offsetBytes += record.payload.byteLength;
  }
  const descriptor =
    AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[componentIndex];
  if (!descriptor) throw new Error("missing component descriptor");
  return Object.freeze({
    componentIndex,
    componentName,
    descriptor: Object.freeze({ ...descriptor }),
    dataFrameCount: records.length,
    payloadBytes: offsetBytes,
    payloadSha256: hash.digest("hex"),
    recordStreamContentHmacSha256: "b".repeat(64),
  });
}

function fileRecords(input: {
  readonly path: string;
  readonly bytes: Uint8Array | string;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly splitAt?: number;
}): readonly TestDataRecord[] {
  const bytes =
    typeof input.bytes === "string"
      ? new TextEncoder().encode(input.bytes)
      : input.bytes;
  const splitAt = input.splitAt ?? bytes.byteLength;
  const fragments =
    bytes.byteLength === 0
      ? [new Uint8Array(0)]
      : [bytes.subarray(0, splitAt), bytes.subarray(splitAt)].filter(
          (fragment) => fragment.byteLength > 0,
        );
  let fileOffsetBytes = 0;
  return fragments.map((payload) => {
    const record = Object.freeze({
      payload: Uint8Array.from(payload),
      entry: Object.freeze({
        path: input.path,
        fileOffsetBytes,
        fileSizeBytes: bytes.byteLength,
        mode: input.mode,
        mtimeMs: input.mtimeMs,
      }),
    });
    fileOffsetBytes += payload.byteLength;
    return record;
  });
}

function candidatePartialName(filePath: string): string {
  return `.restore-v3-partial-${createHash("sha256")
    .update(filePath, "utf8")
    .digest("hex")}`;
}

interface WriterDoubleFailureInjection {
  readonly writeFailure: Error;
  readonly closeFailure: Error;
  readonly state: {
    writeInjected: boolean;
    closeInjected: boolean;
    closeLeakedHandle: (() => Promise<void>) | null;
  };
  readonly restore: () => void;
}

async function injectWriterDoubleFailure(input: {
  readonly attemptRoot: string;
  readonly partialPath: string;
  readonly label: string;
}): Promise<WriterDoubleFailureInjection> {
  const probe = await fs.open(
    path.join(input.attemptRoot, `${input.label}-descriptor-probe`),
    "w",
  );
  const handlePrototype = Object.getPrototypeOf(probe) as {
    write: typeof probe.write;
  };
  const originalWrite = handlePrototype.write;
  const originalOpen = fs.open;
  await probe.close();
  const matchesPartial = async (handle: typeof probe): Promise<boolean> => {
    try {
      const [opened, visible] = await Promise.all([
        handle.stat({ bigint: true }),
        fs.lstat(input.partialPath, { bigint: true }),
      ]);
      return opened.dev === visible.dev && opened.ino === visible.ino;
    } catch {
      return false;
    }
  };
  const writeFailure = new Error(`injected ${input.label} write failure`);
  const closeFailure = new Error(
    `injected ${input.label} descriptor close failure`,
  );
  const state: WriterDoubleFailureInjection["state"] = {
    writeInjected: false,
    closeInjected: false,
    closeLeakedHandle: null,
  };
  const partialName = path.basename(input.partialPath);
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await Reflect.apply(originalOpen, fs, args);
    if (path.basename(String(args[0])) === partialName) {
      const exactClose = handle.close;
      handle.close = async () => {
        if (state.writeInjected && !state.closeInjected) {
          state.closeInjected = true;
          state.closeLeakedHandle = () => Reflect.apply(exactClose, handle, []);
          throw closeFailure;
        }
        return Reflect.apply(exactClose, handle, []);
      };
    }
    return handle;
  });
  const writeSpy = vi
    .spyOn(handlePrototype, "write")
    .mockImplementation(async function (
      this: typeof probe,
      ...args: Parameters<typeof probe.write>
    ) {
      if (!state.writeInjected && (await matchesPartial(this))) {
        state.writeInjected = true;
        throw writeFailure;
      }
      return Reflect.apply(originalWrite, this, args);
    });
  return {
    writeFailure,
    closeFailure,
    state,
    restore() {
      writeSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

function expectExactWriterDoubleFailure(
  failure: unknown,
  injection: WriterDoubleFailureInjection,
): void {
  expect(injection.state.writeInjected).toBe(true);
  expect(injection.state.closeInjected).toBe(true);
  expect(failure).toMatchObject({
    code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CLEANUP_FAILED",
  });
  const aggregate = (failure as { cause?: unknown }).cause;
  expect(aggregate).toBeInstanceOf(AggregateError);
  const causes = (aggregate as AggregateError).errors;
  expect(causes).toHaveLength(2);
  expect(causes[0]).toBe(injection.writeFailure);
  expect(causes[1]).toBe(injection.closeFailure);
  expect(
    causes.filter((cause) => cause === injection.writeFailure),
  ).toHaveLength(1);
  expect(
    causes.filter((cause) => cause === injection.closeFailure),
  ).toHaveLength(1);
}

afterEach(async () => {
  const pendingCandidates = [...candidates];
  candidates.clear();
  await Promise.all(
    pendingCandidates.map((candidateFs) => candidateFs.close()),
  );
  const pendingRoots = [...roots];
  roots.clear();
  await Promise.all(
    pendingRoots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("restore-v3 candidate character materializer", () => {
  it("preserves original validated JSON bytes and exactly replays a lost finish response", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const original = '{\n  "name" : "Aria"\n}\n';
    const bytes = new TextEncoder().encode(original);
    const receipt = await stageComponent(candidateFs, "character", [
      { payload: bytes.subarray(0, 7), entry: null },
      { payload: bytes.subarray(7), entry: null },
    ]);
    const filePath = path.join(
      attemptRoot,
      "components",
      "character",
      "character.json",
    );
    await expect(
      materializeAgentBackupRestoreV3CandidateCharacter({
        candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
        testOnlyLifecycle: {
          afterInboxValidated() {
            throw new Error("crash after character inbox validation");
          },
        },
      }),
    ).rejects.toThrow("crash after character inbox validation");
    await expect(fs.lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });

    let publishedProof: unknown;
    await expect(
      materializeAgentBackupRestoreV3CandidateCharacter({
        candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
        testOnlyLifecycle: {
          afterFilePublished(proof) {
            publishedProof = proof;
            throw new Error("crash after character file publication");
          },
        },
      }),
    ).rejects.toThrow("crash after character file publication");
    let lost = true;
    await expect(
      materializeAgentBackupRestoreV3CandidateCharacter({
        candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
        testOnlyLifecycle: {
          afterDurableFinish() {
            if (lost) {
              lost = false;
              throw new Error("lost character finish response");
            }
          },
        },
      }),
    ).rejects.toThrow("lost character finish response");
    const replayed = await materializeAgentBackupRestoreV3CandidateCharacter({
      candidateFs,
      session: SESSION,
      receipt,
      control: operationControl(),
    });
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    expect(replayed.file).toEqual(publishedProof);
    expect(replayed.file.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const stats = await fs.stat(filePath, { bigint: true });
    expect(Number(stats.mode & 0o777n)).toBe(0o600);
    expect(stats.mtimeNs).toBe(0n);
    const { finishSha256, ...finishBody } = replayed;
    expect(finishSha256).toBe(
      createHash("sha256")
        .update(candidateFsCanonicalJson(finishBody), "utf8")
        .digest("hex"),
    );
  });

  it("fails closed for null, invalid UTF-8, and oversized character bombs without defaults", async () => {
    const nullCase = await fixture();
    const nullReceipt = await stageComponent(
      nullCase.candidateFs,
      "character",
      [{ payload: new TextEncoder().encode("null"), entry: null }],
    );
    await expect(
      materializeAgentBackupRestoreV3CandidateCharacter({
        candidateFs: nullCase.candidateFs,
        session: SESSION,
        receipt: nullReceipt,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INVALID",
    });
    await expect(
      fs.lstat(path.join(nullCase.attemptRoot, "components")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const utf8Case = await fixture();
    const utf8Receipt = await stageComponent(
      utf8Case.candidateFs,
      "character",
      [{ payload: Uint8Array.of(0xc3, 0x28), entry: null }],
    );
    await expect(
      materializeAgentBackupRestoreV3CandidateCharacter({
        candidateFs: utf8Case.candidateFs,
        session: SESSION,
        receipt: utf8Receipt,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_UTF8_INVALID",
    });

    const bombCase = await fixture();
    const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0];
    const bombReceipt = Object.freeze({
      componentIndex: 0,
      componentName: "character" as const,
      descriptor: Object.freeze({ ...descriptor }),
      dataFrameCount: 1,
      payloadBytes:
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_MAXIMUM_BYTES + 1,
      payloadSha256: "c".repeat(64),
      recordStreamContentHmacSha256: "d".repeat(64),
    });
    await expect(
      materializeAgentBackupRestoreV3CandidateCharacter({
        candidateFs: bombCase.candidateFs,
        session: SESSION,
        receipt: bombReceipt,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_LIMIT",
    });
  });

  it("preserves write and descriptor cleanup failures once and releases the character lock", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const bytes = new TextEncoder().encode('{"name":"Double Failure"}');
    const receipt = await stageComponent(candidateFs, "character", [
      { payload: bytes, entry: null },
    ]);
    const injection = await injectWriterDoubleFailure({
      attemptRoot,
      partialPath: path.join(
        attemptRoot,
        "components",
        "character",
        candidatePartialName("character.json"),
      ),
      label: "character",
    });
    let failure: unknown;
    try {
      await materializeAgentBackupRestoreV3CandidateCharacter({
        candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
      });
    } catch (cause) {
      failure = cause;
    } finally {
      injection.restore();
    }
    try {
      expectExactWriterDoubleFailure(failure, injection);
      const reacquired = await candidateFs.acquireLock(
        ".restore-v3-materialize-c0.lock",
        operationControl(),
      );
      await reacquired.release(operationControl());
    } finally {
      if (injection.state.closeLeakedHandle) {
        await injection.state.closeLeakedHandle();
      }
    }
  });

  it("rejects accessors and production lifecycle hooks before any durable mutation", async () => {
    const boundary = await fixture();
    const bytes = new TextEncoder().encode('{"name":"Boundary"}');
    const receipt = await stageComponent(boundary.candidateFs, "character", [
      { payload: bytes, entry: null },
    ]);
    let accessorCalls = 0;
    const accessorInput = {
      session: SESSION,
      receipt,
      control: operationControl(),
    } as Record<string, unknown>;
    Object.defineProperty(accessorInput, "candidateFs", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("character boundary accessor must not run");
      },
    });
    let boundaryFailure: unknown;
    try {
      await materializeAgentBackupRestoreV3CandidateCharacter(
        accessorInput as never,
      );
    } catch (cause) {
      boundaryFailure = cause;
    }
    expect(boundaryFailure).toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_INPUT_INVALID",
    });
    expect(accessorCalls).toBe(0);

    const production = await fixture();
    const productionReceipt = await stageComponent(
      production.candidateFs,
      "character",
      [{ payload: bytes, entry: null }],
    );
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        materializeAgentBackupRestoreV3CandidateCharacter({
          candidateFs: production.candidateFs,
          session: SESSION,
          receipt: productionReceipt,
          control: operationControl(),
          testOnlyLifecycle: { afterFilePublished: () => undefined },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_CHARACTER_TEST_HOOK_FORBIDDEN",
        }),
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
    await expect(
      fs.lstat(path.join(production.attemptRoot, "components")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("restore-v3 candidate file-set materializer", () => {
  it("recovers a partial crash, preserves captured mtime metadata, and replays finish", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const exactApfsMtimeMs = 1_700_000_000_123;
    const records = [
      ...fileRecords({
        path: "a.txt",
        bytes: "alpha",
        mode: 0o640,
        mtimeMs: exactApfsMtimeMs,
        splitAt: 2,
      }),
      ...fileRecords({
        path: "empty",
        bytes: new Uint8Array(0),
        mode: 0o600,
        mtimeMs: 1_700_000_000_456,
      }),
      ...fileRecords({
        path: "nested/é.bin",
        bytes: Uint8Array.of(0, 1, 2, 3),
        mode: 0o700,
        mtimeMs: 1_700_000_000_789,
      }),
    ];
    const receipt = await stageComponent(candidateFs, "media", records);
    let crash = true;
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
        testOnlyLifecycle: {
          afterRecordConsumed() {
            if (crash) {
              crash = false;
              throw new Error("crash with descriptor-bound partial");
            }
          },
        },
      }),
    ).rejects.toThrow("crash with descriptor-bound partial");

    let lost = true;
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
        testOnlyLifecycle: {
          afterDurableFinish() {
            if (lost) {
              lost = false;
              throw new Error("lost file-set finish response");
            }
          },
        },
      }),
    ).rejects.toThrow("lost file-set finish response");
    const root = path.join(attemptRoot, "components", "media");
    const linkedCrashPartial = path.join(
      root,
      `.restore-v3-partial-${createHash("sha256")
        .update("a.txt", "utf8")
        .digest("hex")}`,
    );
    await fs.link(path.join(root, "a.txt"), linkedCrashPartial);
    const replayed = await materializeAgentBackupRestoreV3CandidateFileSet({
      candidateFs,
      session: SESSION,
      receipt,
      control: operationControl(),
    });
    expect(replayed.tree.entries.map((entry) => entry.path)).toEqual([
      "a.txt",
      "empty",
      "nested/é.bin",
    ]);
    await expect(fs.lstat(linkedCrashPartial)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("alpha");
    expect(await fs.readFile(path.join(root, "nested", "é.bin"))).toEqual(
      Buffer.from([0, 1, 2, 3]),
    );
    const alpha = await fs.stat(path.join(root, "a.txt"));
    expect(alpha.mode & 0o777).toBe(0o640);
    expect(Math.trunc(alpha.mtimeMs)).toBe(exactApfsMtimeMs);
  });

  it("fsyncs a target-only replay after cancellation follows the partial unlink", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const control = operationControl();
    const relativeDirectory = "components/media";
    const spec = Object.freeze({
      path: "target-only.txt",
      sizeBytes: 1,
      mode: 0o600,
      mtimeMs: 0,
    });
    await candidateFs.ensureFileTreeDirectory(relativeDirectory, control);
    const writer = await candidateFs.createFileTreeFile(
      relativeDirectory,
      spec,
      undefined,
      control,
    );
    await writer.write(Uint8Array.of(1), control);

    const root = path.join(attemptRoot, "components", "media");
    const partialName = candidatePartialName(spec.path);
    const partialPath = path.join(root, partialName);
    const abortController = new AbortController();
    const interruptedControl = Object.freeze({
      signal: abortController.signal,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const originalUnlink = fs.unlink;
    let unlinked = false;
    const unlinkSpy = vi
      .spyOn(fs, "unlink")
      .mockImplementation(async (...args) => {
        await Reflect.apply(originalUnlink, fs, args);
        if (path.basename(String(args[0])) === partialName) {
          unlinked = true;
          abortController.abort(new Error("cancel after exact partial unlink"));
        }
      });
    try {
      await expect(writer.finalize(interruptedControl)).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ABORTED",
      });
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(unlinked).toBe(true);
    await expect(fs.lstat(partialPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(root, spec.path))).toEqual(
      Buffer.from([1]),
    );

    const rootIdentity = await fs.stat(root, { bigint: true });
    const probe = await fs.open(root, "r");
    const handlePrototype = Object.getPrototypeOf(probe) as {
      sync: typeof probe.sync;
    };
    const originalSync = handlePrototype.sync;
    await probe.close();
    let targetParentSyncs = 0;
    const syncSpy = vi
      .spyOn(handlePrototype, "sync")
      .mockImplementation(async function (
        this: typeof probe,
        ...args: Parameters<typeof probe.sync>
      ) {
        const opened = await this.stat({ bigint: true });
        if (
          opened.dev === rootIdentity.dev &&
          opened.ino === rootIdentity.ino
        ) {
          targetParentSyncs += 1;
        }
        return Reflect.apply(originalSync, this, args);
      });
    try {
      const replayed = await candidateFs.createFileTreeFile(
        relativeDirectory,
        spec,
        undefined,
        operationControl(),
      );
      expect(replayed.replayed).toBe(true);
      await replayed.finalize(operationControl());
    } finally {
      syncSpy.mockRestore();
    }
    expect(targetParentSyncs).toBe(1);
  });

  it("proves files in canonical full-path order across a file-directory prefix", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const receipt = await stageComponent(candidateFs, "state-files", [
      ...fileRecords({
        path: "foo.txt",
        bytes: "sibling",
        mode: 0o600,
        mtimeMs: 0,
      }),
      ...fileRecords({
        path: "foo/bar",
        bytes: "child",
        mode: 0o600,
        mtimeMs: 0,
      }),
    ]);
    const materialized = await materializeAgentBackupRestoreV3CandidateFileSet({
      candidateFs,
      session: SESSION,
      receipt,
      control: operationControl(),
    });
    expect(materialized.tree.entries.map((entry) => entry.path)).toEqual([
      "foo.txt",
      "foo/bar",
    ]);
    const root = path.join(attemptRoot, "components", "state-files");
    expect(await fs.readFile(path.join(root, "foo.txt"), "utf8")).toBe(
      "sibling",
    );
    expect(await fs.readFile(path.join(root, "foo", "bar"), "utf8")).toBe(
      "child",
    );
  });

  it("recovers, proves, and replays files with 0400, 0200, and 0000 modes", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const records = [
      ...fileRecords({
        path: "mode-0000",
        bytes: "zero",
        mode: 0o000,
        mtimeMs: 0,
      }),
      ...fileRecords({
        path: "mode-0200",
        bytes: "write-only",
        mode: 0o200,
        mtimeMs: 1,
      }),
      ...fileRecords({
        path: "mode-0400",
        bytes: "read-only",
        mode: 0o400,
        mtimeMs: 2,
      }),
    ];
    const receipt = await stageComponent(candidateFs, "vault", records);
    let crashed = false;
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
        testOnlyLifecycle: {
          afterFilePublished(proof) {
            if (!crashed && proof.path === "mode-0000") {
              crashed = true;
              throw new Error("crash after unreadable file publish");
            }
          },
        },
      }),
    ).rejects.toThrow("crash after unreadable file publish");

    let responseLost = false;
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
        testOnlyLifecycle: {
          afterDurableFinish() {
            if (!responseLost) {
              responseLost = true;
              throw new Error("lost unreadable file-set finish response");
            }
          },
        },
      }),
    ).rejects.toThrow("lost unreadable file-set finish response");

    const replayed = await materializeAgentBackupRestoreV3CandidateFileSet({
      candidateFs,
      session: SESSION,
      receipt,
      control: operationControl(),
    });
    expect(replayed.tree.entries.map((entry) => entry.mode)).toEqual([
      0o000, 0o200, 0o400,
    ]);
    const root = path.join(attemptRoot, "components", "vault");
    for (const [name, mode] of [
      ["mode-0000", 0o000],
      ["mode-0200", 0o200],
      ["mode-0400", 0o400],
    ] as const) {
      const stats = await fs.stat(path.join(root, name), { bigint: true });
      expect(Number(stats.mode & 0o777n)).toBe(mode);
    }
  });

  it("refuses unauthenticated set-id and sticky file mode bits", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const control = operationControl();
    await candidateFs.ensureFileTreeDirectory("components/media", control);
    const writer = await candidateFs.createFileTreeFile(
      "components/media",
      { path: "special-mode", sizeBytes: 1, mode: 0o600, mtimeMs: 0 },
      undefined,
      control,
    );
    await writer.write(Uint8Array.of(1), control);
    const proof = await writer.finalize(control);
    const target = path.join(
      attemptRoot,
      "components",
      "media",
      "special-mode",
    );
    // Bun currently masks 07000 in its fs.chmod shim. Use the host syscall
    // utility so the proof is exercised against an actual hostile inode mode.
    execFileSync("chmod", ["4600", target]);
    const changed = await fs.stat(target, { bigint: true });
    expect(Number(changed.mode & 0o7000n)).toBe(0o4000);
    await expect(
      candidateFs.proveFileTree(
        "components/media",
        [proof],
        undefined,
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
    });
  });

  it("keeps writer bounds immutable and rejects negative-zero specs", async () => {
    const { candidateFs } = await fixture();
    const control = operationControl();
    await candidateFs.ensureFileTreeDirectory("components/media", control);
    for (const spec of [
      { path: "negative-size", sizeBytes: -0, mode: 0o600, mtimeMs: 0 },
      { path: "negative-mode", sizeBytes: 0, mode: -0, mtimeMs: 0 },
      { path: "negative-mtime", sizeBytes: 0, mode: 0o600, mtimeMs: -0 },
    ]) {
      await expect(
        candidateFs.createFileTreeFile(
          "components/media",
          spec,
          undefined,
          control,
        ),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_SPEC_INVALID",
      });
    }

    const writer = await candidateFs.createFileTreeFile(
      "components/media",
      { path: "bounded", sizeBytes: 1, mode: 0o600, mtimeMs: 0 },
      { maximumBytes: 1 },
      control,
    );
    expect(
      Reflect.set(writer, "spec", {
        path: "forged",
        sizeBytes: 2,
        mode: 0o777,
        mtimeMs: 1,
      }),
    ).toBe(false);
    expect(Reflect.set(writer, "replayed", true)).toBe(false);
    expect(writer.spec).toEqual({
      path: "bounded",
      sizeBytes: 1,
      mode: 0o600,
      mtimeMs: 0,
    });
    expect(writer.replayed).toBe(false);
    await writer.write(Uint8Array.of(1), control);
    await writer.finalize(control);
  });

  it("fsyncs an EEXIST replay after mkdir completed before cancellation", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const controller = new AbortController();
    const interruptedControl = {
      signal: controller.signal,
      deadlineEpochMs: Date.now() + 30_000,
    };
    const originalMkdir = fs.mkdir;
    let injected = false;
    const mkdirSpy = vi
      .spyOn(fs, "mkdir")
      .mockImplementation(async (...args) => {
        const result = await Reflect.apply(originalMkdir, fs, args);
        if (!injected && String(args[0]).endsWith(`${path.sep}components`)) {
          injected = true;
          controller.abort(new Error("cancel after durable mkdir syscall"));
        }
        return result;
      });
    try {
      await expect(
        candidateFs.ensureFileTreeDirectory(
          "components/replayed",
          interruptedControl,
        ),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ABORTED",
      });
    } finally {
      mkdirSpy.mockRestore();
    }
    expect(injected).toBe(true);
    await expect(
      fs.stat(path.join(attemptRoot, "components")),
    ).resolves.toBeDefined();

    const rootIdentity = await fs.stat(attemptRoot, { bigint: true });
    const probePath = path.join(attemptRoot, "sync-probe");
    const probe = await fs.open(probePath, "w", 0o600);
    const handlePrototype = Object.getPrototypeOf(probe) as {
      sync: typeof probe.sync;
    };
    const originalSync = handlePrototype.sync;
    await probe.close();
    await fs.unlink(probePath);
    let replayParentSynced = false;
    const syncSpy = vi
      .spyOn(handlePrototype, "sync")
      .mockImplementation(async function (this: typeof probe) {
        const opened = await this.stat({ bigint: true });
        if (
          opened.dev === rootIdentity.dev &&
          opened.ino === rootIdentity.ino
        ) {
          replayParentSynced = true;
        }
        return Reflect.apply(originalSync, this, []);
      });
    try {
      await candidateFs.ensureFileTreeDirectory(
        "components/replayed",
        operationControl(),
      );
    } finally {
      syncSpy.mockRestore();
    }
    expect(replayParentSynced).toBe(true);
  });

  it("accepts only an exact authenticated empty set and refuses extra inbox records", async () => {
    const emptyCase = await fixture();
    const receipt = await stageComponent(emptyCase.candidateFs, "vault", []);
    expect(receipt).toMatchObject({
      dataFrameCount: 0,
      payloadBytes: 0,
      payloadSha256: EMPTY_SHA256,
    });
    const empty = await materializeAgentBackupRestoreV3CandidateFileSet({
      candidateFs: emptyCase.candidateFs,
      session: SESSION,
      receipt,
      control: operationControl(),
    });
    expect(empty.tree).toMatchObject({ files: 0, bytes: 0 });
    expect(
      await fs.readdir(path.join(emptyCase.attemptRoot, "components", "vault")),
    ).toEqual([]);
    await fs.mkdir(
      path.join(
        emptyCase.attemptRoot,
        "components",
        "vault",
        "unmanifested-empty",
      ),
      { mode: 0o700 },
    );
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs: emptyCase.candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
    });

    const forgedCase = await fixture();
    const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[4];
    const forged = Object.freeze({
      componentIndex: 4,
      componentName: "vault" as const,
      descriptor: Object.freeze({ ...descriptor }),
      dataFrameCount: 0,
      payloadBytes: 1,
      payloadSha256: "e".repeat(64),
      recordStreamContentHmacSha256: "f".repeat(64),
    });
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs: forgedCase.candidateFs,
        session: SESSION,
        receipt: forged,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_SET_LIMIT",
    });

    const extraCase = await fixture();
    await stageComponent(
      extraCase.candidateFs,
      "vault",
      fileRecords({
        path: "unexpected",
        bytes: new Uint8Array(0),
        mode: 0o600,
        mtimeMs: 0,
      }),
    );
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs: extraCase.candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_SET_RECORD_COUNT_MISMATCH",
    });
  });

  it("refuses reserved, traversal, duplicate Unicode, symlink, and hardlink paths", async () => {
    const reservedCase = await fixture();
    const reservedReceipt = await stageComponent(
      reservedCase.candidateFs,
      "state-files",
      fileRecords({
        path: ".restore-v3-owned",
        bytes: "secret",
        mode: 0o600,
        mtimeMs: 0,
      }),
    );
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs: reservedCase.candidateFs,
        session: SESSION,
        receipt: reservedReceipt,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_PATH_FORBIDDEN",
    });

    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: reservedCase.candidateFs,
        session: SESSION,
        record: {
          componentIndex: 3,
          componentName: "state-files",
          dataIndex: 1,
          offsetBytes: 6,
          entry: {
            path: "../escape",
            fileOffsetBytes: 0,
            fileSizeBytes: 1,
            mode: 0o600,
            mtimeMs: 0,
          },
          payload: Uint8Array.of(1),
        },
        control: operationControl(),
      }),
    ).toThrow();

    const unicodeCase = await fixture();
    const unicodeReceipt = await stageComponent(
      unicodeCase.candidateFs,
      "media",
      [
        ...fileRecords({
          path: "é.txt",
          bytes: "one",
          mode: 0o600,
          mtimeMs: 0,
        }),
        ...fileRecords({
          path: "é.txt",
          bytes: "two",
          mode: 0o600,
          mtimeMs: 0,
        }),
      ],
    );
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs: unicodeCase.candidateFs,
        session: SESSION,
        receipt: unicodeReceipt,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_SET_PATH_DUPLICATE",
    });

    for (const kind of ["symlink", "hardlink"] as const) {
      const attacked = await fixture();
      const attackedReceipt = await stageComponent(
        attacked.candidateFs,
        "media",
        fileRecords({
          path: "attacked",
          bytes: "exact",
          mode: 0o600,
          mtimeMs: 0,
        }),
      );
      const output = path.join(attacked.attemptRoot, "components", "media");
      await fs.mkdir(output, { recursive: true, mode: 0o700 });
      const outside = path.join(attacked.trustedRoot, `${kind}-outside`);
      await fs.writeFile(outside, "outside", { mode: 0o600 });
      if (kind === "symlink")
        await fs.symlink(outside, path.join(output, "attacked"));
      else await fs.link(outside, path.join(output, "attacked"));
      await expect(
        materializeAgentBackupRestoreV3CandidateFileSet({
          candidateFs: attacked.candidateFs,
          session: SESSION,
          receipt: attackedReceipt,
          control: operationControl(),
        }),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_UNSAFE",
      });
      expect(await fs.readFile(outside, "utf8")).toBe("outside");
    }
  });

  it("fails closed on parent replacement and post-finish inode tampering", async () => {
    const replacement = await fixture();
    const replacementReceipt = await stageComponent(
      replacement.candidateFs,
      "media",
      fileRecords({
        path: "bound.txt",
        bytes: "bound",
        mode: 0o600,
        mtimeMs: 0,
      }),
    );
    let replaced = false;
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs: replacement.candidateFs,
        session: SESSION,
        receipt: replacementReceipt,
        control: operationControl(),
        testOnlyLifecycle: {
          afterFilePublished() {
            if (replaced) return;
            replaced = true;
            const parent = path.join(
              replacement.attemptRoot,
              "components",
              "media",
            );
            renameSync(parent, `${parent}-displaced`);
            mkdirSync(parent, { mode: 0o700 });
          },
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      fs.readFile(
        path.join(replacement.attemptRoot, "components", "media", "bound.txt"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const tamper = await fixture();
    const tamperReceipt = await stageComponent(
      tamper.candidateFs,
      "media",
      fileRecords({
        path: "tamper.txt",
        bytes: "exact",
        mode: 0o600,
        mtimeMs: 0,
      }),
    );
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs: tamper.candidateFs,
        session: SESSION,
        receipt: tamperReceipt,
        control: operationControl(),
        testOnlyLifecycle: {
          afterDurableFinish() {
            const target = path.join(
              tamper.attemptRoot,
              "components",
              "media",
              "tamper.txt",
            );
            renameSync(target, `${target}.replaced-inode`);
            writeFileSync(target, "exact", { mode: 0o600 });
            utimesSync(target, new Date(0), new Date(0));
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
    });
    const lock = await tamper.candidateFs.acquireLock(
      "after-tamper.lock",
      operationControl(),
    );
    await lock.release(operationControl());
  });

  it("bounds directory bombs and never invokes custom fragment iterators or Proxy traps", async () => {
    const bomb = await fixture();
    const bombReceipt = await stageComponent(bomb.candidateFs, "media", [
      ...fileRecords({
        path: "first/a",
        bytes: "a",
        mode: 0o600,
        mtimeMs: 0,
      }),
      ...fileRecords({
        path: "second/b",
        bytes: "b",
        mode: 0o600,
        mtimeMs: 0,
      }),
    ]);
    await expect(
      materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs: bomb.candidateFs,
        session: SESSION,
        receipt: bombReceipt,
        control: operationControl(),
        limits: {
          maximumBytes: 2,
          maximumFiles: 2,
          maximumDirectories: 1,
          maximumDepth: 2,
          maximumPathBytes: 32,
        },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_SET_LIMIT",
    });
    const bombRoot = path.join(bomb.attemptRoot, "components", "media");
    expect(await fs.readdir(bombRoot)).toEqual(["first"]);
    await expect(fs.lstat(path.join(bombRoot, "second"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );

    const intrinsicCase = await fixture();
    let proxyTraps = 0;
    const proxiedSpec = new Proxy(
      { path: "proxy", sizeBytes: 1, mode: 0o600, mtimeMs: 0 },
      {
        get() {
          proxyTraps += 1;
          throw new Error("Proxy trap must not run");
        },
      },
    );
    await expect(
      intrinsicCase.candidateFs.createFileTreeFile(
        "components/media",
        proxiedSpec,
        undefined,
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_SPEC_INVALID",
    });
    expect(proxyTraps).toBe(0);

    const proxiedLimits = new Proxy(
      { maximumBytes: 1 },
      {
        get() {
          proxyTraps += 1;
          throw new Error("Limits Proxy trap must not run");
        },
      },
    );
    await expect(
      intrinsicCase.candidateFs.createFileTreeFile(
        "components/media",
        { path: "limits", sizeBytes: 1, mode: 0o600, mtimeMs: 0 },
        proxiedLimits,
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT_INVALID",
    });
    expect(proxyTraps).toBe(0);

    const proxiedExpected = new Proxy([], {
      get() {
        proxyTraps += 1;
        throw new Error("Expected-proof Proxy trap must not run");
      },
    });
    await expect(
      intrinsicCase.candidateFs.proveFileTree(
        "components/media",
        proxiedExpected,
        undefined,
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT",
    });
    expect(proxyTraps).toBe(0);

    const writer = await intrinsicCase.candidateFs.createFileTreeFile(
      "components/media",
      { path: "iterator", sizeBytes: 1, mode: 0o600, mtimeMs: 0 },
      undefined,
      operationControl(),
    );
    const fragment = Uint8Array.of(1);
    let iteratorCalls = 0;
    Object.defineProperty(fragment, Symbol.iterator, {
      configurable: true,
      value() {
        iteratorCalls += 1;
        throw new Error("Iterator must not run");
      },
    });
    expect(() => writer.write(fragment, operationControl())).toThrow();
    expect(iteratorCalls).toBe(0);
    await writer.close();
  });

  it("rejects accessors and production lifecycle hooks before file-set mutation", async () => {
    const boundary = await fixture();
    const receipt = await stageComponent(
      boundary.candidateFs,
      "media",
      fileRecords({
        path: "boundary.txt",
        bytes: "boundary",
        mode: 0o600,
        mtimeMs: 0,
      }),
    );
    let accessorCalls = 0;
    const accessorInput = {
      session: SESSION,
      receipt,
      control: operationControl(),
    } as Record<string, unknown>;
    Object.defineProperty(accessorInput, "candidateFs", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("file-set boundary accessor must not run");
      },
    });
    let boundaryFailure: unknown;
    try {
      await materializeAgentBackupRestoreV3CandidateFileSet(
        accessorInput as never,
      );
    } catch (cause) {
      boundaryFailure = cause;
    }
    expect(boundaryFailure).toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_SET_INPUT_INVALID",
    });
    expect(accessorCalls).toBe(0);

    const production = await fixture();
    const productionReceipt = await stageComponent(
      production.candidateFs,
      "media",
      fileRecords({
        path: "production.txt",
        bytes: "production",
        mode: 0o600,
        mtimeMs: 0,
      }),
    );
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        materializeAgentBackupRestoreV3CandidateFileSet({
          candidateFs: production.candidateFs,
          session: SESSION,
          receipt: productionReceipt,
          control: operationControl(),
          testOnlyLifecycle: { afterFilePublished: () => undefined },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_SET_TEST_HOOK_FORBIDDEN",
        }),
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
    await expect(
      fs.lstat(path.join(production.attemptRoot, "components")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a same-inode rewrite after the file was individually proved", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const control = operationControl();
    await candidateFs.ensureFileTreeDirectory("components/media", control);
    const proofs = [];
    for (const [filePath, contents] of [
      ["a.txt", "aaaa"],
      ["b.txt", "bbbb"],
    ] as const) {
      const writer = await candidateFs.createFileTreeFile(
        "components/media",
        {
          path: filePath,
          sizeBytes: contents.length,
          mode: 0o600,
          mtimeMs: 0,
        },
        undefined,
        control,
      );
      await writer.write(new TextEncoder().encode(contents), control);
      proofs.push(await writer.finalize(control));
    }
    const firstPath = path.join(attemptRoot, "components", "media", "a.txt");
    const firstBefore = await fs.stat(firstPath, { bigint: true });
    const probe = await fs.open(firstPath, "r");
    const handlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    const originalRead = handlePrototype.read;
    await probe.close();
    let reads = 0;
    const readSpy = vi
      .spyOn(handlePrototype, "read")
      .mockImplementation(async function (
        this: typeof probe,
        ...args: Parameters<typeof probe.read>
      ) {
        const result = await Reflect.apply(originalRead, this, args);
        reads += 1;
        if (reads === 2) {
          writeFileSync(firstPath, "evil");
          utimesSync(firstPath, new Date(0), new Date(0));
        }
        return result;
      });
    try {
      await expect(
        candidateFs.proveFileTree(
          "components/media",
          proofs,
          undefined,
          control,
        ),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
      });
    } finally {
      readSpy.mockRestore();
    }
    const firstAfter = await fs.stat(firstPath, { bigint: true });
    expect(firstAfter.ino).toBe(firstBefore.ino);
    expect(firstAfter.mtimeNs).toBe(0n);
    expect(firstAfter.ctimeNs).not.toBe(firstBefore.ctimeNs);
  });

  it("preserves a finalize failure classification and still releases its lock", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const receipt = await stageComponent(
      candidateFs,
      "media",
      fileRecords({
        path: "finalize-failure",
        bytes: "x",
        mode: 0o600,
        mtimeMs: 0,
      }),
    );
    const probePath = path.join(attemptRoot, "utimes-probe");
    const probe = await fs.open(probePath, "w", 0o600);
    const handlePrototype = Object.getPrototypeOf(probe) as {
      utimes: typeof probe.utimes;
    };
    const originalUtimes = handlePrototype.utimes;
    await probe.close();
    await fs.unlink(probePath);
    let injected = false;
    const utimesSpy = vi
      .spyOn(handlePrototype, "utimes")
      .mockImplementation(async function (
        this: typeof probe,
        ...args: Parameters<typeof probe.utimes>
      ) {
        if (!injected) {
          injected = true;
          throw new Error("injected file-tree finalize failure");
        }
        return Reflect.apply(originalUtimes, this, args);
      });
    try {
      await expect(
        materializeAgentBackupRestoreV3CandidateFileSet({
          candidateFs,
          session: SESSION,
          receipt,
          control: operationControl(),
        }),
      ).rejects.toThrow("injected file-tree finalize failure");
    } finally {
      utimesSpy.mockRestore();
    }
    expect(injected).toBe(true);
    const reacquired = await candidateFs.acquireLock(
      "after-finalize-failure.lock",
      operationControl(),
    );
    await reacquired.release(operationControl());
  });

  it("reports write and descriptor cleanup failures once and releases the file-set lock", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const receipt = await stageComponent(
      candidateFs,
      "media",
      fileRecords({
        path: "double-failure.txt",
        bytes: "failure",
        mode: 0o600,
        mtimeMs: 0,
      }),
    );
    const injection = await injectWriterDoubleFailure({
      attemptRoot,
      partialPath: path.join(
        attemptRoot,
        "components",
        "media",
        candidatePartialName("double-failure.txt"),
      ),
      label: "file-set",
    });
    let failure: unknown;
    try {
      await materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs,
        session: SESSION,
        receipt,
        control: operationControl(),
      });
    } catch (cause) {
      failure = cause;
    } finally {
      injection.restore();
    }
    try {
      expectExactWriterDoubleFailure(failure, injection);
      const reacquired = await candidateFs.acquireLock(
        ".restore-v3-materialize-c2.lock",
        operationControl(),
      );
      await reacquired.release(operationControl());
    } finally {
      if (injection.state.closeLeakedHandle) {
        await injection.state.closeLeakedHandle();
      }
    }
  });

  it("releases caller lock use even when a proof descriptor close fails", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const control = operationControl();
    await candidateFs.ensureFileTreeDirectory("components/media", control);
    const writer = await candidateFs.createFileTreeFile(
      "components/media",
      { path: "cleanup.txt", sizeBytes: 7, mode: 0o600, mtimeMs: 0 },
      undefined,
      control,
    );
    await writer.write(new TextEncoder().encode("cleanup"), control);
    const proof = await writer.finalize(control);
    const treeRoot = path.join(attemptRoot, "components", "media");
    const treeRootIdentity = await fs.stat(treeRoot, { bigint: true });
    const heldLock = await candidateFs.acquireLock(
      "file-tree-cleanup.lock",
      control,
    );
    const originalOpen = fs.open;
    let injected = false;
    const cleanupState: {
      closeLeakedHandle: (() => Promise<void>) | null;
    } = { closeLeakedHandle: null };
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await Reflect.apply(originalOpen, fs, args);
      const opened = await handle.stat({ bigint: true });
      if (
        opened.dev === treeRootIdentity.dev &&
        opened.ino === treeRootIdentity.ino
      ) {
        const exactClose = handle.close;
        handle.close = async () => {
          if (!injected) {
            injected = true;
            cleanupState.closeLeakedHandle = () =>
              Reflect.apply(exactClose, handle, []);
            throw new Error("injected file-tree descriptor close failure");
          }
          return Reflect.apply(exactClose, handle, []);
        };
      }
      return handle;
    });
    try {
      await expect(
        candidateFs.proveFileTree(
          "components/media",
          [proof],
          undefined,
          control,
          heldLock,
        ),
      ).rejects.toThrow("injected file-tree descriptor close failure");
    } finally {
      openSpy.mockRestore();
      if (cleanupState.closeLeakedHandle) {
        await cleanupState.closeLeakedHandle();
      }
    }
    expect(injected).toBe(true);
    const released = await Promise.race([
      heldLock.release(control).then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    expect(released).toBe(true);
  });

  it("keeps a caller-held lock alive until a blocked file-tree write settles", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const control = operationControl();
    const heldLock = await candidateFs.acquireLock(
      "file-tree-write.lock",
      control,
    );
    await candidateFs.ensureFileTreeDirectory(
      "components/media",
      control,
      heldLock,
    );
    const writer = await candidateFs.createFileTreeFile(
      "components/media",
      { path: "blocked.txt", sizeBytes: 7, mode: 0o600, mtimeMs: 0 },
      undefined,
      control,
      heldLock,
    );
    const probe = await fs.open(path.join(attemptRoot, "write-probe"), "w");
    const handlePrototype = Object.getPrototypeOf(probe) as {
      write: typeof probe.write;
    };
    const originalWrite = handlePrototype.write;
    await probe.close();
    let enterWrite: () => void = () => undefined;
    let unblockWrite: () => void = () => undefined;
    const writeEntered = new Promise<void>((resolve) => {
      enterWrite = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      unblockWrite = resolve;
    });
    let intercepted = false;
    const writeSpy = vi
      .spyOn(handlePrototype, "write")
      .mockImplementation(async function (
        this: typeof probe,
        ...args: Parameters<typeof probe.write>
      ) {
        if (!intercepted) {
          intercepted = true;
          enterWrite();
          await writeGate;
        }
        return Reflect.apply(originalWrite, this, args);
      });
    let releaseSettled = false;
    let releasePromise: Promise<void> | null = null;
    try {
      const pendingWrite = writer.write(
        new TextEncoder().encode("blocked"),
        control,
      );
      await writeEntered;
      releasePromise = heldLock.release(control).then(() => {
        releaseSettled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(releaseSettled).toBe(false);
      unblockWrite();
      await expect(pendingWrite).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
      });
      await releasePromise;
      expect(releaseSettled).toBe(true);
    } finally {
      unblockWrite();
      writeSpy.mockRestore();
      await writer.close();
      if (releasePromise) await releasePromise;
      if (!releaseSettled) await heldLock.release(operationControl());
    }
  });

  it("keeps materializer plaintext away from poisoned byte-array intrinsics", async () => {
    const character = await fixture();
    const characterBytes = new TextEncoder().encode('{"name":"Intrinsic"}');
    const characterReceipt = await stageComponent(
      character.candidateFs,
      "character",
      [{ payload: characterBytes, entry: null }],
    );
    const fileSet = await fixture();
    const fileSetReceipt = await stageComponent(
      fileSet.candidateFs,
      "vault",
      fileRecords({
        path: "secret.bin",
        bytes: new TextEncoder().encode(
          "file-set-intrinsic-plaintext-sentinel-7f13d0a9",
        ),
        mode: 0o600,
        mtimeMs: 0,
        splitAt: 23,
      }),
    );
    const descriptors = {
      fill: Object.getOwnPropertyDescriptor(Uint8Array.prototype, "fill"),
      set: Object.getOwnPropertyDescriptor(Uint8Array.prototype, "set"),
      subarray: Object.getOwnPropertyDescriptor(
        Uint8Array.prototype,
        "subarray",
      ),
    };
    const fillIntrinsic = Uint8Array.prototype.fill;
    const setIntrinsic = Uint8Array.prototype.set;
    const subarrayIntrinsic = Uint8Array.prototype.subarray;
    const sensitiveSequences = [
      characterBytes,
      new TextEncoder().encode(
        "file-set-intrinsic-plaintext-sentinel-7f13d0a9",
      ),
      new TextEncoder().encode("file-set-intrinsic-plai"),
      new TextEncoder().encode("ntext-sentinel-7f13d0a9"),
    ];
    const containsSensitiveBytes = (value: unknown): boolean => {
      if (!(value instanceof Uint8Array)) return false;
      for (const sequence of sensitiveSequences) {
        if (sequence.byteLength > value.byteLength) continue;
        for (
          let offset = 0;
          offset <= value.byteLength - sequence.byteLength;
          offset += 1
        ) {
          let matches = true;
          for (let index = 0; index < sequence.byteLength; index += 1) {
            if (value[offset + index] !== sequence[index]) {
              matches = false;
              break;
            }
          }
          if (matches) return true;
        }
      }
      return false;
    };
    let sensitiveIntrinsicCalls = 0;
    const observe = (...values: readonly unknown[]): void => {
      if (values.some(containsSensitiveBytes)) sensitiveIntrinsicCalls += 1;
    };
    try {
      Object.defineProperty(Uint8Array.prototype, "fill", {
        ...descriptors.fill,
        configurable: true,
        writable: true,
        value(this: Uint8Array, ...args: readonly unknown[]) {
          observe(this);
          return Reflect.apply(fillIntrinsic, this, args);
        },
      });
      Object.defineProperty(Uint8Array.prototype, "set", {
        ...descriptors.set,
        configurable: true,
        writable: true,
        value(this: Uint8Array, ...args: readonly unknown[]) {
          observe(this, args[0]);
          return Reflect.apply(setIntrinsic, this, args);
        },
      });
      Object.defineProperty(Uint8Array.prototype, "subarray", {
        ...descriptors.subarray,
        configurable: true,
        writable: true,
        value(this: Uint8Array, ...args: readonly unknown[]) {
          observe(this);
          return Reflect.apply(subarrayIntrinsic, this, args);
        },
      });
      await materializeAgentBackupRestoreV3CandidateCharacter({
        candidateFs: character.candidateFs,
        session: SESSION,
        receipt: characterReceipt,
        control: operationControl(),
      });
      await materializeAgentBackupRestoreV3CandidateFileSet({
        candidateFs: fileSet.candidateFs,
        session: SESSION,
        receipt: fileSetReceipt,
        control: operationControl(),
      });
    } finally {
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (descriptor) {
          Object.defineProperty(Uint8Array.prototype, name, descriptor);
        } else {
          Reflect.deleteProperty(Uint8Array.prototype, name);
        }
      }
    }
    expect(sensitiveIntrinsicCalls).toBe(0);
  });

  it("rejects raw invalid UTF-8 names in exact file-tree proofs on Linux", async () => {
    if (process.platform !== "linux") return;
    const { candidateFs, attemptRoot } = await fixture();
    const control = operationControl();
    await candidateFs.ensureFileTreeDirectory("components/media", control);
    const root = path.join(attemptRoot, "components", "media");
    const invalidName = Buffer.concat([
      Buffer.from(`${root}${path.sep}`),
      Buffer.from([0xff]),
    ]);
    await fs.writeFile(invalidName, "invalid", { flag: "wx", mode: 0o600 });
    await expect(
      candidateFs.proveFileTree("components/media", [], undefined, control),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_UNSAFE",
    });
  });
});
