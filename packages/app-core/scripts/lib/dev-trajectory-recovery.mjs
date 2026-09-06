/**
 * Retains diagnostic ownership while a development API child is alive and
 * transfers recovery authority only after that exact ChildProcess exits.
 * Nothing is persisted: a supervisor restart deliberately loses this proof.
 */
import { randomUUID } from "node:crypto";
import {
  DEV_TRAJECTORY_RECOVERY_VERSION,
  MAX_DEV_RECOVERY_CHILD_OWNERS,
  MAX_DEV_RECOVERY_OWNERS,
  parseDevTrajectoryRecoveryChildMessage,
  sameDevTrajectoryRecoveryOwner,
  sameDevTrajectoryRecoveryScope,
} from "../../../agent/src/runtime/dev-trajectory-recovery-protocol.ts";

export function createDevTrajectoryRecoveryCoordinator({ warn }) {
  const knownOwners = new Map();
  const deadOwners = new Map();
  const attached = new WeakSet();

  return {
    attach(child) {
      if (attached.has(child)) return;
      attached.add(child);
      const owners = new Map();
      const requests = new Map();
      let exited = false;

      function send(message) {
        if (exited || !child.connected) return;
        try {
          child.send(message, (error) => {
            if (error)
              warn(
                "Trajectory recovery IPC delivery failed; ownership retained.",
              );
          });
        } catch {
          // error-policy:J7 Failed diagnostic IPC never erases retained ownership.
          warn("Trajectory recovery IPC unavailable; ownership retained.");
        }
      }

      function reject(requestId, reason) {
        send({
          type: "eliza:trajectory-recovery:rejected",
          version: DEV_TRAJECTORY_RECOVERY_VERSION,
          requestId,
          reason,
        });
      }

      function onMessage(raw) {
        if (exited) return;
        const message = parseDevTrajectoryRecoveryChildMessage(raw);
        if (!message) return;
        if (message.type === "eliza:trajectory-recovery:register") {
          const existing = requests.get(message.requestId);
          if (existing) {
            if (
              !sameDevTrajectoryRecoveryOwner(existing.owner, message.owner)
            ) {
              reject(message.requestId, "request_owner_mismatch");
              return;
            }
            send(existing.response);
            return;
          }
          const token = message.owner.runtimeExecutionOwnerId;
          if (knownOwners.has(token)) {
            reject(message.requestId, "execution_owner_already_registered");
            return;
          }
          if (
            owners.size >= MAX_DEV_RECOVERY_CHILD_OWNERS ||
            knownOwners.size >= MAX_DEV_RECOVERY_OWNERS
          ) {
            reject(message.requestId, "owner_capacity_exceeded");
            return;
          }
          const recoverable = [...deadOwners.values()].filter((owner) =>
            sameDevTrajectoryRecoveryScope(owner, message.owner),
          );
          const response = {
            type: "eliza:trajectory-recovery:registered",
            version: DEV_TRAJECTORY_RECOVERY_VERSION,
            requestId: message.requestId,
            owner: message.owner,
            recoveryBatchId: randomUUID(),
            owners: recoverable,
          };
          // Retain before sending: a crash after receipt but before INSERT is
          // harmless; losing proof after INSERT would leave an orphaned row.
          knownOwners.set(token, message.owner);
          owners.set(token, message.owner);
          requests.set(message.requestId, {
            owner: message.owner,
            response,
            acknowledged: false,
          });
          send(response);
          return;
        }
        const request = requests.get(message.requestId);
        if (
          !request ||
          request.response.recoveryBatchId !== message.recoveryBatchId
        ) {
          reject(message.requestId, "unknown_recovery_batch");
          return;
        }
        if (!request.acknowledged) {
          for (const owner of request.response.owners) {
            const token = owner.runtimeExecutionOwnerId;
            const deadOwner = deadOwners.get(token);
            if (!deadOwner || !sameDevTrajectoryRecoveryOwner(deadOwner, owner))
              continue;
            deadOwners.delete(token);
            knownOwners.delete(token);
          }
          request.acknowledged = true;
        }
        send({
          type: "eliza:trajectory-recovery:acknowledged",
          version: DEV_TRAJECTORY_RECOVERY_VERSION,
          requestId: message.requestId,
          recoveryBatchId: message.recoveryBatchId,
        });
      }

      child.on("message", onMessage);
      child.once("exit", () => {
        exited = true;
        child.off("message", onMessage);
        for (const [token, owner] of owners) deadOwners.set(token, owner);
      });
    },
  };
}
