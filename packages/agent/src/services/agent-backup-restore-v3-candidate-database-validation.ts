/**
 * Validates a physical database on a disposable private copy, keeping the
 * authenticated extraction immutable for crash and response-loss replay.
 * This is SQL lifecycle proof, never an Agent readiness or activation proof.
 */

import { createHash } from "node:crypto";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_COPY_MARKER,
  AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_DIRECTORY,
  type AgentBackupRestoreV3CandidateDatabaseExtractionReceipt,
  type AgentBackupRestoreV3CandidateDatabaseInput,
  extractAgentBackupRestoreV3CandidateDatabase,
  extractAgentBackupRestoreV3CandidateDatabaseValidationCopy,
} from "./agent-backup-restore-v3-candidate-database";
import {
  type AgentBackupRestoreV3CandidateFs,
  type AgentBackupRestoreV3CandidateFsLock,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import {
  internalCleanupControl,
  snapshotOperationControl,
  snapshotOwnDataRecord,
} from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import { snapshotAgentBackupRestoreV3CandidateSession } from "./agent-backup-restore-v3-candidate-records";
import { AgentBackupRestoreV3PgliteArchiveError } from "./agent-backup-restore-v3-pglite-archive";
import { runAgentBackupRestoreV3PgliteValidationProcess } from "./agent-backup-restore-v3-pglite-validation-process";

const VALIDATION_MARKER = ".restore-v3-component-c1.database-validated.json";
const MAXIMUM_RECEIPT_BYTES = 8192;
const DISPOSABLE_PATHS = Object.freeze([
  AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_DIRECTORY,
  AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_COPY_MARKER,
]);

export interface AgentBackupRestoreV3CandidateDatabaseValidationReceipt {
  readonly version: 1;
  readonly format: "elizaos.agent-backup.restore-v3-database-validated.v1";
  readonly sessionSha256: string;
  readonly extractionFinishSha256: string;
  readonly sourceTreeSha256: string;
  readonly sourceTreeDevice: string;
  readonly sourceTreeInode: string;
  readonly serverVersion: string;
  readonly receiptSha256: string;
}

function receiptFor(
  source: Readonly<AgentBackupRestoreV3CandidateDatabaseExtractionReceipt>,
  serverVersion: string,
): Readonly<AgentBackupRestoreV3CandidateDatabaseValidationReceipt> {
  const body = {
    version: 1 as const,
    format: "elizaos.agent-backup.restore-v3-database-validated.v1" as const,
    sessionSha256: source.sessionSha256,
    extractionFinishSha256: source.finishSha256,
    sourceTreeSha256: source.tree.sha256,
    sourceTreeDevice: source.tree.device,
    sourceTreeInode: source.tree.inode,
    serverVersion,
  };
  return Object.freeze({
    ...body,
    receiptSha256: createHash("sha256")
      .update(candidateFsCanonicalJson(body))
      .digest("hex"),
  });
}

export async function validateAgentBackupRestoreV3CandidateDatabase(
  input: Readonly<AgentBackupRestoreV3CandidateDatabaseInput>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateDatabaseValidationReceipt>> {
  const exact = snapshotOwnDataRecord(
    input,
    ["candidateFs", "session", "receipt", "control"],
    ["candidateFs", "session", "receipt", "control"],
    "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_INPUT_INVALID",
    "Database validation requires one exact input object",
  );
  if (!isAgentBackupRestoreV3CandidateFs(exact.candidateFs))
    throw new AgentBackupRestoreV3PgliteArchiveError(
      "INPUT_INVALID",
      "Database validation requires real filesystem authority",
    );
  const candidateFs = exact.candidateFs as AgentBackupRestoreV3CandidateFs;
  const session = snapshotAgentBackupRestoreV3CandidateSession(
    exact.session as AgentBackupRestoreV3CandidateDatabaseInput["session"],
  );
  const control = snapshotOperationControl(
    exact.control as AgentBackupRestoreV3OperationControl,
  );
  const source = await extractAgentBackupRestoreV3CandidateDatabase(
    {
      candidateFs,
      session,
      control,
      receipt:
        exact.receipt as AgentBackupRestoreV3CandidateDatabaseInput["receipt"],
    },
    heldLock,
  );
  const copiedInput = Object.freeze({
    candidateFs,
    session,
    control,
    receipt: source.component,
  });
  const lock =
    heldLock ??
    (await candidateFs.acquireLock(
      ".restore-v3-validate-database.lock",
      control,
    ));
  let result:
    | Readonly<AgentBackupRestoreV3CandidateDatabaseValidationReceipt>
    | undefined;
  let failure: unknown;
  const proveSource = async () => {
    const current = await candidateFs.proveTree(
      source.outputDirectory,
      undefined,
      control,
      lock,
    );
    if (
      candidateFsCanonicalJson(current) !==
      candidateFsCanonicalJson(source.tree)
    )
      throw new AgentBackupRestoreV3PgliteArchiveError(
        "SOURCE_TREE_CHANGED",
        "Database extraction changed during isolated validation",
      );
  };
  try {
    await proveSource();
    const persisted = await candidateFs.readDurableJson(
      VALIDATION_MARKER,
      { maximumBytes: MAXIMUM_RECEIPT_BYTES },
      control,
      lock,
    );
    if (persisted !== null) {
      const keys = Object.keys(receiptFor(source, "170000"));
      const data = snapshotOwnDataRecord(
        persisted,
        keys,
        keys,
        "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_VALIDATION_CONFLICT",
        "Database validation receipt is not exact",
      );
      if (
        typeof data.serverVersion !== "string" ||
        !/^[1-9][0-9]{4,5}$/.test(data.serverVersion)
      )
        throw new AgentBackupRestoreV3PgliteArchiveError(
          "VALIDATION_CONFLICT",
          "Database validation receipt has no server identity",
        );
      const expected = receiptFor(source, data.serverVersion);
      if (
        candidateFsCanonicalJson(persisted) !==
        candidateFsCanonicalJson(expected)
      )
        throw new AgentBackupRestoreV3PgliteArchiveError(
          "VALIDATION_CONFLICT",
          "Database validation receipt differs from this extraction",
        );
      result = expected;
    } else {
      // A previous process may have died after opening its copy. Its inherited
      // kernel lock prevents admission here until that writer has exited.
      await candidateFs.cleanupVolatile(
        DISPOSABLE_PATHS,
        undefined,
        control,
        lock,
      );
      let serverVersion: string | undefined;
      let validationFailure: unknown;
      try {
        const copy =
          await extractAgentBackupRestoreV3CandidateDatabaseValidationCopy(
            copiedInput,
            lock,
          );
        const validated = await runAgentBackupRestoreV3PgliteValidationProcess({
          candidateFs,
          heldLock: lock,
          copyTree: copy.tree,
          control,
        });
        serverVersion = validated.serverVersion;
      } catch (cause) {
        // error-policy:J2 Keep lifecycle failure through bounded scratch cleanup.
        validationFailure = cause;
      }
      try {
        await candidateFs.cleanupVolatile(
          DISPOSABLE_PATHS,
          undefined,
          internalCleanupControl(),
          lock,
        );
      } catch (cause) {
        // error-policy:J2 Failed cleanup never permits a validation receipt.
        if (validationFailure !== undefined)
          throw new AgentBackupRestoreV3PgliteArchiveError(
            "VALIDATION_CLEANUP_FAILED",
            "Database validation and scratch cleanup failed",
            new AggregateError([validationFailure, cause]),
          );
        throw cause;
      }
      if (validationFailure !== undefined) throw validationFailure;
      if (!serverVersion)
        throw new AgentBackupRestoreV3PgliteArchiveError(
          "VALIDATION_FAILED",
          "Database validation produced no server identity",
        );
      await proveSource();
      const expected = receiptFor(source, serverVersion);
      await candidateFs.publishDurableJson(
        VALIDATION_MARKER,
        expected,
        { maximumBytes: MAXIMUM_RECEIPT_BYTES },
        control,
        lock,
      );
      const durable = await candidateFs.readDurableJson(
        VALIDATION_MARKER,
        { maximumBytes: MAXIMUM_RECEIPT_BYTES },
        control,
        lock,
      );
      if (
        candidateFsCanonicalJson(durable) !== candidateFsCanonicalJson(expected)
      )
        throw new AgentBackupRestoreV3PgliteArchiveError(
          "VALIDATION_CONFLICT",
          "Database validation proof changed after publication",
        );
      result = expected;
    }
  } catch (cause) {
    // error-policy:J2 Preserve the primary failure across lock teardown.
    failure = cause;
  }
  try {
    if (!heldLock) await lock.release(internalCleanupControl());
  } catch (cause) {
    // error-policy:J2 Both failures remain visible to the operation reconciler.
    if (failure !== undefined)
      throw new AgentBackupRestoreV3PgliteArchiveError(
        "VALIDATION_CLEANUP_FAILED",
        "Database validation and lock release failed",
        new AggregateError([failure, cause]),
      );
    throw cause;
  }
  if (failure !== undefined) throw failure;
  if (!result)
    throw new AgentBackupRestoreV3PgliteArchiveError(
      "VALIDATION_FAILED",
      "Database validation did not produce an exact receipt",
    );
  return result;
}
