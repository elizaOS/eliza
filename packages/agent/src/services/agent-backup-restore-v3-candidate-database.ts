/**
 * Extracts the exact authenticated database record inbox into quarantine.
 * Its durable receipt proves archive extraction only, not a validated/opened
 * PGlite lifecycle, generation commit, restart, or permission to publish routes.
 * All mutation uses the merged candidate-FS capability under its existing lock.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupRestoreV3ComponentReceipt,
  AgentBackupRestoreV3ComponentReceiptSchema,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFs,
  type AgentBackupRestoreV3CandidateFsLock,
  type AgentBackupRestoreV3CandidateTreeProof,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import {
  assertActive,
  internalCleanupControl,
  snapshotOperationControl,
  snapshotOwnDataRecord,
} from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import {
  AgentBackupRestoreV3CandidateRecordError,
  bindAgentBackupRestoreV3CandidateRecordSession,
  readAgentBackupRestoreV3CandidateRecord,
  snapshotAgentBackupRestoreV3CandidateSession,
} from "./agent-backup-restore-v3-candidate-records";
import {
  AgentBackupRestoreV3PgliteArchiveError,
  readAgentBackupRestoreV3PgliteArchive,
} from "./agent-backup-restore-v3-pglite-archive";

const OUTPUT_DIRECTORY = "components/database";
const FINISH_MARKER = ".restore-v3-component-c1.database-extracted.json";
const MAXIMUM_COMPRESSED_BYTES = 1024 * 1024 * 1024;
const FINISH_MAXIMUM_BYTES = 32 * 1024;
export const AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_DIRECTORY =
  ".restore-v3-database-validation";
export const AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_COPY_MARKER =
  ".restore-v3-component-c1.validation-copy-extracted.json";
type DatabaseDirectory =
  | typeof OUTPUT_DIRECTORY
  | typeof AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_DIRECTORY;

export interface AgentBackupRestoreV3CandidateDatabaseExtractionReceipt<
  Directory extends DatabaseDirectory = typeof OUTPUT_DIRECTORY,
> {
  readonly version: 1;
  readonly format: "elizaos.agent-backup.restore-v3-database-extracted.v1";
  readonly sessionSha256: string;
  readonly component: Readonly<AgentBackupRestoreV3ComponentReceipt>;
  readonly outputDirectory: Directory;
  readonly lastRecordReceiptSha256: string;
  readonly tree: Readonly<AgentBackupRestoreV3CandidateTreeProof>;
  readonly finishSha256: string;
}

function invalid(code: string, message: string, cause?: unknown): never {
  throw new AgentBackupRestoreV3PgliteArchiveError(code, message, cause);
}

function receiptSnapshot(
  value: Readonly<AgentBackupRestoreV3ComponentReceipt>,
): Readonly<AgentBackupRestoreV3ComponentReceipt> {
  const record = snapshotOwnDataRecord(
    value,
    [
      "componentIndex",
      "componentName",
      "descriptor",
      "dataFrameCount",
      "payloadBytes",
      "payloadSha256",
      "recordStreamContentHmacSha256",
    ],
    [
      "componentIndex",
      "componentName",
      "descriptor",
      "dataFrameCount",
      "payloadBytes",
      "payloadSha256",
      "recordStreamContentHmacSha256",
    ],
    "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_COMPONENT_INVALID",
    "Database receipt requires one exact plain data object",
  );
  const expected = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[1];
  if (!expected)
    invalid("COMPONENT_INVALID", "Database component policy is unavailable");
  const descriptor = snapshotOwnDataRecord(
    record.descriptor,
    Object.keys(expected),
    Object.keys(expected),
    "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_COMPONENT_INVALID",
    "Database descriptor requires one exact plain data object",
  );
  const parsed = AgentBackupRestoreV3ComponentReceiptSchema.parse({
    ...record,
    descriptor,
  });
  if (
    parsed.componentIndex !== 1 ||
    parsed.componentName !== "database" ||
    candidateFsCanonicalJson(parsed.descriptor) !==
      candidateFsCanonicalJson(expected)
  )
    invalid(
      "COMPONENT_INVALID",
      "Extraction requires the exact database component",
    );
  if (
    parsed.dataFrameCount === 0 ||
    parsed.dataFrameCount > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames ||
    parsed.payloadBytes === 0 ||
    parsed.payloadBytes > MAXIMUM_COMPRESSED_BYTES
  )
    invalid(
      "COMPONENT_LIMIT",
      "Database component is empty or exceeds its bounded capture policy",
    );
  return Object.freeze({
    ...parsed,
    descriptor: Object.freeze({ ...parsed.descriptor }),
  });
}

export interface AgentBackupRestoreV3CandidateDatabaseInput {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly session: Readonly<AgentBackupRestoreV3StagingSession>;
  readonly receipt: Readonly<AgentBackupRestoreV3ComponentReceipt>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
}

export function extractAgentBackupRestoreV3CandidateDatabase(
  input: Readonly<AgentBackupRestoreV3CandidateDatabaseInput>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateDatabaseExtractionReceipt>> {
  return extractDatabaseAt(input, OUTPUT_DIRECTORY, FINISH_MARKER, heldLock);
}

/** Only the validator consumes this disposable copy, while holding the root lock. */
export function extractAgentBackupRestoreV3CandidateDatabaseValidationCopy(
  input: Readonly<AgentBackupRestoreV3CandidateDatabaseInput>,
  heldLock: AgentBackupRestoreV3CandidateFsLock,
): Promise<
  Readonly<
    AgentBackupRestoreV3CandidateDatabaseExtractionReceipt<
      typeof AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_DIRECTORY
    >
  >
> {
  return extractDatabaseAt(
    input,
    AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_DIRECTORY,
    AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_COPY_MARKER,
    heldLock,
  );
}

async function extractDatabaseAt<Directory extends DatabaseDirectory>(
  input: Readonly<AgentBackupRestoreV3CandidateDatabaseInput>,
  outputDirectory: Directory,
  finishMarker: string,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<
  Readonly<AgentBackupRestoreV3CandidateDatabaseExtractionReceipt<Directory>>
> {
  const exact = snapshotOwnDataRecord(
    input,
    ["candidateFs", "session", "receipt", "control"],
    ["candidateFs", "session", "receipt", "control"],
    "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_INPUT_INVALID",
    "Database extraction requires one plain input object",
  );
  if (!isAgentBackupRestoreV3CandidateFs(exact.candidateFs))
    invalid(
      "INPUT_INVALID",
      "Database extraction requires the real candidate filesystem capability",
    );
  const candidateFs = exact.candidateFs as AgentBackupRestoreV3CandidateFs;
  const session = snapshotAgentBackupRestoreV3CandidateSession(
    exact.session as AgentBackupRestoreV3StagingSession,
  );
  const component = receiptSnapshot(
    exact.receipt as AgentBackupRestoreV3ComponentReceipt,
  );
  const control = snapshotOperationControl(
    exact.control as AgentBackupRestoreV3OperationControl,
  );
  const lock =
    heldLock ??
    (await candidateFs.acquireLock(".restore-v3-materialize-c1.lock", control));
  let primaryFailure: unknown;
  let result:
    | Readonly<
        AgentBackupRestoreV3CandidateDatabaseExtractionReceipt<Directory>
      >
    | undefined;
  try {
    const sessionSha256 = await bindAgentBackupRestoreV3CandidateRecordSession({
      candidateFs,
      session,
      control,
      heldLock: lock,
    });
    const gunzip = createGunzip({ chunkSize: 64 * 1024 });
    let decoderFailure: Error | undefined;
    // The reader may not be attached yet when a source/abort failure arrives.
    // Record it now; parsing or the explicit check below reports the failure.
    gunzip.on("error", (error) => {
      decoderFailure = error;
    });
    const interrupt = () => {
      gunzip.destroy(
        new AgentBackupRestoreV3PgliteArchiveError(
          "INTERRUPTED",
          "Database archive extraction was cancelled or exceeded its deadline",
        ),
      );
    };
    control.signal.addEventListener("abort", interrupt, { once: true });
    const deadline = setTimeout(
      interrupt,
      Math.min(
        2_147_483_647,
        Math.max(1, control.deadlineEpochMs - Date.now()),
      ),
    );
    let lastRecordReceiptSha256: string | null = null;
    const feed = async () => {
      const hash = createHash("sha256");
      let bytes = 0;
      for (
        let dataIndex = 0;
        dataIndex < component.dataFrameCount;
        dataIndex++
      ) {
        const inbox = await readAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session,
          componentIndex: 1,
          dataIndex,
          control,
          heldLock: lock,
        });
        try {
          const record = inbox.receipt.record;
          if (
            record.componentIndex !== 1 ||
            record.componentName !== "database" ||
            record.dataIndex !== dataIndex ||
            record.offsetBytes !== bytes ||
            record.entry !== null ||
            record.payloadBytes !== inbox.payload.byteLength ||
            (lastRecordReceiptSha256 !== null &&
              inbox.receipt.previousReceiptSha256 !== lastRecordReceiptSha256)
          )
            invalid(
              "RECORD_INVALID",
              "Database records must be an exact contiguous opaque chain",
            );
          if (bytes > component.payloadBytes - inbox.payload.byteLength)
            invalid(
              "COMPONENT_LIMIT",
              "Database record exceeds the authenticated payload size",
            );
          bytes += inbox.payload.byteLength;
          hash.update(inbox.payload);
          // The zlib callback, not Readable.from() read-ahead, owns this buffer's
          // lifetime. Do not clear plaintext while the decoder still uses it.
          await new Promise<void>((resolve, reject) => {
            gunzip.write(inbox.payload, (error) =>
              error ? reject(error) : resolve(),
            );
          });
          assertActive(control);
          lastRecordReceiptSha256 = inbox.receipt.receiptSha256;
        } finally {
          inbox.payload.fill(0);
        }
      }
      if (
        bytes !== component.payloadBytes ||
        hash.digest("hex") !== component.payloadSha256
      )
        invalid(
          "PAYLOAD_MISMATCH",
          "Database payload differs from its authenticated finish",
        );
      try {
        const unexpected = await readAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session,
          componentIndex: 1,
          dataIndex: component.dataFrameCount,
          control,
          heldLock: lock,
        });
        unexpected.payload.fill(0);
        invalid(
          "RECORD_COUNT_MISMATCH",
          "Database inbox has records beyond its authenticated finish",
        );
      } catch (cause) {
        // error-policy:J3 Only absence at the exact terminal slot is acceptable.
        if (
          !(
            cause instanceof AgentBackupRestoreV3CandidateRecordError &&
            cause.code === "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_ABSENT"
          )
        )
          throw cause;
      }
      gunzip.end();
    };
    const supply = feed().catch((cause) => {
      // error-policy:J2 Wake the reader; the same source failure is joined below.
      const error =
        cause instanceof Error
          ? cause
          : new AgentBackupRestoreV3PgliteArchiveError(
              "SOURCE_FAILED",
              "Database record source failed",
              cause,
            );
      gunzip.destroy(error);
      throw error;
    });
    // error-policy:J5 The supply rejection is observed by the join in finally.
    void supply.catch(() => undefined);
    async function* decodedTar() {
      for await (const chunk of gunzip) {
        if (!Buffer.isBuffer(chunk))
          invalid("CHUNK_INVALID", "Database decoder emitted a non-byte chunk");
        try {
          yield chunk;
        } finally {
          chunk.fill(0);
        }
      }
    }
    let extractionFailure: unknown;
    try {
      await candidateFs.ensureFileTreeDirectory(outputDirectory, control, lock);
      const extracted = await readAgentBackupRestoreV3PgliteArchive({
        tar: decodedTar(),
        control,
        // Absolute and ratio ceilings both apply; small real physical dumps
        // need the fixed allowance for PostgreSQL's compressible empty pages.
        limits: {
          maximumTarBytes: Math.min(
            8 * 1024 ** 3,
            Math.max(64 * 1024 ** 2, component.payloadBytes * 128),
          ),
        },
        visit: async (entry, consume) => {
          if (entry.type === "directory") {
            await candidateFs.ensureFileTreeDirectory(
              `${outputDirectory}/${entry.path}`,
              control,
              lock,
            );
            await consume(async () => {});
            return;
          }
          const writer = await candidateFs.createFileTreeFile(
            outputDirectory,
            {
              path: entry.path,
              sizeBytes: entry.sizeBytes,
              mode: 0o600,
              mtimeMs: 0,
            },
            undefined,
            control,
            lock,
          );
          const hash = createHash("sha256");
          try {
            await consume(async (chunk) => {
              hash.update(chunk);
              if (!writer.replayed) await writer.write(chunk, control);
            });
            const proof = await writer.finalize(control);
            if (proof.sha256 !== hash.digest("hex"))
              invalid(
                "FILE_CONFLICT",
                "Extracted database file differs from the authenticated archive",
              );
          } finally {
            await writer.close();
          }
        },
      });
      await supply;
      if (decoderFailure) throw decoderFailure;
      if (lastRecordReceiptSha256 === null)
        invalid(
          "RECORD_INVALID",
          "Database extraction has no terminal record receipt",
        );
      const tree = await candidateFs.proveTree(
        outputDirectory,
        undefined,
        control,
        lock,
      );
      if (
        tree.bytes !== extracted.extractedBytes ||
        tree.files !== extracted.files ||
        tree.directories !== extracted.directories
      )
        invalid(
          "TREE_CONFLICT",
          "Database extraction contains entries outside its exact archive",
        );
      const body = {
        version: 1 as const,
        format:
          "elizaos.agent-backup.restore-v3-database-extracted.v1" as const,
        sessionSha256,
        component,
        outputDirectory,
        lastRecordReceiptSha256,
        tree,
      };
      const finish = Object.freeze({
        ...body,
        finishSha256: createHash("sha256")
          .update(candidateFsCanonicalJson(body))
          .digest("hex"),
      });
      await candidateFs.publishDurableJson(
        finishMarker,
        finish,
        { maximumBytes: FINISH_MAXIMUM_BYTES },
        control,
        lock,
      );
      const persisted = await candidateFs.readDurableJson(
        finishMarker,
        { maximumBytes: FINISH_MAXIMUM_BYTES },
        control,
        lock,
      );
      if (
        candidateFsCanonicalJson(persisted) !== candidateFsCanonicalJson(finish)
      )
        invalid(
          "FINISH_CONFLICT",
          "Database extraction receipt changed after publication",
        );
      result = finish;
    } catch (cause) {
      // error-policy:J2 Retain the primary parser/filesystem error through join.
      extractionFailure = cause;
    } finally {
      clearTimeout(deadline);
      control.signal.removeEventListener("abort", interrupt);
      gunzip.destroy();
    }
    // Do not release the candidate lock while a record read can still settle.
    const settled = await Promise.allSettled([supply]);
    if (extractionFailure !== undefined) throw extractionFailure;
    if (settled[0]?.status === "rejected") throw settled[0].reason;
  } catch (cause) {
    // error-policy:J2 Preserve extraction failure if lock teardown also fails.
    primaryFailure = cause;
  }
  try {
    if (!heldLock) await lock.release(internalCleanupControl());
  } catch (cause) {
    // error-policy:J2 Both failures remain inspectable; neither becomes success.
    if (primaryFailure !== undefined)
      invalid(
        "CLEANUP_FAILED",
        "Database extraction and lock cleanup failed",
        new AggregateError([primaryFailure, cause]),
      );
    throw cause;
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (!result)
    invalid(
      "FINISH_MISSING",
      "Database extraction did not publish an exact finish",
    );
  return result;
}
