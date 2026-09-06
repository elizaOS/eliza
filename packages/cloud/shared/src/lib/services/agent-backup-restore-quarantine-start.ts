/**
 * Starts only the exact retained quarantine host under a live PRIMARY claim.
 * The coordinator supplies its existing reservation authority and retains claim
 * ownership; this effect does not advance a phase or authorize an Agent boot.
 * Ambiguous SSH/transaction outcomes reject and may be reconciled by exact retry.
 */

import { Buffer } from "node:buffer";
import { ElizaError } from "@elizaos/core";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  type ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput,
  withAgentBackupRestoreQuarantineAuthority,
} from "../../db/repositories/agent-backup-restore-operations";
import { buildExactRestoreQuarantineStartCommand } from "./docker-sandbox-provider";
import { DockerSSHClient } from "./docker-ssh";

export async function startAgentBackupRestoreQuarantine(
  input: Readonly<{
    enabled: boolean;
    authority: ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput;
    control: Readonly<AgentBackupRestoreV3OperationControl>;
  }>,
): Promise<
  Readonly<
    | { status: "disabled" }
    | {
        status: "quarantine_running";
        containerId: string;
        receiptDigest: string;
      }
  >
> {
  if (input.enabled !== true) return Object.freeze({ status: "disabled" });
  return withAgentBackupRestoreQuarantineAuthority(
    input.authority,
    input.control,
    async (authority, control) => {
      const { operation, target, locator } = authority;
      const containerId = operation.expected_container_id;
      const imageReference = operation.expected_image_reference;
      const imagePlatformDigest = operation.expected_image_platform_digest;
      if (
        !containerId ||
        !imageReference ||
        !imagePlatformDigest ||
        !locator.nodeHostname ||
        !locator.nodeSshPort ||
        !locator.nodeHostKeyFingerprint ||
        !locator.nodeSshUser
      ) {
        throw new ElizaError("Restore quarantine lacks exact transport authority", {
          code: "AGENT_BACKUP_RESTORE_QUARANTINE_START_AUTHORITY_INVALID",
        });
      }
      const { command, receiptDigest } = buildExactRestoreQuarantineStartCommand({
        agentId: operation.agent_id,
        replacementAttemptId: authority.attempt.id,
        containerId,
        exactRestore: {
          restoreAttemptId: operation.restore_attempt_id,
          target,
          imageReference,
          imageDigest: target.imageDigest,
          imagePlatformDigest,
          quarantine: true,
        },
      });
      const remainingMs = Math.min(control.deadlineEpochMs - Date.now(), 30_000);
      if (remainingMs <= 0)
        throw new DOMException("Restore quarantine deadline expired", "AbortError");
      control.signal.throwIfAborted();
      const signal = AbortSignal.any([control.signal, AbortSignal.timeout(remainingMs)]);
      const ssh = DockerSSHClient.createDedicated(
        locator.nodeHostname,
        locator.nodeSshPort,
        locator.nodeHostKeyFingerprint,
        locator.nodeSshUser,
      );
      try {
        await ssh.execStdinAbortable(command, Buffer.alloc(0), signal, remainingMs, receiptDigest);
        return Object.freeze({ status: "quarantine_running" as const, containerId, receiptDigest });
      } finally {
        await ssh.disconnect();
      }
    },
  );
}
