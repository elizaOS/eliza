/**
 * Joins all five authenticated component inboxes into one private candidate.
 * A single root lock covers materialization, database validation and receipt
 * publication. The receipt names only the five component directories: it is
 * not a seal authorization, generation commit, readiness or routing authority.
 * The authenticated stream and durable coordinator retain those authorities.
 */

import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  type AgentBackupRestoreV3CandidateReceipt,
  type AgentBackupRestoreV3DeepReadonly,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3StagingSession,
  type AgentBackupRestoreV3StreamComponentName,
  parseAgentBackupRestoreV3CandidateReceipt,
} from "@elizaos/shared";
import { materializeAgentBackupRestoreV3CandidateCharacter } from "./agent-backup-restore-v3-candidate-character";
import {
  type AgentBackupRestoreV3CandidateDatabaseValidationReceipt,
  validateAgentBackupRestoreV3CandidateDatabase,
} from "./agent-backup-restore-v3-candidate-database-validation";
import { materializeAgentBackupRestoreV3CandidateFileSet } from "./agent-backup-restore-v3-candidate-file-set";
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
import {
  bindAgentBackupRestoreV3CandidateRecordSession,
  snapshotAgentBackupRestoreV3CandidateSession,
} from "./agent-backup-restore-v3-candidate-records";

const ASSEMBLY_MARKER = ".restore-v3-candidate-assembled.json";
const RECEIPT_LIMIT = 16 * 1024;

export interface AgentBackupRestoreV3CandidateAssemblyInput {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly session: Readonly<AgentBackupRestoreV3StagingSession>;
  /** Exact receipt produced by the authenticated stream, not client assertions. */
  readonly receipt: AgentBackupRestoreV3DeepReadonly<AgentBackupRestoreV3CandidateReceipt>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
}

interface AssembledComponent {
  readonly componentName: AgentBackupRestoreV3StreamComponentName;
  readonly outputDirectory: string;
  readonly finishSha256: string;
  readonly treeSha256: string;
  readonly device: string;
  readonly inode: string;
}

export interface AgentBackupRestoreV3CandidateAssemblyReceipt {
  readonly version: 1;
  readonly format: "elizaos.agent-backup.restore-v3-candidate-assembled.v1";
  readonly sessionSha256: string;
  readonly candidateReceiptSha256: string;
  readonly attemptRootDevice: string;
  readonly attemptRootInode: string;
  readonly components: readonly Readonly<AssembledComponent>[];
  readonly databaseValidation: Readonly<AgentBackupRestoreV3CandidateDatabaseValidationReceipt>;
  readonly assemblySha256: string;
}

function assemblyError(code: string, message: string, cause?: unknown): never {
  throw new ElizaError(message, {
    code: `AGENT_BACKUP_RESTORE_V3_CANDIDATE_ASSEMBLY_${code}`,
    severity: "fatal",
    ...(cause === undefined ? {} : { cause }),
  });
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(candidateFsCanonicalJson(value))
    .digest("hex");
}

function componentProof(value: {
  readonly component: {
    readonly componentName: AgentBackupRestoreV3StreamComponentName;
  };
  readonly outputDirectory: string;
  readonly finishSha256: string;
  readonly tree: {
    readonly sha256: string;
    readonly device: string;
    readonly inode: string;
  };
}): Readonly<AssembledComponent> {
  return Object.freeze({
    componentName: value.component.componentName,
    outputDirectory: value.outputDirectory,
    finishSha256: value.finishSha256,
    treeSha256: value.tree.sha256,
    device: value.tree.device,
    inode: value.tree.inode,
  });
}

export async function assembleAgentBackupRestoreV3Candidate(
  input: Readonly<AgentBackupRestoreV3CandidateAssemblyInput>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateAssemblyReceipt>> {
  const exact = snapshotOwnDataRecord(
    input,
    ["candidateFs", "session", "receipt", "control"],
    ["candidateFs", "session", "receipt", "control"],
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_ASSEMBLY_INPUT_INVALID",
    "Candidate assembly requires one exact input object",
  );
  if (!isAgentBackupRestoreV3CandidateFs(exact.candidateFs))
    assemblyError(
      "INPUT_INVALID",
      "Candidate assembly requires real filesystem authority",
    );
  const candidateFs = exact.candidateFs as AgentBackupRestoreV3CandidateFs;
  const session = snapshotAgentBackupRestoreV3CandidateSession(
    exact.session as AgentBackupRestoreV3StagingSession,
  );
  const control = snapshotOperationControl(
    exact.control as AgentBackupRestoreV3OperationControl,
  );
  // Canonicalization rejects proxies/accessors before the schema reads nested
  // fields. This also detaches the entire receipt synchronously before any I/O.
  const receipt = parseAgentBackupRestoreV3CandidateReceipt(
    JSON.parse(candidateFsCanonicalJson(exact.receipt)),
  );
  if (
    receipt.restoreAttemptId !== session.restoreAttemptId ||
    receipt.operationId !== session.operationId ||
    receipt.expectedManifestSha256 !== session.expectedManifestSha256
  )
    assemblyError(
      "SESSION_CONFLICT",
      "Candidate receipt differs from the exact staging session",
    );
  const candidateReceiptSha256 = digest(receipt);
  const lock =
    heldLock ??
    (await candidateFs.acquireLock(".restore-v3-assemble.lock", control));
  let failure: unknown;
  let result:
    | Readonly<AgentBackupRestoreV3CandidateAssemblyReceipt>
    | undefined;
  try {
    const sessionSha256 = await bindAgentBackupRestoreV3CandidateRecordSession({
      candidateFs,
      session,
      control,
      heldLock: lock,
    });
    const persisted = await candidateFs.readDurableJson(
      ASSEMBLY_MARKER,
      { maximumBytes: RECEIPT_LIMIT },
      control,
      lock,
    );
    if (persisted !== null) {
      const identity = snapshotOwnDataRecord(
        persisted,
        [
          "version",
          "format",
          "sessionSha256",
          "candidateReceiptSha256",
          "attemptRootDevice",
          "attemptRootInode",
          "components",
          "databaseValidation",
          "assemblySha256",
        ],
        [
          "version",
          "format",
          "sessionSha256",
          "candidateReceiptSha256",
          "attemptRootDevice",
          "attemptRootInode",
          "components",
          "databaseValidation",
          "assemblySha256",
        ],
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_ASSEMBLY_RECEIPT_CONFLICT",
        "Persisted candidate assembly receipt is not exact",
      );
      if (
        identity.sessionSha256 !== sessionSha256 ||
        identity.candidateReceiptSha256 !== candidateReceiptSha256
      )
        assemblyError(
          "RECEIPT_CONFLICT",
          "Candidate assembly belongs to another exact stream",
        );
    }

    const components: Readonly<AssembledComponent>[] = [];
    let databaseValidation:
      | Readonly<AgentBackupRestoreV3CandidateDatabaseValidationReceipt>
      | undefined;
    for (const component of receipt.components) {
      const materialization = {
        candidateFs,
        session,
        receipt: component,
        control,
      };
      if (component.componentName === "character") {
        components.push(
          componentProof(
            await materializeAgentBackupRestoreV3CandidateCharacter(
              materialization,
              lock,
            ),
          ),
        );
      } else if (component.componentName === "database") {
        databaseValidation =
          await validateAgentBackupRestoreV3CandidateDatabase(
            materialization,
            lock,
          );
        components.push(
          Object.freeze({
            componentName: "database",
            outputDirectory: "components/database",
            finishSha256: databaseValidation.extractionFinishSha256,
            treeSha256: databaseValidation.sourceTreeSha256,
            device: databaseValidation.sourceTreeDevice,
            inode: databaseValidation.sourceTreeInode,
          }),
        );
      } else {
        components.push(
          componentProof(
            await materializeAgentBackupRestoreV3CandidateFileSet(
              materialization,
              lock,
            ),
          ),
        );
      }
    }
    if (!databaseValidation)
      assemblyError(
        "DATABASE_MISSING",
        "Candidate assembly has no physical database validation",
      );
    const body = Object.freeze({
      version: 1 as const,
      format: "elizaos.agent-backup.restore-v3-candidate-assembled.v1" as const,
      sessionSha256,
      candidateReceiptSha256,
      attemptRootDevice: candidateFs.attemptRootIdentity.device,
      attemptRootInode: candidateFs.attemptRootIdentity.inode,
      components: Object.freeze(components),
      databaseValidation,
    });
    const expected = Object.freeze({ ...body, assemblySha256: digest(body) });
    if (
      persisted !== null &&
      candidateFsCanonicalJson(persisted) !== candidateFsCanonicalJson(expected)
    )
      assemblyError(
        "RECEIPT_CONFLICT",
        "Candidate assembly differs from its durable receipt",
      );
    if (persisted === null) {
      await candidateFs.publishDurableJson(
        ASSEMBLY_MARKER,
        expected,
        { maximumBytes: RECEIPT_LIMIT },
        control,
        lock,
      );
    }
    const durable = await candidateFs.readDurableJson(
      ASSEMBLY_MARKER,
      { maximumBytes: RECEIPT_LIMIT },
      control,
      lock,
    );
    if (
      candidateFsCanonicalJson(durable) !== candidateFsCanonicalJson(expected)
    )
      assemblyError(
        "RECEIPT_CONFLICT",
        "Candidate assembly changed during publication",
      );
    result = expected;
  } catch (cause) {
    // error-policy:J2 Preserve the operation failure across lock teardown.
    failure = cause;
  }
  try {
    if (!heldLock) await lock.release(internalCleanupControl());
  } catch (cause) {
    // error-policy:J2 Failed release is never hidden behind an assembly receipt.
    if (failure !== undefined)
      assemblyError(
        "CLEANUP_FAILED",
        "Candidate assembly and lock release failed",
        new AggregateError([failure, cause]),
      );
    throw cause;
  }
  if (failure !== undefined) throw failure;
  if (!result)
    assemblyError(
      "RECEIPT_MISSING",
      "Candidate assembly produced no durable receipt",
    );
  return result;
}
