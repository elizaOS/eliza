/**
 * Exchanges development diagnostic ownership with the actual parent IPC
 * channel. Requests fail closed on disconnect or timeout; no environment
 * value grants authority to settle database records.
 */
import { randomUUID } from "node:crypto";
import {
  DEV_TRAJECTORY_RECOVERY_VERSION,
  type DevTrajectoryRecoveryChildMessage,
  type DevTrajectoryRecoveryOwner,
  type DevTrajectoryRecoveryParentMessage,
  parseDevTrajectoryRecoveryParentMessage,
  sameDevTrajectoryRecoveryOwner,
} from "@elizaos/agent/runtime/dev-trajectory-recovery-protocol";

interface PendingRequest {
  type: DevTrajectoryRecoveryParentMessage["type"];
  resolve: (message: DevTrajectoryRecoveryParentMessage) => void;
  reject: (error: Error) => void;
}

interface DevTrajectoryRecoveryIpc {
  registerOwner(owner: DevTrajectoryRecoveryOwner): Promise<{
    owner: DevTrajectoryRecoveryOwner;
    recoveryBatchId: string;
    owners: DevTrajectoryRecoveryOwner[];
  }>;
  acknowledgeRecovery(recoveryBatchId: string): Promise<void>;
  close(): void;
}

export function createDevTrajectoryRecoveryIpc(
  channel: NodeJS.Process = process,
  timeoutMs = 10_000,
): DevTrajectoryRecoveryIpc {
  const pending = new Map<string, PendingRequest>();
  const batchRequests = new Map<string, string>();
  let disconnected = !channel.connected || typeof channel.send !== "function";

  function onMessage(raw: unknown): void {
    const message = parseDevTrajectoryRecoveryParentMessage(raw);
    if (!message) return;
    const request = pending.get(message.requestId);
    if (!request) return;
    if (message.type === "eliza:trajectory-recovery:rejected") {
      request.reject(
        new Error(`Trajectory recovery rejected: ${message.reason}`),
      );
    } else if (message.type === request.type) {
      request.resolve(message);
    }
  }

  function onDisconnect(): void {
    disconnected = true;
    for (const request of pending.values()) {
      request.reject(new Error("Trajectory recovery parent disconnected"));
    }
  }
  channel.on("message", onMessage);
  channel.once("disconnect", onDisconnect);

  async function exchange(
    message: DevTrajectoryRecoveryChildMessage,
    type: DevTrajectoryRecoveryParentMessage["type"],
  ): Promise<DevTrajectoryRecoveryParentMessage> {
    if (disconnected || !channel.connected || !channel.send) {
      throw new Error(
        "Trajectory recovery requires a connected parent IPC channel",
      );
    }
    if (pending.has(message.requestId))
      throw new Error("Trajectory recovery request is already pending");
    const send = channel.send.bind(channel);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.requestId);
        reject(
          new Error("Trajectory recovery parent acknowledgement timed out"),
        );
      }, timeoutMs);
      const finish = (complete: () => void) => {
        clearTimeout(timer);
        pending.delete(message.requestId);
        complete();
      };
      pending.set(message.requestId, {
        type,
        resolve: (reply) => finish(() => resolve(reply)),
        reject: (error) => finish(() => reject(error)),
      });
      try {
        send(message, (error: Error | null) => {
          if (error) pending.get(message.requestId)?.reject(error);
        });
      } catch (error) {
        // error-policy:J2 Preserve IPC failure while rejecting the boot gate.
        pending
          .get(message.requestId)
          ?.reject(
            new Error("Trajectory recovery IPC send failed", { cause: error }),
          );
      }
    });
  }

  return {
    async registerOwner(owner: DevTrajectoryRecoveryOwner) {
      const requestId = randomUUID();
      const response = await exchange(
        {
          type: "eliza:trajectory-recovery:register",
          version: DEV_TRAJECTORY_RECOVERY_VERSION,
          requestId,
          owner,
        },
        "eliza:trajectory-recovery:registered",
      );
      if (
        response.type !== "eliza:trajectory-recovery:registered" ||
        !sameDevTrajectoryRecoveryOwner(response.owner, owner)
      ) {
        throw new Error(
          "Trajectory recovery registration does not match this runtime",
        );
      }
      batchRequests.set(response.recoveryBatchId, requestId);
      return response;
    },
    async acknowledgeRecovery(recoveryBatchId: string): Promise<void> {
      const requestId = batchRequests.get(recoveryBatchId);
      if (!requestId)
        throw new Error(
          "Trajectory recovery batch was not registered by this runtime",
        );
      const response = await exchange(
        {
          type: "eliza:trajectory-recovery:recovered",
          version: DEV_TRAJECTORY_RECOVERY_VERSION,
          requestId,
          recoveryBatchId,
        },
        "eliza:trajectory-recovery:acknowledged",
      );
      if (
        response.type !== "eliza:trajectory-recovery:acknowledged" ||
        response.recoveryBatchId !== recoveryBatchId
      ) {
        throw new Error(
          "Trajectory recovery acknowledgement does not match the batch",
        );
      }
      batchRequests.delete(recoveryBatchId);
    },
    close(): void {
      onDisconnect();
      channel.off("message", onMessage);
      channel.off("disconnect", onDisconnect);
    },
  };
}
