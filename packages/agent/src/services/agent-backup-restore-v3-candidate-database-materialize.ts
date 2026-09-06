/**
 * Materializes the exact authenticated database record inbox into the stopped
 * candidate, retaining a durable replay receipt before any runtime can open it.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  type AgentBackupRestoreV3ComponentReceipt,
  AgentBackupRestoreV3ComponentReceiptSchema,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import {
  type CandidateDatabaseArchiveExtraction,
  extractCandidateDatabaseArchive,
} from "./agent-backup-restore-v3-candidate-database";
import {
  type AgentBackupRestoreV3CandidateFileTreeLimits,
  type AgentBackupRestoreV3CandidateFs,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { snapshotOperationControl } from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import {
  AgentBackupRestoreV3CandidateRecordError,
  bindAgentBackupRestoreV3CandidateRecordSession,
  computeAgentBackupRestoreV3CandidateSessionSha256,
  readAgentBackupRestoreV3CandidateRecord,
  snapshotAgentBackupRestoreV3CandidateSession,
} from "./agent-backup-restore-v3-candidate-records";

const FINISH_MARKER = ".restore-v3-materialize-c1.finished.json";
const MAXIMUM_FINISH_BYTES = 32 * 1024;

export interface MaterializeCandidateDatabaseInput {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly session: Readonly<AgentBackupRestoreV3StagingSession>;
  readonly receipt: Readonly<AgentBackupRestoreV3ComponentReceipt>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  readonly limits?: Partial<AgentBackupRestoreV3CandidateFileTreeLimits>;
}

function conflict(message: string): never {
  throw new ElizaError(message, {
    code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_DATABASE_CONFLICT",
    severity: "fatal",
  });
}

/** Returns installed-state evidence; opening, validating and activating the database remain separate. */
export type CandidateDatabaseMaterializationReceipt = ReturnType<
  typeof buildFinish
>;

export async function materializeAgentBackupRestoreV3CandidateDatabase(
  input: Readonly<MaterializeCandidateDatabaseInput>,
): Promise<CandidateDatabaseMaterializationReceipt> {
  const candidateFs = input.candidateFs;
  if (!isAgentBackupRestoreV3CandidateFs(candidateFs))
    conflict("Candidate database requires a genuine candidate filesystem");
  const session = snapshotAgentBackupRestoreV3CandidateSession(input.session);
  const component = AgentBackupRestoreV3ComponentReceiptSchema.parse(
    input.receipt,
  );
  Object.freeze(component.descriptor);
  Object.freeze(component);
  if (
    component.componentIndex !== 1 ||
    component.componentName !== "database" ||
    component.descriptor.name !== "database" ||
    component.descriptor.format !== "pglite-data-dir-tar-gzip-v1" ||
    component.descriptor.compression !== "gzip" ||
    component.descriptor.contentKind !== "opaque" ||
    component.descriptor.consistency !== "transactional" ||
    component.payloadBytes <= 0 ||
    component.dataFrameCount <= 0
  )
    conflict(
      "Candidate database receipt differs from its complete PGlite descriptor",
    );
  const initialControl = snapshotOperationControl(input.control);
  const remaining = initialControl.deadlineEpochMs - Date.now();
  if (remaining <= 0 || remaining > 2_147_483_647)
    conflict(
      "Candidate database deadline is outside the supported timer interval",
    );
  const control = Object.freeze({
    deadlineEpochMs: initialControl.deadlineEpochMs,
    signal: AbortSignal.any([
      initialControl.signal,
      AbortSignal.timeout(remaining),
    ]),
  });
  const limits =
    input.limits === undefined ? undefined : Object.freeze({ ...input.limits });
  const lock = await candidateFs.acquireLock(
    ".restore-v3-materialize-c1.lock",
    control,
  );
  let lastRecordReceiptSha256 = "";
  let failure: unknown;
  let result: ReturnType<typeof buildFinish> | undefined;
  try {
    await bindAgentBackupRestoreV3CandidateRecordSession({
      candidateFs,
      session,
      control,
      heldLock: lock,
    });
    async function* compressedRecords() {
      const hash = createHash("sha256");
      let offset = 0;
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
            record.offsetBytes !== offset ||
            record.entry !== null ||
            record.payloadBytes !== inbox.payload.byteLength ||
            inbox.payload.byteLength === 0 ||
            inbox.payload.byteLength > component.payloadBytes - offset
          ) {
            conflict(
              "Candidate database inbox is not exact, opaque and contiguous",
            );
          }
          hash.update(inbox.payload);
          offset += inbox.payload.byteLength;
          lastRecordReceiptSha256 = inbox.receipt.receiptSha256;
          // The bounded Node pipeline owns this copy after yielding; the inbox
          // buffer can then be erased without corrupting buffered gzip input.
          yield Uint8Array.from(inbox.payload);
        } finally {
          inbox.payload.fill(0);
        }
      }
      if (
        offset !== component.payloadBytes ||
        hash.digest("hex") !== component.payloadSha256
      )
        conflict(
          "Candidate database bytes differ from the authenticated component",
        );
      if (
        component.dataFrameCount ===
        AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames
      )
        return;
      try {
        const extra = await readAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session,
          componentIndex: 1,
          dataIndex: component.dataFrameCount,
          control,
          heldLock: lock,
        });
        extra.payload.fill(0);
        conflict(
          "Candidate database has records beyond its authenticated finish",
        );
      } catch (cause) {
        // error-policy:J3 only exact absence establishes the declared inbox end.
        if (
          !(cause instanceof AgentBackupRestoreV3CandidateRecordError) ||
          cause.code !== "AGENT_BACKUP_RESTORE_V3_CANDIDATE_RECORD_ABSENT"
        )
          throw cause;
      }
    }
    const state: {
      extraction: Readonly<CandidateDatabaseArchiveExtraction> | null;
    } = { extraction: null };
    await pipeline(
      Readable.from(compressedRecords(), {
        objectMode: false,
        highWaterMark: 64 * 1024,
      }),
      createGunzip({ chunkSize: 64 * 1024 }),
      async (archive: AsyncIterable<Uint8Array>) => {
        state.extraction = await extractCandidateDatabaseArchive({
          candidateFs,
          archive,
          control,
          limits,
          heldLock: lock,
        });
      },
      { signal: control.signal },
    );
    const extraction = state.extraction;
    if (!extraction)
      conflict(
        "Candidate database decompression ended without extraction evidence",
      );
    const finish = buildFinish(
      session,
      component,
      extraction,
      lastRecordReceiptSha256,
    );
    await candidateFs.publishDurableJson(
      FINISH_MARKER,
      finish,
      { maximumBytes: MAXIMUM_FINISH_BYTES },
      control,
      lock,
    );
    const stored = await candidateFs.readDurableJson(
      FINISH_MARKER,
      { maximumBytes: MAXIMUM_FINISH_BYTES },
      control,
      lock,
    );
    if (candidateFsCanonicalJson(stored) !== candidateFsCanonicalJson(finish))
      conflict("Candidate database durable finish differs from its replay");
    const reproof = await candidateFs.proveFileTree(
      "components/database",
      extraction.tree.entries,
      limits,
      control,
      lock,
      extraction.directories,
    );
    if (
      candidateFsCanonicalJson(reproof) !==
      candidateFsCanonicalJson(extraction.tree)
    )
      conflict("Candidate database changed after its durable finish");
    result = finish;
  } catch (cause) {
    // error-policy:J2 preserve the materialization failure through lock teardown.
    failure = cause;
  }
  try {
    await lock.release(control);
  } catch (cause) {
    // error-policy:J2 teardown failure cannot replace the original failure.
    failure =
      failure === undefined
        ? cause
        : new AggregateError(
            [failure, cause],
            "Candidate database materialization and lock release failed",
          );
  }
  if (failure !== undefined) throw failure;
  if (!result)
    conflict("Candidate database finished without a durable receipt");
  return result;
}

function buildFinish(
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  component: Readonly<AgentBackupRestoreV3ComponentReceipt>,
  extraction: Readonly<CandidateDatabaseArchiveExtraction>,
  lastRecordReceiptSha256: string,
) {
  const tree = extraction.tree;
  const body = Object.freeze({
    version: 1 as const,
    format: "elizaos.agent-backup.restore-v3-candidate-database.v1" as const,
    sessionSha256: computeAgentBackupRestoreV3CandidateSessionSha256(session),
    component,
    outputDirectory: "components/database" as const,
    fileMode: 0o600,
    directoryMode: 0o700,
    fileMtimeMs: 0,
    lastRecordReceiptSha256,
    tree: Object.freeze({
      derivation: tree.derivation,
      device: tree.device,
      inode: tree.inode,
      sha256: tree.sha256,
      bytes: tree.bytes,
      files: tree.files,
      directories: tree.directories,
    }),
  });
  return Object.freeze({
    ...body,
    finishSha256: createHash("sha256")
      .update(candidateFsCanonicalJson(body), "utf8")
      .digest("hex"),
  });
}
