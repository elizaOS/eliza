/** Exact crash/replay and divergence proofs for the candidate record inbox. */

import { createHash, createHmac, Hash, Hmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  type AgentBackupRestoreV3StagedRecord,
  type AgentBackupRestoreV3StageRecordReceipt,
  type AgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentBackupRestoreV3CandidateFs,
  AgentBackupRestoreV3CandidateFsLock,
  AgentBackupRestoreV3CandidatePayloadWriter,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import {
  AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES,
  AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_OWNER_CONTEXT,
  bindAgentBackupRestoreV3CandidateRecordSession,
  computeAgentBackupRestoreV3CandidateRecordCommandSha256,
  readAgentBackupRestoreV3CandidateRecord,
  stageAgentBackupRestoreV3CandidateRecord,
} from "./agent-backup-restore-v3-candidate-records";

const roots = new Set<string>();
const candidates = new Set<AgentBackupRestoreV3CandidateFs>();

function operationControl(signal = new AbortController().signal) {
  return {
    signal,
    deadlineEpochMs: Date.now() + 30_000,
  };
}

function platformTestOption() {
  return process.platform === "linux"
    ? {}
    : ({ testOnlyAllowNonLinuxFdEmulation: true as const } as const);
}

const SESSION = Object.freeze({
  restoreAttemptId: "10000000-0000-4000-8000-000000000001",
  operationId: "20000000-0000-4000-8000-000000000002",
  expectedManifestSha256: "a".repeat(64),
  stagingHandle: "30000000-0000-4000-8000-000000000003",
  cleanupHandle: "40000000-0000-4000-8000-000000000004",
  executionToken: "exact-record-execution-token",
  cleanupRegistered: true as const,
  isolatedCandidate: true as const,
}) satisfies AgentBackupRestoreV3StagingSession;

async function fixture(): Promise<{
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly attemptRoot: string;
}> {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "restore-v3-record-inbox-"),
  );
  roots.add(root);
  await fs.chmod(root, 0o700);
  const attemptRoot = path.join(root, "attempt");
  await fs.mkdir(attemptRoot, { mode: 0o700 });
  const candidateFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot: root,
    attemptRoot,
    control: operationControl(),
    ...platformTestOption(),
  });
  candidates.add(candidateFs);
  return { candidateFs, attemptRoot };
}

function record(
  payload: Uint8Array | string,
  options: {
    readonly componentIndex?: number;
    readonly componentName?: "character" | "database";
    readonly dataIndex?: number;
    readonly offsetBytes?: number;
  } = {},
): AgentBackupRestoreV3StagedRecord {
  return {
    componentIndex: options.componentIndex ?? 0,
    componentName: options.componentName ?? "character",
    dataIndex: options.dataIndex ?? 0,
    offsetBytes: options.offsetBytes ?? 0,
    entry: null,
    payload:
      typeof payload === "string" ? new TextEncoder().encode(payload) : payload,
  };
}

async function exactFilesystemSnapshot(attemptRoot: string) {
  const names = (await fs.readdir(attemptRoot)).sort();
  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(attemptRoot, name);
      const stats = await fs.lstat(filePath, { bigint: true });
      const contentSha256 = stats.isFile()
        ? createHash("sha256")
            .update(await fs.readFile(filePath))
            .digest("hex")
        : null;
      return Object.freeze({
        name,
        device: stats.dev.toString(10),
        inode: stats.ino.toString(10),
        mode: stats.mode.toString(8),
        links: stats.nlink.toString(10),
        size: stats.size.toString(10),
        modifiedNanoseconds: stats.mtimeNs.toString(10),
        contentSha256,
      });
    }),
  );
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

describe("restore-v3 candidate record inbox", () => {
  it("copies, stages, reads, and exactly replays one deterministic slot", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const mutable = new TextEncoder().encode("exact-record");
    const staged = record(mutable);
    const pending = stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: staged,
      control: operationControl(),
    });
    mutable.fill(0);
    const receipt = await pending;

    expect(receipt).toMatchObject({
      version: 1,
      payloadName: ".restore-v3-record-c0-d0.payload",
      record: {
        componentIndex: 0,
        componentName: "character",
        dataIndex: 0,
        offsetBytes: 0,
        payloadBytes: 12,
        payloadSha256: createHash("sha256")
          .update("exact-record")
          .digest("hex"),
      },
    });
    const ownerCapabilityHex = createHmac(
      "sha256",
      Buffer.from(SESSION.executionToken, "utf8"),
    )
      .update(AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_OWNER_CONTEXT, "utf8")
      .update(Buffer.of(0))
      .update(Buffer.from(receipt.commandSha256, "hex"))
      .digest("hex");
    const persistedText = Buffer.concat(
      await Promise.all(
        (await fs.readdir(attemptRoot)).map((name) =>
          fs.readFile(path.join(attemptRoot, name)),
        ),
      ),
    ).toString("utf8");
    expect(persistedText).not.toContain(SESSION.executionToken);
    expect(persistedText).not.toContain(ownerCapabilityHex);
    expect(
      computeAgentBackupRestoreV3CandidateRecordCommandSha256(
        SESSION,
        receipt.record,
        receipt.previousReceiptSha256,
      ),
    ).toBe(receipt.commandSha256);
    expect(
      computeAgentBackupRestoreV3CandidateRecordCommandSha256(
        SESSION,
        receipt.record,
        "0".repeat(64),
      ),
    ).not.toBe(receipt.commandSha256);

    const read = await readAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      componentIndex: 0,
      dataIndex: 0,
      control: operationControl(),
    });
    expect(read.receipt).toEqual(receipt);
    expect(Buffer.from(read.payload).toString("utf8")).toBe("exact-record");
    read.payload.fill(0);

    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record("exact-record"),
        control: operationControl(),
      }),
    ).resolves.toEqual(receipt);
  });

  it("keeps absent and stale reads strictly read-only", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const emptySnapshot = await exactFilesystemSnapshot(attemptRoot);
    await expect(
      readAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        componentIndex: 0,
        dataIndex: 0,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_SESSION_ABSENT",
    });
    await expect(exactFilesystemSnapshot(attemptRoot)).resolves.toEqual(
      emptySnapshot,
    );

    await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: record("bound"),
      control: operationControl(),
    });
    const durableSnapshot = await exactFilesystemSnapshot(attemptRoot);
    await expect(
      readAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: { ...SESSION, executionToken: "stale-execution-token" },
        componentIndex: 0,
        dataIndex: 0,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_SESSION_CONFLICT",
    });
    await expect(
      readAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        componentIndex: 0,
        dataIndex: 1,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_ABSENT",
    });
    await expect(exactFilesystemSnapshot(attemptRoot)).resolves.toEqual(
      durableSnapshot,
    );
  });

  it("chains only contiguous component-local record slots", async () => {
    const { candidateFs } = await fixture();
    const first = await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: record("abc"),
      control: operationControl(),
    });
    const second = await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: record("defg", { dataIndex: 1, offsetBytes: 3 }),
      control: operationControl(),
    });
    expect(second.previousReceiptSha256).toBe(first.receiptSha256);

    const empty = await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: record(new Uint8Array(0), {
        componentIndex: 1,
        componentName: "database",
      }),
      control: operationControl(),
    });
    expect(empty.record.payloadBytes).toBe(0);
    const emptyRead = await readAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      componentIndex: 1,
      dataIndex: 0,
      control: operationControl(),
    });
    expect(emptyRead.payload).toHaveLength(0);

    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record("gap", {
          componentIndex: 1,
          componentName: "database",
          dataIndex: 1,
          offsetBytes: 3,
        }),
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CHAIN_CONFLICT",
    });
    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record("different"),
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_RECEIPT_CONFLICT",
    });
  });

  it("repairs a crash after payload proof and replays a lost durable response", async () => {
    const { candidateFs } = await fixture();
    let crashOnce = true;
    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record("first"),
        control: operationControl(),
        testOnlyLifecycle: {
          afterPayloadFinalized() {
            if (crashOnce) {
              crashOnce = false;
              throw new Error("simulated crash after payload proof");
            }
          },
        },
      }),
    ).rejects.toThrow("simulated crash after payload proof");
    const recovered = await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: record("first"),
      control: operationControl(),
    });

    let loseOnce = true;
    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record("second", { dataIndex: 1, offsetBytes: 5 }),
        control: operationControl(),
        testOnlyLifecycle: {
          afterDurableReceipt() {
            if (loseOnce) {
              loseOnce = false;
              throw new Error("simulated lost durable response");
            }
          },
        },
      }),
    ).rejects.toThrow("simulated lost durable response");
    const replayed = await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: record("second", { dataIndex: 1, offsetBytes: 5 }),
      control: operationControl(),
    });
    expect(replayed.previousReceiptSha256).toBe(recovered.receiptSha256);
  });

  it("does not replay a rejected finalize as a second cleanup failure", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const originalFinalize =
      AgentBackupRestoreV3CandidatePayloadWriter.prototype.finalize;
    const finalizeSpy = vi
      .spyOn(AgentBackupRestoreV3CandidatePayloadWriter.prototype, "finalize")
      .mockImplementation(function (
        this: AgentBackupRestoreV3CandidatePayloadWriter,
        control,
      ) {
        const pending = Reflect.apply(originalFinalize, this, [control]);
        // finalize() has returned its settlement promise but is paused at its
        // first await. Change the bound inode before its exact-state proof so
        // the real writer rejects after assuming cleanup ownership.
        writeFileSync(
          path.join(attemptRoot, ".restore-v3-record-c0-d0.payload"),
          "changed-after-finalize-returned",
        );
        return pending;
      });

    let failure: unknown;
    try {
      await stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record("finalize-rejection"),
        control: operationControl(),
      });
    } catch (cause) {
      failure = cause;
    } finally {
      finalizeSpy.mockRestore();
    }

    expect(failure).toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
    });
    expect(failure).not.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CLEANUP_FAILED",
    });
    const recoveredLock = await candidateFs.acquireLock(
      "restore-v3-record-inbox.lock",
      operationControl(),
    );
    await recoveredLock.release(operationControl());
  });

  it("retains cleanup ownership when finalize throws synchronously", async () => {
    const { candidateFs } = await fixture();
    const finalizeFailure = new Error("synchronous finalize failure");
    const originalClose =
      AgentBackupRestoreV3CandidatePayloadWriter.prototype.close;
    let closeCalls = 0;
    const closeSpy = vi
      .spyOn(AgentBackupRestoreV3CandidatePayloadWriter.prototype, "close")
      .mockImplementation(function (
        this: AgentBackupRestoreV3CandidatePayloadWriter,
      ) {
        closeCalls += 1;
        return Reflect.apply(originalClose, this, []);
      });
    const finalizeSpy = vi
      .spyOn(AgentBackupRestoreV3CandidatePayloadWriter.prototype, "finalize")
      .mockImplementation(() => {
        throw finalizeFailure;
      });

    let failure: unknown;
    try {
      await stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record("synchronous-finalize"),
        control: operationControl(),
      });
    } catch (cause) {
      failure = cause;
    } finally {
      finalizeSpy.mockRestore();
      closeSpy.mockRestore();
    }

    expect(failure).toBe(finalizeFailure);
    expect(closeCalls).toBe(1);
    const recoveredLock = await candidateFs.acquireLock(
      "restore-v3-record-inbox.lock",
      operationControl(),
    );
    await recoveredLock.release(operationControl());
  });

  it("preserves undefined stage failures and aggregates Error plus undefined cleanup", async () => {
    const undefinedCase = await fixture();
    const undefinedFinalizeSpy = vi
      .spyOn(AgentBackupRestoreV3CandidatePayloadWriter.prototype, "finalize")
      .mockImplementation(() => {
        throw undefined;
      });
    let undefinedRejected = false;
    let undefinedFailure: unknown = new Error("stage did not reject");
    try {
      await stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: undefinedCase.candidateFs,
        session: SESSION,
        record: record("undefined-stage-primary"),
        control: operationControl(),
      });
    } catch (cause) {
      undefinedRejected = true;
      undefinedFailure = cause;
    } finally {
      undefinedFinalizeSpy.mockRestore();
    }
    expect(undefinedRejected).toBe(true);
    expect(undefinedFailure).toBeUndefined();

    const combinedCase = await fixture();
    const primaryFailure = new Error("stage primary failure");
    const originalClose =
      AgentBackupRestoreV3CandidatePayloadWriter.prototype.close;
    const closeSpy = vi
      .spyOn(AgentBackupRestoreV3CandidatePayloadWriter.prototype, "close")
      .mockImplementation(async function (
        this: AgentBackupRestoreV3CandidatePayloadWriter,
      ) {
        await Reflect.apply(originalClose, this, []);
        throw undefined;
      });
    const errorFinalizeSpy = vi
      .spyOn(AgentBackupRestoreV3CandidatePayloadWriter.prototype, "finalize")
      .mockImplementation(() => {
        throw primaryFailure;
      });
    let combinedFailure: unknown;
    try {
      await stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: combinedCase.candidateFs,
        session: SESSION,
        record: record("error-plus-undefined-cleanup"),
        control: operationControl(),
      });
    } catch (cause) {
      combinedFailure = cause;
    } finally {
      errorFinalizeSpy.mockRestore();
      closeSpy.mockRestore();
    }
    expect(combinedFailure).toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CLEANUP_FAILED",
    });
    const combinedCause = (combinedFailure as Error).cause;
    expect(combinedCause).toBeInstanceOf(AggregateError);
    const [preservedPrimary, preservedCleanup] = (
      combinedCause as AggregateError
    ).errors;
    expect(preservedPrimary).toBe(primaryFailure);
    expect(preservedCleanup).toBeUndefined();
  });

  it("preserves undefined read cleanup alone and beside a primary error", async () => {
    const { candidateFs } = await fixture();
    await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: record("read-before-undefined-cleanup"),
      control: operationControl(),
    });
    const originalRelease =
      AgentBackupRestoreV3CandidateFsLock.prototype.release;
    const releaseSpy = vi
      .spyOn(AgentBackupRestoreV3CandidateFsLock.prototype, "release")
      .mockImplementation(async function (
        this: AgentBackupRestoreV3CandidateFsLock,
        control,
      ) {
        await Reflect.apply(originalRelease, this, [control]);
        throw undefined;
      });
    let cleanupRejected = false;
    let cleanupFailure: unknown = new Error("read did not reject");
    let combinedFailure: unknown;
    try {
      try {
        await readAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session: SESSION,
          componentIndex: 0,
          dataIndex: 0,
          control: operationControl(),
        });
      } catch (cause) {
        cleanupRejected = true;
        cleanupFailure = cause;
      }
      try {
        await readAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session: SESSION,
          componentIndex: 0,
          dataIndex: 1,
          control: operationControl(),
        });
      } catch (cause) {
        combinedFailure = cause;
      }
    } finally {
      releaseSpy.mockRestore();
    }
    expect(cleanupRejected).toBe(true);
    expect(cleanupFailure).toBeUndefined();
    expect(combinedFailure).toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CLEANUP_FAILED",
    });
    const combinedCause = (combinedFailure as Error).cause;
    expect(combinedCause).toBeInstanceOf(AggregateError);
    const [primaryFailure, preservedCleanup] = (combinedCause as AggregateError)
      .errors;
    expect(primaryFailure).toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_ABSENT",
    });
    expect(preservedCleanup).toBeUndefined();
  });

  it("rejects hung or mutating test hooks and always releases flock", async () => {
    const hungCase = await fixture();
    const hung = new Promise<void>(() => undefined);
    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: hungCase.candidateFs,
        session: SESSION,
        record: record("hung"),
        control: operationControl(),
        testOnlyLifecycle: {
          afterPayloadFinalized: (() => hung) as unknown as () => void,
        },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_TEST_HOOK_ASYNC",
    });
    const recoveredLock = await hungCase.candidateFs.acquireLock(
      "after-hung-hook.lock",
      operationControl(),
    );
    await recoveredLock.release(operationControl());

    const synchronousMutationCase = await fixture();
    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: synchronousMutationCase.candidateFs,
        session: SESSION,
        record: record("exact"),
        control: operationControl(),
        testOnlyLifecycle: {
          afterPayloadFinalized() {
            writeFileSync(
              path.join(
                synchronousMutationCase.attemptRoot,
                ".restore-v3-record-c0-d0.payload",
              ),
              "other",
            );
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
    });
    const mutationLock = await synchronousMutationCase.candidateFs.acquireLock(
      "after-mutating-hook.lock",
      operationControl(),
    );
    await mutationLock.release(operationControl());

    const lateMutationCase = await fixture();
    let lateMutation: Promise<void> | undefined;
    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: lateMutationCase.candidateFs,
        session: SESSION,
        record: record("later"),
        control: operationControl(),
        testOnlyLifecycle: {
          afterPayloadFinalized: (() => {
            lateMutation = new Promise((resolve) => {
              setTimeout(() => {
                writeFileSync(
                  path.join(
                    lateMutationCase.attemptRoot,
                    ".restore-v3-record-c0-d0.payload",
                  ),
                  "after",
                );
                resolve();
              }, 10);
            });
            return lateMutation;
          }) as unknown as () => void,
        },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_TEST_HOOK_ASYNC",
    });
    await lateMutation;
    const lateLock = await lateMutationCase.candidateFs.acquireLock(
      "after-late-hook.lock",
      operationControl(),
    );
    await lateLock.release(operationControl());
    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: lateMutationCase.candidateFs,
        session: SESSION,
        record: record("later"),
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
    });

    const finalReceiptCase = await fixture();
    await expect(
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: finalReceiptCase.candidateFs,
        session: SESSION,
        record: record("receipt"),
        control: operationControl(),
        testOnlyLifecycle: {
          afterDurableReceipt() {
            writeFileSync(
              path.join(
                finalReceiptCase.attemptRoot,
                ".restore-v3-record-c0-d0.receipt.json",
              ),
              "{}\n",
            );
          },
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    const finalReceiptLock = await finalReceiptCase.candidateFs.acquireLock(
      "after-final-receipt-hook.lock",
      operationControl(),
    );
    await finalReceiptLock.release(operationControl());
  });

  it("fails closed on session, owner-journal, and payload divergence", async () => {
    const sessionCase = await fixture();
    await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs: sessionCase.candidateFs,
      session: SESSION,
      record: record("session"),
      control: operationControl(),
    });
    await expect(
      readAgentBackupRestoreV3CandidateRecord({
        candidateFs: sessionCase.candidateFs,
        session: { ...SESSION, executionToken: "another-execution-token" },
        componentIndex: 0,
        dataIndex: 0,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_SESSION_CONFLICT",
    });

    const ownerCase = await fixture();
    const ownerReceipt = await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs: ownerCase.candidateFs,
      session: SESSION,
      record: record("owner"),
      control: operationControl(),
    });
    const payloadDerivation = createHash("sha256")
      .update(ownerReceipt.payloadName)
      .digest("hex")
      .slice(0, 32);
    const ownerJournalPath = path.join(
      ownerCase.attemptRoot,
      `.payload-${payloadDerivation}.owner.json`,
    );
    const ownerJournal = JSON.parse(
      await fs.readFile(ownerJournalPath, "utf8"),
    );
    await fs.writeFile(
      ownerJournalPath,
      `${JSON.stringify({
        maximumBytes: ownerJournal.maximumBytes,
        name: ownerJournal.name,
        ownerTokenSha256: "0".repeat(64),
        version: ownerJournal.version,
      })}\n`,
    );
    await expect(
      readAgentBackupRestoreV3CandidateRecord({
        candidateFs: ownerCase.candidateFs,
        session: SESSION,
        componentIndex: 0,
        dataIndex: 0,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_CONFLICT",
    });

    const payloadCase = await fixture();
    const payloadReceipt = await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs: payloadCase.candidateFs,
      session: SESSION,
      record: record("bytes"),
      control: operationControl(),
    });
    await fs.writeFile(
      path.join(payloadCase.attemptRoot, payloadReceipt.payloadName),
      "other",
    );
    await expect(
      readAgentBackupRestoreV3CandidateRecord({
        candidateFs: payloadCase.candidateFs,
        session: SESSION,
        componentIndex: 0,
        dataIndex: 0,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
    });
  });

  it("snapshots only intrinsic bounded UintArrays without invoking iterators", async () => {
    const { candidateFs } = await fixture();
    const proxied = new Proxy(new Uint8Array([1, 2, 3]), {
      get() {
        throw new Error("proxy trap must not run");
      },
    });
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record(proxied),
        control: operationControl(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      }),
    );

    class PayloadSubclass extends Uint8Array {}
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record(new PayloadSubclass([1, 2, 3])),
        control: operationControl(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      }),
    );

    let iteratorCalls = 0;
    const customIterator = new Uint8Array([1, 2, 3]);
    Object.defineProperty(customIterator, Symbol.iterator, {
      value() {
        iteratorCalls += 1;
        throw new Error("custom iterator must not run");
      },
    });
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record(customIterator),
        control: operationControl(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      }),
    );
    expect(iteratorCalls).toBe(0);

    const boundary = new Uint8Array(
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES,
    );
    boundary.fill(0x5a);
    const boundaryReceipt = await stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: record(boundary),
      control: operationControl(),
    });
    expect(boundaryReceipt.record.payloadBytes).toBe(
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES,
    );
    const boundaryRead = await readAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      componentIndex: 0,
      dataIndex: 0,
      control: operationControl(),
    });
    expect(boundaryRead.payload).toHaveLength(
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES,
    );
    boundaryRead.payload.fill(0);

    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record(new Uint8Array([1])),
        control: {
          signal: new AbortController().signal,
          deadlineEpochMs: Date.now() - 1,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_DEADLINE_EXCEEDED",
      }),
    );

    if (typeof SharedArrayBuffer === "function") {
      expect(() =>
        stageAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session: SESSION,
          record: record(new Uint8Array(new SharedArrayBuffer(32))),
          control: operationControl(),
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
        }),
      );
    }
  });

  it("does not dispatch valid session or receipt fields through poisoned RegExp methods", async () => {
    const { candidateFs } = await fixture();
    const originalReflectApply = Reflect.apply;
    const originalObjectDefineProperty = Object.defineProperty;
    const originalObjectGetOwnPropertyDescriptor =
      Object.getOwnPropertyDescriptor;
    const testDescriptor = originalObjectGetOwnPropertyDescriptor(
      RegExp.prototype,
      "test",
    );
    const execDescriptor = originalObjectGetOwnPropertyDescriptor(
      RegExp.prototype,
      "exec",
    );
    if (!testDescriptor || !execDescriptor) {
      throw new Error("Required RegExp method descriptors are unavailable");
    }
    const dispatched: string[] = [];
    let commandSha256: string | undefined;
    let pendingStage:
      | ReturnType<typeof stageAgentBackupRestoreV3CandidateRecord>
      | undefined;
    let failure: unknown;
    try {
      originalObjectDefineProperty(RegExp.prototype, "test", {
        ...testDescriptor,
        value: function (this: RegExp, value: string) {
          dispatched.push(`test:${value}`);
          return originalReflectApply(
            testDescriptor.value as (input: string) => boolean,
            this,
            [value],
          );
        },
      });
      originalObjectDefineProperty(RegExp.prototype, "exec", {
        ...execDescriptor,
        value: function (this: RegExp, value: string) {
          dispatched.push(`exec:${value}`);
          return originalReflectApply(
            execDescriptor.value as (input: string) => RegExpExecArray | null,
            this,
            [value],
          );
        },
      });
      try {
        commandSha256 = computeAgentBackupRestoreV3CandidateRecordCommandSha256(
          SESSION,
          {
            componentIndex: 0,
            componentName: "character",
            dataIndex: 0,
            offsetBytes: 0,
            entry: {
              path: "records/exact.json",
              fileOffsetBytes: 0,
              fileSizeBytes: 1,
              mode: 0o600,
              mtimeMs: 1,
            },
            payloadBytes: 1,
            payloadSha256: "b".repeat(64),
          },
          "c".repeat(64),
        );
        pendingStage = stageAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session: SESSION,
          record: record(new Uint8Array([1])),
          control: operationControl(),
        });
      } catch (cause) {
        failure = cause;
      }
    } finally {
      originalObjectDefineProperty(RegExp.prototype, "exec", execDescriptor);
      originalObjectDefineProperty(RegExp.prototype, "test", testDescriptor);
    }
    const stagedReceipt = pendingStage ? await pendingStage : undefined;
    expect(failure).toBeUndefined();
    expect(commandSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dispatched).toEqual([]);
    expect(stagedReceipt).toMatchObject({
      record: {
        payloadBytes: 1,
        payloadSha256: createHash("sha256")
          .update(new Uint8Array([1]))
          .digest("hex"),
      },
    });
  });

  it("enforces exact receipt bounds and entry metadata locally", () => {
    const exactReceipt = {
      componentIndex: 0,
      componentName: "character",
      dataIndex: 0,
      offsetBytes: 0,
      entry: null,
      payloadBytes: 1,
      payloadSha256: "b".repeat(64),
    } satisfies AgentBackupRestoreV3StageRecordReceipt;
    const invalidReceipts: unknown[] = [
      { ...exactReceipt, componentIndex: -0 },
      { ...exactReceipt, componentIndex: 1 },
      {
        ...exactReceipt,
        dataIndex: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames,
      },
      {
        ...exactReceipt,
        offsetBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes + 1,
      },
      {
        ...exactReceipt,
        payloadBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes + 1,
      },
      { ...exactReceipt, payloadSha256: "B".repeat(64) },
      {
        ...exactReceipt,
        entry: {
          path: "/absolute",
          fileOffsetBytes: 0,
          fileSizeBytes: 1,
          mode: 0o600,
          mtimeMs: 1,
        },
      },
      {
        ...exactReceipt,
        entry: {
          path: "exact/file",
          fileOffsetBytes: -0,
          fileSizeBytes: 1,
          mode: 0o600,
          mtimeMs: 1,
        },
      },
    ];
    for (const invalidReceipt of invalidReceipts) {
      expect(() =>
        computeAgentBackupRestoreV3CandidateRecordCommandSha256(
          SESSION,
          invalidReceipt as AgentBackupRestoreV3StageRecordReceipt,
          "c".repeat(64),
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
        }),
      );
    }
  });

  it("bypasses poisoned Hash methods for session and command digests", () => {
    const payloadSha256 = createHash("sha256")
      .update("hash-poison-payload")
      .digest("hex");
    const previousReceiptSha256 = "b".repeat(64);
    const originalReflectApply = Reflect.apply;
    const originalReflectDeleteProperty = Reflect.deleteProperty;
    const originalObjectDefineProperty = Object.defineProperty;
    const originalObjectGetOwnPropertyDescriptor =
      Object.getOwnPropertyDescriptor;
    const hashUpdateDescriptor = originalObjectGetOwnPropertyDescriptor(
      Hash.prototype,
      "update",
    );
    const hashDigestDescriptor = originalObjectGetOwnPropertyDescriptor(
      Hash.prototype,
      "digest",
    );
    const hashDestroyOwnDescriptor = originalObjectGetOwnPropertyDescriptor(
      Hash.prototype,
      "destroy",
    );
    const originalHashDestroy = Hash.prototype.destroy;
    if (
      !hashUpdateDescriptor ||
      !hashDigestDescriptor ||
      typeof originalHashDestroy !== "function"
    ) {
      throw new Error("Required Hash method descriptors are unavailable");
    }
    const poisonedCalls: string[] = [];
    let commandSha256: string | undefined;
    try {
      originalObjectDefineProperty(Hash.prototype, "update", {
        ...hashUpdateDescriptor,
        value: function (this: Hash, ...args: unknown[]) {
          poisonedCalls.push("Hash.update");
          return originalReflectApply(
            hashUpdateDescriptor.value as (...values: unknown[]) => unknown,
            this,
            args,
          );
        },
      });
      originalObjectDefineProperty(Hash.prototype, "digest", {
        ...hashDigestDescriptor,
        value: function (this: Hash, ...args: unknown[]) {
          poisonedCalls.push("Hash.digest");
          return originalReflectApply(
            hashDigestDescriptor.value as (...values: unknown[]) => unknown,
            this,
            args,
          );
        },
      });
      originalObjectDefineProperty(Hash.prototype, "destroy", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function (this: Hash, ...args: unknown[]) {
          poisonedCalls.push("Hash.destroy");
          return originalReflectApply(
            originalHashDestroy as (...values: unknown[]) => unknown,
            this,
            args,
          );
        },
      });
      commandSha256 = computeAgentBackupRestoreV3CandidateRecordCommandSha256(
        SESSION,
        {
          componentIndex: 0,
          componentName: "character",
          dataIndex: 0,
          offsetBytes: 0,
          entry: null,
          payloadBytes: 19,
          payloadSha256,
        },
        previousReceiptSha256,
      );
    } finally {
      if (hashDestroyOwnDescriptor) {
        originalObjectDefineProperty(
          Hash.prototype,
          "destroy",
          hashDestroyOwnDescriptor,
        );
      } else {
        originalReflectDeleteProperty(Hash.prototype, "destroy");
      }
      originalObjectDefineProperty(
        Hash.prototype,
        "digest",
        hashDigestDescriptor,
      );
      originalObjectDefineProperty(
        Hash.prototype,
        "update",
        hashUpdateDescriptor,
      );
    }
    expect(commandSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(poisonedCalls).toEqual([]);
  });

  it.skipIf(process.versions.bun !== undefined)(
    "keeps Node builtin snapshots after syncBuiltinESMExports",
    async () => {
      const { candidateFs } = await fixture();
      const nodeRequire = createRequire(import.meta.url);
      const cryptoCjs = nodeRequire("node:crypto") as Record<string, unknown>;
      const utilTypesCjs = nodeRequire("node:util/types") as Record<
        string,
        unknown
      >;
      const utilTypesEsm = await import("node:util/types");
      const originalObjectDefineProperty = Object.defineProperty;
      const originalObjectGetOwnPropertyDescriptor =
        Object.getOwnPropertyDescriptor;
      const bindings = [
        {
          owner: cryptoCjs,
          key: "createHash",
          name: "crypto.createHash",
        },
        {
          owner: cryptoCjs,
          key: "createHmac",
          name: "crypto.createHmac",
        },
        {
          owner: cryptoCjs,
          key: "timingSafeEqual",
          name: "crypto.timingSafeEqual",
        },
        {
          owner: utilTypesCjs,
          key: "isProxy",
          name: "util/types.isProxy",
        },
        {
          owner: utilTypesCjs,
          key: "isUint8Array",
          name: "util/types.isUint8Array",
        },
      ] as const;
      const descriptors = bindings.map(({ owner, key }) =>
        originalObjectGetOwnPropertyDescriptor(owner, key),
      );
      if (descriptors.some((descriptor) => !descriptor)) {
        throw new Error("Required Node builtin descriptors are unavailable");
      }
      const originalCreateHash = createHash;
      const poisonedCalls: string[] = [];
      let synchronized = false;
      let commandSha256: string | undefined;
      let receipt:
        | Awaited<ReturnType<typeof stageAgentBackupRestoreV3CandidateRecord>>
        | undefined;
      let readPayload: Uint8Array | undefined;
      try {
        for (const [index, binding] of bindings.entries()) {
          const descriptor = descriptors[index] as PropertyDescriptor;
          originalObjectDefineProperty(binding.owner, binding.key, {
            ...descriptor,
            value: (..._args: unknown[]) => {
              poisonedCalls.push(binding.name);
              throw new Error(`${binding.name} poisoned after module import`);
            },
          });
        }
        syncBuiltinESMExports();
        synchronized =
          createHash === cryptoCjs.createHash &&
          createHash !== originalCreateHash &&
          utilTypesEsm.isProxy === utilTypesCjs.isProxy &&
          utilTypesEsm.isUint8Array === utilTypesCjs.isUint8Array;

        commandSha256 = computeAgentBackupRestoreV3CandidateRecordCommandSha256(
          SESSION,
          {
            componentIndex: 0,
            componentName: "character",
            dataIndex: 0,
            offsetBytes: 0,
            entry: null,
            payloadBytes: 20,
            payloadSha256: "d".repeat(64),
          },
          "e".repeat(64),
        );

        originalObjectDefineProperty(
          cryptoCjs,
          "createHash",
          descriptors[0] as PropertyDescriptor,
        );
        syncBuiltinESMExports();
        receipt = await stageAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session: SESSION,
          record: record("builtin-binding-proof"),
          control: operationControl(),
        });
        const read = await readAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session: SESSION,
          componentIndex: 0,
          dataIndex: 0,
          control: operationControl(),
        });
        readPayload = read.payload;
      } finally {
        for (const [index, binding] of bindings.entries()) {
          originalObjectDefineProperty(
            binding.owner,
            binding.key,
            descriptors[index] as PropertyDescriptor,
          );
        }
        syncBuiltinESMExports();
      }
      const expectedPayload = new TextEncoder().encode("builtin-binding-proof");
      const readPayloadMatches =
        readPayload !== undefined &&
        readPayload.length === expectedPayload.length &&
        readPayload.every((byte, index) => byte === expectedPayload[index]);
      readPayload?.fill(0);
      expectedPayload.fill(0);
      expect(synchronized).toBe(true);
      expect(commandSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt).toMatchObject({ record: { payloadBytes: 21 } });
      expect(readPayloadMatches).toBe(true);
      expect(poisonedCalls).toEqual([]);
    },
  );

  it("keeps payload, session secrets, digests, and capability backing hidden from poisoned intrinsics", async () => {
    const { candidateFs } = await fixture();
    const payload = new Uint8Array([
      0x91, 0x37, 0xc4, 0x2a, 0x6d, 0xe8, 0x55, 0xb0, 0x19,
    ]);
    const originalReflectApply = Reflect.apply;
    const originalReflectOwnKeys = Reflect.ownKeys;
    const originalReflectDeleteProperty = Reflect.deleteProperty;
    const originalObjectDefineProperty = Object.defineProperty;
    const originalObjectGetOwnPropertyDescriptor =
      Object.getOwnPropertyDescriptor;
    const originalObjectGetPrototypeOf = Object.getPrototypeOf;
    const OriginalUint8Array = Uint8Array;
    const typedArrayPrototype = originalObjectGetPrototypeOf(
      Uint8Array.prototype,
    );
    const typedArrayByteLengthDescriptor =
      originalObjectGetOwnPropertyDescriptor(typedArrayPrototype, "byteLength");
    const typedArrayBufferDescriptor = originalObjectGetOwnPropertyDescriptor(
      typedArrayPrototype,
      "buffer",
    );
    const typedArrayByteOffsetDescriptor =
      originalObjectGetOwnPropertyDescriptor(typedArrayPrototype, "byteOffset");
    const arrayBufferByteLengthDescriptor =
      originalObjectGetOwnPropertyDescriptor(
        ArrayBuffer.prototype,
        "byteLength",
      );
    const hmacUpdateDescriptor = originalObjectGetOwnPropertyDescriptor(
      Hmac.prototype,
      "update",
    );
    const hmacDigestDescriptor = originalObjectGetOwnPropertyDescriptor(
      Hmac.prototype,
      "digest",
    );
    const hmacDestroyOwnDescriptor = originalObjectGetOwnPropertyDescriptor(
      Hmac.prototype,
      "destroy",
    );
    const originalHmacDestroy = Hmac.prototype.destroy;
    const descriptors = {
      reflectApply: originalObjectGetOwnPropertyDescriptor(Reflect, "apply"),
      objectFreeze: originalObjectGetOwnPropertyDescriptor(Object, "freeze"),
      objectValues: originalObjectGetOwnPropertyDescriptor(Object, "values"),
      objectGetPrototypeOf: originalObjectGetOwnPropertyDescriptor(
        Object,
        "getPrototypeOf",
      ),
      objectGetOwnPropertyDescriptor: originalObjectGetOwnPropertyDescriptor(
        Object,
        "getOwnPropertyDescriptor",
      ),
      functionCall: originalObjectGetOwnPropertyDescriptor(
        Function.prototype,
        "call",
      ),
      textEncoderEncode: originalObjectGetOwnPropertyDescriptor(
        TextEncoder.prototype,
        "encode",
      ),
      textDecoderDecode: originalObjectGetOwnPropertyDescriptor(
        TextDecoder.prototype,
        "decode",
      ),
    };
    if (
      Object.values(descriptors).some((descriptor) => !descriptor) ||
      !typedArrayByteLengthDescriptor?.get ||
      !typedArrayBufferDescriptor?.get ||
      !typedArrayByteOffsetDescriptor?.get ||
      !arrayBufferByteLengthDescriptor?.get ||
      !hmacUpdateDescriptor ||
      !hmacDigestDescriptor ||
      typeof originalHmacDestroy !== "function"
    ) {
      throw new Error("Required hostile-test intrinsics are unavailable");
    }
    const originalFunctionCall = descriptors.functionCall?.value as (
      ...args: unknown[]
    ) => unknown;
    const observedStrings: Array<{ source: string; value: string }> = [];
    const observedBytes: Array<{ source: string; value: string }> = [];
    const poisonedCryptoCalls: string[] = [];
    const HEX = "0123456789abcdef";

    const bytesToHex = (value: Uint8Array): string => {
      const length = originalReflectApply(
        typedArrayByteLengthDescriptor.get as () => number,
        value,
        [],
      ) as number;
      let result = "";
      for (let index = 0; index < length; index += 1) {
        const byte = value[index] ?? 0;
        result += `${HEX[(byte >>> 4) & 15]}${HEX[byte & 15]}`;
      }
      return result;
    };
    const snapshotTypedBytes = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      try {
        originalReflectApply(
          typedArrayByteLengthDescriptor.get as () => number,
          value,
          [],
        );
        return bytesToHex(value as Uint8Array);
      } catch {
        return undefined;
      }
    };
    const snapshotArrayBufferBytes = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      try {
        originalReflectApply(
          arrayBufferByteLengthDescriptor.get as () => number,
          value,
          [],
        );
        return bytesToHex(new OriginalUint8Array(value as ArrayBuffer));
      } catch {
        return undefined;
      }
    };
    const observeDirect = (source: string, value: unknown): void => {
      if (typeof value === "string") {
        observedStrings.push({ source, value });
        return;
      }
      const bytes = snapshotTypedBytes(value);
      if (bytes !== undefined) observedBytes.push({ source, value: bytes });
    };
    const observeOwnData = (source: string, value: unknown): void => {
      observeDirect(source, value);
      if (!value || (typeof value !== "object" && typeof value !== "function"))
        return;
      let keys: PropertyKey[];
      try {
        keys = originalReflectOwnKeys(value);
      } catch {
        return;
      }
      for (const key of keys) {
        const descriptor = originalObjectGetOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) continue;
        observeDirect(
          `${source}.${typeof key === "string" ? key : "symbol"}`,
          descriptor.value,
        );
      }
    };
    const observeArguments = (
      source: string,
      argumentsList: ArrayLike<unknown>,
    ): void => {
      for (let index = 0; index < argumentsList.length; index += 1) {
        observeOwnData(`${source}[${index}]`, argumentsList[index]);
      }
    };

    const poisonedReflectApply = (
      target: (...args: unknown[]) => unknown,
      thisArgument: unknown,
      argumentsList: ArrayLike<unknown>,
    ): unknown => {
      observeOwnData("Reflect.apply:this", thisArgument);
      observeArguments("Reflect.apply:argument", argumentsList);
      return originalReflectApply(target, thisArgument, argumentsList);
    };
    const poisonedObjectFreeze = <T>(value: T): Readonly<T> => {
      observeOwnData("Object.freeze", value);
      return originalReflectApply(
        descriptors.objectFreeze?.value as typeof Object.freeze,
        Object,
        [value],
      ) as Readonly<T>;
    };
    const poisonedObjectValues = (value: object): unknown[] => {
      observeOwnData("Object.values", value);
      const result = originalReflectApply(
        descriptors.objectValues?.value as typeof Object.values,
        Object,
        [value],
      ) as unknown[];
      observeArguments("Object.values:return", result);
      return result;
    };
    const poisonedObjectGetPrototypeOf = (value: unknown): object | null => {
      observeOwnData("Object.getPrototypeOf", value);
      return originalObjectGetPrototypeOf(value);
    };
    const poisonedObjectGetOwnPropertyDescriptor = (
      value: object,
      key: PropertyKey,
    ): PropertyDescriptor | undefined => {
      observeOwnData("Object.getOwnPropertyDescriptor", value);
      return originalObjectGetOwnPropertyDescriptor(value, key);
    };
    const poisonedFunctionCall = function (
      this: (...args: unknown[]) => unknown,
      thisArgument: unknown,
      ...argumentsList: unknown[]
    ): unknown {
      observeOwnData("Function.prototype.call:this", thisArgument);
      observeArguments("Function.prototype.call:argument", argumentsList);
      return originalReflectApply(originalFunctionCall, this, [
        thisArgument,
        ...argumentsList,
      ]);
    };
    const poisonedTextEncoderEncode = function (
      this: TextEncoder,
      value = "",
    ): Uint8Array {
      observeDirect("TextEncoder.encode", value);
      const result = originalReflectApply(
        descriptors.textEncoderEncode?.value as TextEncoder["encode"],
        this,
        [value],
      );
      observeDirect("TextEncoder.encode:return", result);
      return result;
    };
    const poisonedTextDecoderDecode = function (
      this: TextDecoder,
      ...args: unknown[]
    ): string {
      observeArguments("TextDecoder.decode", args);
      return originalReflectApply(
        descriptors.textDecoderDecode?.value as (
          ...values: unknown[]
        ) => string,
        this,
        args,
      );
    };
    const poisonedHmacUpdate = function (this: Hmac, ...args: unknown[]): Hmac {
      poisonedCryptoCalls.push("Hmac.update");
      observeArguments("Hmac.update", args);
      return originalReflectApply(
        hmacUpdateDescriptor.value as (...values: unknown[]) => Hmac,
        this,
        args,
      );
    };
    const poisonedHmacDigest = function (
      this: Hmac,
      ...args: unknown[]
    ): unknown {
      poisonedCryptoCalls.push("Hmac.digest");
      const result = originalReflectApply(
        hmacDigestDescriptor.value as (...values: unknown[]) => unknown,
        this,
        args,
      );
      observeDirect("Hmac.digest:return", result);
      return result;
    };
    const poisonedHmacDestroy = function (
      this: Hmac,
      ...args: unknown[]
    ): unknown {
      poisonedCryptoCalls.push("Hmac.destroy");
      return originalReflectApply(
        originalHmacDestroy as (...values: unknown[]) => unknown,
        this,
        args,
      );
    };

    let receipt: Awaited<
      ReturnType<typeof stageAgentBackupRestoreV3CandidateRecord>
    > | null = null;
    let failure: unknown;
    try {
      originalObjectDefineProperty(Reflect, "apply", {
        ...descriptors.reflectApply,
        value: poisonedReflectApply,
      });
      originalObjectDefineProperty(Object, "freeze", {
        ...descriptors.objectFreeze,
        value: poisonedObjectFreeze,
      });
      originalObjectDefineProperty(Object, "values", {
        ...descriptors.objectValues,
        value: poisonedObjectValues,
      });
      originalObjectDefineProperty(Object, "getPrototypeOf", {
        ...descriptors.objectGetPrototypeOf,
        value: poisonedObjectGetPrototypeOf,
      });
      originalObjectDefineProperty(Object, "getOwnPropertyDescriptor", {
        ...descriptors.objectGetOwnPropertyDescriptor,
        value: poisonedObjectGetOwnPropertyDescriptor,
      });
      originalObjectDefineProperty(Function.prototype, "call", {
        ...descriptors.functionCall,
        value: poisonedFunctionCall,
      });
      originalObjectDefineProperty(TextEncoder.prototype, "encode", {
        ...descriptors.textEncoderEncode,
        value: poisonedTextEncoderEncode,
      });
      originalObjectDefineProperty(TextDecoder.prototype, "decode", {
        ...descriptors.textDecoderDecode,
        value: poisonedTextDecoderDecode,
      });
      originalObjectDefineProperty(typedArrayPrototype, "byteLength", {
        ...typedArrayByteLengthDescriptor,
        get(this: unknown) {
          observeDirect("TypedArray.byteLength", this);
          return originalReflectApply(
            typedArrayByteLengthDescriptor.get as () => number,
            this,
            [],
          );
        },
      });
      originalObjectDefineProperty(typedArrayPrototype, "buffer", {
        ...typedArrayBufferDescriptor,
        get(this: unknown) {
          observeDirect("TypedArray.buffer", this);
          return originalReflectApply(
            typedArrayBufferDescriptor.get as () => ArrayBuffer,
            this,
            [],
          );
        },
      });
      originalObjectDefineProperty(typedArrayPrototype, "byteOffset", {
        ...typedArrayByteOffsetDescriptor,
        get(this: unknown) {
          observeDirect("TypedArray.byteOffset", this);
          return originalReflectApply(
            typedArrayByteOffsetDescriptor.get as () => number,
            this,
            [],
          );
        },
      });
      originalObjectDefineProperty(ArrayBuffer.prototype, "byteLength", {
        ...arrayBufferByteLengthDescriptor,
        get(this: unknown) {
          const bytes = snapshotArrayBufferBytes(this);
          if (bytes !== undefined) {
            observedBytes.push({
              source: "ArrayBuffer.byteLength",
              value: bytes,
            });
          }
          return originalReflectApply(
            arrayBufferByteLengthDescriptor.get as () => number,
            this,
            [],
          );
        },
      });
      originalObjectDefineProperty(Hmac.prototype, "update", {
        ...hmacUpdateDescriptor,
        value: poisonedHmacUpdate,
      });
      originalObjectDefineProperty(Hmac.prototype, "digest", {
        ...hmacDigestDescriptor,
        value: poisonedHmacDigest,
      });
      originalObjectDefineProperty(Hmac.prototype, "destroy", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: poisonedHmacDestroy,
      });
      receipt = await stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record(payload),
        control: operationControl(),
      });
    } catch (cause) {
      failure = cause;
    } finally {
      if (hmacDestroyOwnDescriptor) {
        originalObjectDefineProperty(
          Hmac.prototype,
          "destroy",
          hmacDestroyOwnDescriptor,
        );
      } else {
        originalReflectDeleteProperty(Hmac.prototype, "destroy");
      }
      originalObjectDefineProperty(
        Hmac.prototype,
        "digest",
        hmacDigestDescriptor,
      );
      originalObjectDefineProperty(
        Hmac.prototype,
        "update",
        hmacUpdateDescriptor,
      );
      originalObjectDefineProperty(
        ArrayBuffer.prototype,
        "byteLength",
        arrayBufferByteLengthDescriptor,
      );
      originalObjectDefineProperty(
        typedArrayPrototype,
        "byteOffset",
        typedArrayByteOffsetDescriptor,
      );
      originalObjectDefineProperty(
        typedArrayPrototype,
        "buffer",
        typedArrayBufferDescriptor,
      );
      originalObjectDefineProperty(
        typedArrayPrototype,
        "byteLength",
        typedArrayByteLengthDescriptor,
      );
      originalObjectDefineProperty(
        TextDecoder.prototype,
        "decode",
        descriptors.textDecoderDecode as PropertyDescriptor,
      );
      originalObjectDefineProperty(
        TextEncoder.prototype,
        "encode",
        descriptors.textEncoderEncode as PropertyDescriptor,
      );
      originalObjectDefineProperty(
        Function.prototype,
        "call",
        descriptors.functionCall as PropertyDescriptor,
      );
      originalObjectDefineProperty(
        Object,
        "getOwnPropertyDescriptor",
        descriptors.objectGetOwnPropertyDescriptor as PropertyDescriptor,
      );
      originalObjectDefineProperty(
        Object,
        "getPrototypeOf",
        descriptors.objectGetPrototypeOf as PropertyDescriptor,
      );
      originalObjectDefineProperty(
        Object,
        "values",
        descriptors.objectValues as PropertyDescriptor,
      );
      originalObjectDefineProperty(
        Object,
        "freeze",
        descriptors.objectFreeze as PropertyDescriptor,
      );
      originalObjectDefineProperty(
        Reflect,
        "apply",
        descriptors.reflectApply as PropertyDescriptor,
      );
    }

    expect(failure).toBeUndefined();
    expect(receipt).toMatchObject({
      record: { payloadBytes: payload.length },
    });
    if (!receipt) throw new Error("Candidate record receipt was not returned");
    const capability = createHmac(
      "sha256",
      Buffer.from(SESSION.executionToken, "utf8"),
    )
      .update(AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_OWNER_CONTEXT, "utf8")
      .update(Buffer.of(0))
      .update(Buffer.from(receipt.commandSha256, "hex"))
      .digest();
    const digestStrings = [
      SESSION.expectedManifestSha256,
      receipt.sessionSha256,
      receipt.commandSha256,
      receipt.ownerTokenSha256,
      receipt.previousReceiptSha256,
      receipt.record.payloadSha256,
      receipt.payload.sha256,
      receipt.receiptSha256,
    ];
    const sensitiveStrings = [
      SESSION.stagingHandle,
      SESSION.cleanupHandle,
      SESSION.executionToken,
      ...digestStrings,
    ];
    const sensitiveBytes = [
      { name: "payload", value: Buffer.from(payload).toString("hex") },
      {
        name: "stagingHandle",
        value: Buffer.from(SESSION.stagingHandle, "utf8").toString("hex"),
      },
      {
        name: "cleanupHandle",
        value: Buffer.from(SESSION.cleanupHandle, "utf8").toString("hex"),
      },
      {
        name: "executionToken",
        value: Buffer.from(SESSION.executionToken, "utf8").toString("hex"),
      },
      { name: "ownerCapability", value: capability.toString("hex") },
      ...digestStrings.flatMap((digest, index) => [
        {
          name: `digest-${index}-decoded`,
          value: Buffer.from(digest, "hex").toString("hex"),
        },
        {
          name: `digest-${index}-utf8`,
          value: Buffer.from(digest, "utf8").toString("hex"),
        },
      ]),
    ];
    const leaks = [
      ...observedStrings.flatMap((observation) =>
        sensitiveStrings
          .filter((secret) => observation.value.includes(secret))
          .map((secret) => `${observation.source}:string:${secret}`),
      ),
      ...observedBytes.flatMap((observation) =>
        sensitiveBytes
          .filter(
            (secret) =>
              secret.value.length > 0 &&
              observation.value.includes(secret.value),
          )
          .map((secret) => `${observation.source}:bytes:${secret.name}`),
      ),
    ];
    capability.fill(0);
    expect(poisonedCryptoCalls).toEqual([]);
    expect(leaks).toEqual([]);
  });

  it("rejects public-boundary proxies and accessors without invoking them", async () => {
    const { candidateFs } = await fixture();
    let trapCalls = 0;
    const failTrap = () => {
      trapCalls += 1;
      throw new Error("untrusted trap must not run");
    };
    const proxiedSession = new Proxy(
      { ...SESSION },
      {
        get: failTrap,
        getPrototypeOf: failTrap,
        ownKeys: failTrap,
      },
    );
    const proxiedStageInput = new Proxy(
      {
        candidateFs,
        session: SESSION,
        record: record("proxy-stage-input"),
        control: operationControl(),
      },
      {
        get: failTrap,
        getPrototypeOf: failTrap,
        ownKeys: failTrap,
      },
    );
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord(proxiedStageInput),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );

    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: proxiedSession,
        record: record("proxy-session"),
        control: operationControl(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );

    const proxiedCandidateFs = new Proxy(candidateFs, {
      get: failTrap,
      getPrototypeOf: failTrap,
    });
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: proxiedCandidateFs,
        session: SESSION,
        record: record("proxy-candidate-fs"),
        control: operationControl(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );

    const forgedCandidateFs = {
      acquireLock: failTrap,
      createPayload: failTrap,
      publishDurableJson: failTrap,
      readDurableJson: failTrap,
      readPayload: failTrap,
      assertAuthority: failTrap,
      assertLockHeld: failTrap,
    };
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: forgedCandidateFs,
        session: SESSION,
        record: record("forged-candidate-fs"),
        control: operationControl(),
      } as never),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );

    await expect(
      bindAgentBackupRestoreV3CandidateRecordSession({
        candidateFs,
        session: SESSION,
        control: operationControl(),
        heldLock: null,
      } as never),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
    });

    const proxiedHeldLock = new Proxy(
      {},
      {
        get: failTrap,
        getPrototypeOf: failTrap,
        ownKeys: failTrap,
      },
    );
    await expect(
      readAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        componentIndex: 0,
        dataIndex: 0,
        control: operationControl(),
        heldLock: proxiedHeldLock,
      } as never),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
    });

    const forgedBrandedPrototype = Object.create(
      AgentBackupRestoreV3CandidateFs.prototype,
    ) as Record<string, unknown>;
    Object.defineProperty(forgedBrandedPrototype, "acquireLock", {
      value: failTrap,
    });
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs: forgedBrandedPrototype,
        session: SESSION,
        record: record("forged-candidate-fs-prototype"),
        control: operationControl(),
      } as never),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );
    expect(Object.isFrozen(candidateFs)).toBe(true);
    expect(Object.isFrozen(AgentBackupRestoreV3CandidateFs.prototype)).toBe(
      true,
    );

    const revokedControl = Proxy.revocable(operationControl(), {});
    revokedControl.revoke();
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record("proxy-control"),
        control: revokedControl.proxy,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_CONTROL_INVALID",
      }),
    );

    const lifecycle = {} as Record<string, unknown>;
    Object.defineProperty(lifecycle, "afterPayloadFinalized", {
      enumerable: true,
      get: failTrap,
    });
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record("accessor-lifecycle"),
        control: operationControl(),
        testOnlyLifecycle: lifecycle,
      } as never),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );

    const receipt = {
      componentIndex: 0,
      componentName: "character",
      dataIndex: 0,
      offsetBytes: 0,
      entry: null,
      payloadBytes: 1,
    } as Record<string, unknown>;
    Object.defineProperty(receipt, "payloadSha256", {
      enumerable: true,
      get: failTrap,
    });
    expect(() =>
      computeAgentBackupRestoreV3CandidateRecordCommandSha256(
        SESSION,
        receipt as never,
        "0".repeat(64),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );
    expect(trapCalls).toBe(0);
  });

  it("snapshots read slots and operation control before the first await", async () => {
    const { candidateFs } = await fixture();
    const stageControl = operationControl();
    const pendingStage = stageAgentBackupRestoreV3CandidateRecord({
      candidateFs,
      session: SESSION,
      record: record("stable-after-call"),
      control: stageControl,
    });
    stageControl.deadlineEpochMs = Date.now() - 1;
    await expect(pendingStage).resolves.toMatchObject({
      record: { componentIndex: 0, dataIndex: 0 },
    });

    const readControl = operationControl();
    const readInput = {
      candidateFs,
      session: SESSION,
      componentIndex: 0,
      dataIndex: 0,
      control: readControl,
    };
    const pendingRead = readAgentBackupRestoreV3CandidateRecord(readInput);
    readInput.componentIndex = 1;
    readInput.dataIndex = 9;
    readControl.deadlineEpochMs = Date.now() - 1;
    const exactRead = await pendingRead;
    expect(exactRead.receipt.record).toMatchObject({
      componentIndex: 0,
      dataIndex: 0,
    });
    expect(Buffer.from(exactRead.payload).toString("utf8")).toBe(
      "stable-after-call",
    );
    exactRead.payload.fill(0);
  });

  it("refuses test hooks in production before creating durable state", async () => {
    const { candidateFs, attemptRoot } = await fixture();
    const before = await exactFilesystemSnapshot(attemptRoot);
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        stageAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session: SESSION,
          record: record("forbidden-production-hook"),
          control: operationControl(),
          testOnlyLifecycle: { afterPayloadFinalized: () => undefined },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_TEST_HOOK_FORBIDDEN",
        }),
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
    await expect(exactFilesystemSnapshot(attemptRoot)).resolves.toEqual(before);
  });

  it("rejects oversized, accessor-backed, and mismatched component inputs", async () => {
    const { candidateFs } = await fixture();
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: record(
          new Uint8Array(
            AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_MAXIMUM_BYTES + 1,
          ),
        ),
        control: operationControl(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_PAYLOAD_INVALID",
      }),
    );

    const hidden = record("hidden") as unknown as Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: hidden as unknown as AgentBackupRestoreV3StagedRecord,
        control: operationControl(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );

    const accessor = record("accessor") as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "payload", {
      enumerable: true,
      get: () => Buffer.from("accessor"),
    });
    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: accessor as unknown as AgentBackupRestoreV3StagedRecord,
        control: operationControl(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );

    expect(() =>
      stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session: SESSION,
        record: {
          ...record("wrong-name"),
          componentIndex: 1,
          componentName: "character",
        },
        control: operationControl(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_INPUT_INVALID",
      }),
    );
  });
});
