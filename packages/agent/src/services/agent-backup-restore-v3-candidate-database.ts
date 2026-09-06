/**
 * Extracts a PGlite archive below the stopped candidate filesystem and proves
 * its exact files and directories. It does not open the database or authorize
 * activation; authenticated inbox and database validation remain caller duties.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  type AgentBackupRestoreV3OperationControl,
  compareAgentBackupCaptureV2FilePaths,
} from "@elizaos/shared";
import {
  AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS,
  type AgentBackupRestoreV3CandidateFileTreeFileProof,
  type AgentBackupRestoreV3CandidateFileTreeLimits,
  type AgentBackupRestoreV3CandidateFileTreeProof,
  type AgentBackupRestoreV3CandidateFs,
  type AgentBackupRestoreV3CandidateFsLock,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { snapshotOperationControl } from "./agent-backup-restore-v3-candidate-fs-control";
import { decodeCandidateDatabaseArchive } from "./agent-backup-restore-v3-database-archive";

const OUTPUT_DIRECTORY = "components/database";

export interface ExtractCandidateDatabaseArchiveInput {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly archive: AsyncIterable<Uint8Array>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  readonly limits?: Partial<AgentBackupRestoreV3CandidateFileTreeLimits>;
  readonly heldLock?: AgentBackupRestoreV3CandidateFsLock;
}

export interface CandidateDatabaseArchiveExtraction {
  readonly tree: Readonly<AgentBackupRestoreV3CandidateFileTreeProof>;
  readonly directories: readonly string[];
}

/** Files are installed privately (0600), directories privately (0700), with zero file mtime. */
export async function extractCandidateDatabaseArchive(
  input: Readonly<ExtractCandidateDatabaseArchiveInput>,
): Promise<Readonly<CandidateDatabaseArchiveExtraction>> {
  const candidateFs = input.candidateFs;
  if (!isAgentBackupRestoreV3CandidateFs(candidateFs))
    throw new ElizaError(
      "Candidate database requires a genuine candidate filesystem",
      {
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_DATABASE_CAPABILITY_INVALID",
      },
    );
  const archive = input.archive;
  const heldLock = input.heldLock;
  const ownsLock = heldLock === undefined;
  const control = snapshotOperationControl(input.control);
  const limits = Object.freeze({
    ...AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS,
    ...input.limits,
  });
  const lock =
    heldLock ??
    (await candidateFs.acquireLock(".restore-v3-materialize-c1.lock", control));
  const files: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>[] = [];
  const directories = new Set<string>();
  let writer: Awaited<
    ReturnType<AgentBackupRestoreV3CandidateFs["createFileTreeFile"]>
  > | null = null;
  let fileHash = createHash("sha256");
  let failure: unknown;
  let result: Readonly<AgentBackupRestoreV3CandidateFileTreeProof> | undefined;
  try {
    await candidateFs.ensureFileTreeDirectory(OUTPUT_DIRECTORY, control, lock);
    for await (const record of decodeCandidateDatabaseArchive(archive, {
      maximumBytes: limits.maximumBytes,
      maximumEntries: limits.maximumFiles + limits.maximumDirectories,
    })) {
      if (record.kind === "directory") {
        directories.add(record.path);
        await candidateFs.ensureFileTreeDirectory(
          `${OUTPUT_DIRECTORY}/${record.path}`,
          control,
          lock,
        );
        continue;
      }
      if (record.offsetBytes === 0) {
        fileHash = createHash("sha256");
        writer = await candidateFs.createFileTreeFile(
          OUTPUT_DIRECTORY,
          {
            path: record.path,
            sizeBytes: record.sizeBytes,
            mode: 0o600,
            mtimeMs: 0,
          },
          limits,
          control,
          lock,
        );
      }
      if (!writer)
        throw new ElizaError("Database archive lost its file writer", {
          code: "AGENT_BACKUP_RESTORE_V3_DATABASE_FILE_SEQUENCE_INVALID",
        });
      fileHash.update(record.payload);
      if (!writer.replayed && record.payload.byteLength > 0)
        await writer.write(record.payload, control);
      if (record.offsetBytes + record.payload.byteLength === record.sizeBytes) {
        const proof = await writer.finalize(control);
        if (proof.sha256 !== fileHash.digest("hex"))
          throw new ElizaError(
            "Candidate database file differs from the archive",
            {
              code: "AGENT_BACKUP_RESTORE_V3_DATABASE_FILE_CONFLICT",
            },
          );
        files.push(proof);
        await writer.close();
        writer = null;
      }
    }
    files.sort((a, b) => compareAgentBackupCaptureV2FilePaths(a.path, b.path));
    result = await candidateFs.proveFileTree(
      OUTPUT_DIRECTORY,
      files,
      limits,
      control,
      lock,
      [...directories].sort(compareAgentBackupCaptureV2FilePaths),
    );
  } catch (cause) {
    // error-policy:J2 retain extraction failure alongside any teardown failure.
    failure = cause;
  }
  for (const cleanup of [
    async () => {
      if (writer) await writer.close();
    },
    async () => {
      if (ownsLock) await lock.release(control);
    },
  ]) {
    try {
      await cleanup();
    } catch (cause) {
      // error-policy:J2 cleanup cannot mask the original extraction failure.
      failure =
        failure === undefined
          ? cause
          : new AggregateError(
              [failure, cause],
              "Candidate database extraction and cleanup failed",
            );
    }
  }
  if (failure !== undefined) throw failure;
  if (!result)
    throw new ElizaError(
      "Candidate database extraction ended without a tree proof",
      {
        code: "AGENT_BACKUP_RESTORE_V3_DATABASE_PROOF_MISSING",
      },
    );
  return Object.freeze({
    tree: result,
    directories: Object.freeze(
      [...directories].sort(compareAgentBackupCaptureV2FilePaths),
    ),
  });
}
