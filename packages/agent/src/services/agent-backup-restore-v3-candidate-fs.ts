/**
 * Public facade for the private restore-v3 candidate filesystem boundary.
 * Implementation is split by authority/control, durable JSON, payload, and
 * tree proof/cleanup responsibilities.
 */

import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFileTreeFileProof,
  type AgentBackupRestoreV3CandidateFileTreeFileSpec,
  type AgentBackupRestoreV3CandidateFileTreeLimits,
  type AgentBackupRestoreV3CandidateFileTreeProof,
  type AgentBackupRestoreV3CandidateFileTreeWriter,
  createCandidateFsFileTreeFile,
  ensureCandidateFsFileTreeDirectory,
  proveCandidateFsFileTree,
} from "./agent-backup-restore-v3-candidate-file-tree";
import {
  AgentBackupRestoreV3CandidateFsControl,
  type AgentBackupRestoreV3CandidateFsIdentity,
  type AgentBackupRestoreV3CandidateFsLock,
  type OpenAgentBackupRestoreV3CandidateFsInput,
  snapshotOperationControl,
} from "./agent-backup-restore-v3-candidate-fs-control";
import {
  type AgentBackupRestoreV3CandidateDurableJsonReceipt,
  type PublishAgentBackupRestoreV3CandidateDurableJsonOptions,
  publishCandidateFsDurableJson,
  type ReadAgentBackupRestoreV3CandidateDurableJsonOptions,
  readCandidateFsDurableJson,
} from "./agent-backup-restore-v3-candidate-fs-json";
import {
  type AgentBackupRestoreV3CandidatePayloadRead,
  type AgentBackupRestoreV3CandidatePayloadReceipt,
  type AgentBackupRestoreV3CandidatePayloadWriter,
  type CreateAgentBackupRestoreV3CandidatePayloadOptions,
  createCandidateFsPayload,
  type ProveAgentBackupRestoreV3CandidatePayloadOptions,
  proveCandidateFsPayload,
  type ReadAgentBackupRestoreV3CandidatePayloadOptions,
  readCandidateFsPayload,
} from "./agent-backup-restore-v3-candidate-fs-payload";
import {
  type AgentBackupRestoreV3CandidateCleanupLimits,
  type AgentBackupRestoreV3CandidateCleanupReceipt,
  type AgentBackupRestoreV3CandidateTreeLimits,
  type AgentBackupRestoreV3CandidateTreeProof,
  cleanupCandidateFsVolatile,
  proveCandidateFsTree,
} from "./agent-backup-restore-v3-candidate-fs-tree";

const CANDIDATE_FS_CONSTRUCTION_AUTHORITY = Symbol(
  "candidate-fs-construction-authority",
);
const CANDIDATE_FS_INSTANCES = new WeakSet<object>();
const OBJECT_FREEZE = Object.freeze;
const REFLECT_APPLY = Reflect.apply;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

export type {
  AgentBackupRestoreV3CandidateFileTreeFileProof,
  AgentBackupRestoreV3CandidateFileTreeFileSpec,
  AgentBackupRestoreV3CandidateFileTreeLimits,
  AgentBackupRestoreV3CandidateFileTreeProof,
} from "./agent-backup-restore-v3-candidate-file-tree";
export {
  AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS,
  AgentBackupRestoreV3CandidateFileTreeWriter,
} from "./agent-backup-restore-v3-candidate-file-tree";
export type {
  AgentBackupRestoreV3CandidateFsIdentity,
  OpenAgentBackupRestoreV3CandidateFsInput,
} from "./agent-backup-restore-v3-candidate-fs-control";
export {
  AgentBackupRestoreV3CandidateFsError,
  AgentBackupRestoreV3CandidateFsLock,
} from "./agent-backup-restore-v3-candidate-fs-control";
export type {
  AgentBackupRestoreV3CandidateDurableJsonReceipt,
  PublishAgentBackupRestoreV3CandidateDurableJsonOptions,
  ReadAgentBackupRestoreV3CandidateDurableJsonOptions,
} from "./agent-backup-restore-v3-candidate-fs-json";
export type {
  AgentBackupRestoreV3CandidatePayloadRead,
  AgentBackupRestoreV3CandidatePayloadReceipt,
  CreateAgentBackupRestoreV3CandidatePayloadOptions,
  ProveAgentBackupRestoreV3CandidatePayloadOptions,
  ReadAgentBackupRestoreV3CandidatePayloadOptions,
} from "./agent-backup-restore-v3-candidate-fs-payload";
export { AgentBackupRestoreV3CandidatePayloadWriter } from "./agent-backup-restore-v3-candidate-fs-payload";
export type {
  AgentBackupRestoreV3CandidateCleanupLimits,
  AgentBackupRestoreV3CandidateCleanupReceipt,
  AgentBackupRestoreV3CandidateTreeLimits,
  AgentBackupRestoreV3CandidateTreeProof,
} from "./agent-backup-restore-v3-candidate-fs-tree";
export {
  AGENT_BACKUP_RESTORE_V3_CANDIDATE_CLEANUP_LIMITS,
  AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS,
} from "./agent-backup-restore-v3-candidate-fs-tree";

/**
 * Authority for one stopped restore quarantine.
 *
 * POSIX flock is advisory: callers must keep both roots inaccessible to the
 * workload and to non-cooperating same-UID writers until activation, and must
 * route every authorized mutation through this capability while its lock is
 * held. File-tree proofs additionally detect bounded in-operation races, but
 * cannot manufacture an atomic multi-inode snapshot against a raw writer that
 * deliberately ignores the quarantine boundary.
 */
export class AgentBackupRestoreV3CandidateFs {
  readonly trustedRoot: string;
  readonly attemptRoot: string;
  readonly trustedRootIdentity: AgentBackupRestoreV3CandidateFsIdentity;
  readonly attemptRootIdentity: AgentBackupRestoreV3CandidateFsIdentity;
  readonly #control: AgentBackupRestoreV3CandidateFsControl;

  private constructor(
    control: AgentBackupRestoreV3CandidateFsControl,
    constructionAuthority: symbol,
  ) {
    if (constructionAuthority !== CANDIDATE_FS_CONSTRUCTION_AUTHORITY) {
      throw new TypeError("Candidate filesystem construction is private");
    }
    this.#control = control;
    this.trustedRoot = control.trustedRoot;
    this.attemptRoot = control.attemptRoot;
    this.trustedRootIdentity = control.trustedRootIdentity;
    this.attemptRootIdentity = control.attemptRootIdentity;
    REFLECT_APPLY(WEAK_SET_ADD, CANDIDATE_FS_INSTANCES, [this]);
    OBJECT_FREEZE(this);
  }

  static async open(
    input: Readonly<OpenAgentBackupRestoreV3CandidateFsInput>,
  ): Promise<AgentBackupRestoreV3CandidateFs> {
    return new AgentBackupRestoreV3CandidateFs(
      await AgentBackupRestoreV3CandidateFsControl.open(input),
      CANDIDATE_FS_CONSTRUCTION_AUTHORITY,
    );
  }

  async assertAuthority(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    return this.#control.assertAuthority(snapshotOperationControl(control));
  }

  async syncAttemptRoot(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    return this.#control.syncAttemptRoot(snapshotOperationControl(control));
  }

  close(): Promise<void> {
    return this.#control.close();
  }

  async assertLockHeld(
    lock: AgentBackupRestoreV3CandidateFsLock,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    return this.#control.assertLockHeld(
      lock,
      snapshotOperationControl(control),
    );
  }

  async acquireLock(
    name: string,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<AgentBackupRestoreV3CandidateFsLock> {
    return this.#control.acquireLock(name, snapshotOperationControl(control));
  }

  async createPayload(
    name: string,
    options: Readonly<CreateAgentBackupRestoreV3CandidatePayloadOptions>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<AgentBackupRestoreV3CandidatePayloadWriter> {
    return createCandidateFsPayload(
      this.#control,
      name,
      options,
      snapshotOperationControl(control),
      heldLock,
    );
  }

  async provePayload(
    name: string,
    expectedValue: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>,
    options: Readonly<ProveAgentBackupRestoreV3CandidatePayloadOptions>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>> {
    return proveCandidateFsPayload(
      this.#control,
      name,
      expectedValue,
      options,
      snapshotOperationControl(control),
      heldLock,
    );
  }

  async readPayload(
    name: string,
    expectedValue: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>,
    options: Readonly<ReadAgentBackupRestoreV3CandidatePayloadOptions>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<Readonly<AgentBackupRestoreV3CandidatePayloadRead>> {
    return readCandidateFsPayload(
      this.#control,
      name,
      expectedValue,
      options,
      snapshotOperationControl(control),
      heldLock,
    );
  }

  async readDurableJson(
    name: string,
    options: Readonly<ReadAgentBackupRestoreV3CandidateDurableJsonOptions>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<unknown | null> {
    return readCandidateFsDurableJson(
      this.#control,
      name,
      options,
      snapshotOperationControl(control),
      heldLock,
    );
  }

  async publishDurableJson(
    name: string,
    value: unknown,
    options: Readonly<PublishAgentBackupRestoreV3CandidateDurableJsonOptions>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<Readonly<AgentBackupRestoreV3CandidateDurableJsonReceipt>> {
    return publishCandidateFsDurableJson(
      this.#control,
      name,
      value,
      options,
      snapshotOperationControl(control),
      heldLock,
    );
  }

  async proveTree(
    relativeDirectory: string,
    limitsValue: Partial<AgentBackupRestoreV3CandidateTreeLimits> | undefined,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<Readonly<AgentBackupRestoreV3CandidateTreeProof>> {
    return proveCandidateFsTree(
      this.#control,
      relativeDirectory,
      limitsValue,
      snapshotOperationControl(control),
      heldLock,
    );
  }

  async ensureFileTreeDirectory(
    relativeDirectory: string,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<void> {
    return ensureCandidateFsFileTreeDirectory(
      this.#control,
      relativeDirectory,
      snapshotOperationControl(control),
      heldLock,
    );
  }

  async createFileTreeFile(
    relativeDirectory: string,
    spec: Readonly<AgentBackupRestoreV3CandidateFileTreeFileSpec>,
    limitsValue:
      | Partial<AgentBackupRestoreV3CandidateFileTreeLimits>
      | undefined,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<AgentBackupRestoreV3CandidateFileTreeWriter> {
    return createCandidateFsFileTreeFile(
      this.#control,
      relativeDirectory,
      spec,
      limitsValue,
      snapshotOperationControl(control),
      heldLock,
    );
  }

  async proveFileTree(
    relativeDirectory: string,
    expected: readonly Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>[],
    limitsValue:
      | Partial<AgentBackupRestoreV3CandidateFileTreeLimits>
      | undefined,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<Readonly<AgentBackupRestoreV3CandidateFileTreeProof>> {
    return proveCandidateFsFileTree(
      this.#control,
      relativeDirectory,
      expected,
      limitsValue,
      snapshotOperationControl(control),
      heldLock,
    );
  }

  async cleanupVolatile(
    names: readonly string[],
    limitsValue:
      | Partial<AgentBackupRestoreV3CandidateCleanupLimits>
      | undefined,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<Readonly<AgentBackupRestoreV3CandidateCleanupReceipt>> {
    return cleanupCandidateFsVolatile(
      this.#control,
      names,
      limitsValue,
      snapshotOperationControl(control),
      heldLock,
    );
  }
}

OBJECT_FREEZE(AgentBackupRestoreV3CandidateFs.prototype);

/** Runtime-only brand check for the unforgeable candidate-FS authority. */
export function isAgentBackupRestoreV3CandidateFs(
  value: unknown,
): value is AgentBackupRestoreV3CandidateFs {
  return (
    typeof value === "object" &&
    value !== null &&
    REFLECT_APPLY(WEAK_SET_HAS, CANDIDATE_FS_INSTANCES, [value])
  );
}

export async function openAgentBackupRestoreV3CandidateFs(
  input: Readonly<OpenAgentBackupRestoreV3CandidateFsInput>,
): Promise<AgentBackupRestoreV3CandidateFs> {
  return AgentBackupRestoreV3CandidateFs.open(input);
}
