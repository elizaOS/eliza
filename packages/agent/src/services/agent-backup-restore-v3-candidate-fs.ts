/**
 * Public facade for the private restore-v3 candidate filesystem boundary.
 * Implementation is split by authority/control, durable JSON, payload, and
 * tree proof/cleanup responsibilities.
 */

import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  AgentBackupRestoreV3CandidateFsControl,
  type AgentBackupRestoreV3CandidateFsIdentity,
  type AgentBackupRestoreV3CandidateFsLock,
  type OpenAgentBackupRestoreV3CandidateFsInput,
} from "./agent-backup-restore-v3-candidate-fs-control";
import {
  type AgentBackupRestoreV3CandidateDurableJsonReceipt,
  type PublishAgentBackupRestoreV3CandidateDurableJsonOptions,
  publishCandidateFsDurableJson,
} from "./agent-backup-restore-v3-candidate-fs-json";
import {
  type AgentBackupRestoreV3CandidatePayloadReceipt,
  type AgentBackupRestoreV3CandidatePayloadWriter,
  type CreateAgentBackupRestoreV3CandidatePayloadOptions,
  createCandidateFsPayload,
  type ProveAgentBackupRestoreV3CandidatePayloadOptions,
  proveCandidateFsPayload,
} from "./agent-backup-restore-v3-candidate-fs-payload";
import {
  type AgentBackupRestoreV3CandidateCleanupLimits,
  type AgentBackupRestoreV3CandidateCleanupReceipt,
  type AgentBackupRestoreV3CandidateTreeLimits,
  type AgentBackupRestoreV3CandidateTreeProof,
  cleanupCandidateFsVolatile,
  proveCandidateFsTree,
} from "./agent-backup-restore-v3-candidate-fs-tree";

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
} from "./agent-backup-restore-v3-candidate-fs-json";
export type {
  AgentBackupRestoreV3CandidatePayloadReceipt,
  CreateAgentBackupRestoreV3CandidatePayloadOptions,
  ProveAgentBackupRestoreV3CandidatePayloadOptions,
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

export class AgentBackupRestoreV3CandidateFs {
  readonly trustedRoot: string;
  readonly attemptRoot: string;
  readonly trustedRootIdentity: AgentBackupRestoreV3CandidateFsIdentity;
  readonly attemptRootIdentity: AgentBackupRestoreV3CandidateFsIdentity;
  readonly #control: AgentBackupRestoreV3CandidateFsControl;

  private constructor(control: AgentBackupRestoreV3CandidateFsControl) {
    this.#control = control;
    this.trustedRoot = control.trustedRoot;
    this.attemptRoot = control.attemptRoot;
    this.trustedRootIdentity = control.trustedRootIdentity;
    this.attemptRootIdentity = control.attemptRootIdentity;
  }

  static async open(
    input: Readonly<OpenAgentBackupRestoreV3CandidateFsInput>,
  ): Promise<AgentBackupRestoreV3CandidateFs> {
    return new AgentBackupRestoreV3CandidateFs(
      await AgentBackupRestoreV3CandidateFsControl.open(input),
    );
  }

  assertAuthority(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    return this.#control.assertAuthority(control);
  }

  syncAttemptRoot(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    return this.#control.syncAttemptRoot(control);
  }

  close(): Promise<void> {
    return this.#control.close();
  }

  detachLock(lock: AgentBackupRestoreV3CandidateFsLock): void {
    this.#control.detachLock(lock);
  }

  assertLockHeld(
    lock: AgentBackupRestoreV3CandidateFsLock,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    return this.#control.assertLockHeld(lock, control);
  }

  acquireLock(
    name: string,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<AgentBackupRestoreV3CandidateFsLock> {
    return this.#control.acquireLock(name, control);
  }

  createPayload(
    name: string,
    options: Readonly<CreateAgentBackupRestoreV3CandidatePayloadOptions>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<AgentBackupRestoreV3CandidatePayloadWriter> {
    return createCandidateFsPayload(
      this.#control,
      name,
      options,
      control,
      heldLock,
    );
  }

  provePayload(
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
      control,
      heldLock,
    );
  }

  publishDurableJson(
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
      control,
      heldLock,
    );
  }

  proveTree(
    relativeDirectory: string,
    limitsValue: Partial<AgentBackupRestoreV3CandidateTreeLimits> | undefined,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    heldLock?: AgentBackupRestoreV3CandidateFsLock,
  ): Promise<Readonly<AgentBackupRestoreV3CandidateTreeProof>> {
    return proveCandidateFsTree(
      this.#control,
      relativeDirectory,
      limitsValue,
      control,
      heldLock,
    );
  }

  cleanupVolatile(
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
      control,
      heldLock,
    );
  }
}

export async function openAgentBackupRestoreV3CandidateFs(
  input: Readonly<OpenAgentBackupRestoreV3CandidateFsInput>,
): Promise<AgentBackupRestoreV3CandidateFs> {
  return AgentBackupRestoreV3CandidateFs.open(input);
}
