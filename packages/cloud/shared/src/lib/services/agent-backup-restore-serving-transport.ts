/**
 * SSH transport for the post-create restore effects on one exact container.
 * The locator comes only from the durable provider-settled replacement row;
 * every command is boot-fenced to the reserved node incarnation and re-proves
 * the container's immutable create-time fingerprint before acting.
 */

import { Buffer } from "node:buffer";
import {
  AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS,
  type AgentBackupRestoreV3Attestation,
  AgentBackupRestoreV3AttestationSchema,
  type AgentBackupRestoreV3ControllerRequest,
  type AgentBackupRestoreV3ControllerResponse,
  AgentBackupRestoreV3ControllerResponseSchema,
  type AgentBackupRestoreV3ProbeRequest,
} from "@elizaos/contracts/node";
import { ElizaError } from "@elizaos/core";
import type { AgentBackupRestoreContainerAuthority } from "../../db/repositories/agent-backup-restore-serving";
import {
  buildExactRestoreControllerCommand,
  buildExactRestoreServingAttachCommand,
  buildExactRestoreServingLaunchCommand,
  buildExactRestoreServingProbeCommand,
  buildExactRestoreServingStopCommand,
  type ExactRestoreQuarantineCommandInput,
  parseExactRestoreServingPorts,
} from "./docker-sandbox-provider";
import { DockerSSHClient } from "./docker-ssh";

const CONTROLLER_TIMEOUT_MS = 15 * 60_000;
const ATTACH_TIMEOUT_MS = 3 * 60_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 2 * 60_000;

export interface AgentBackupRestoreContainerTransport {
  controller(
    request: AgentBackupRestoreV3ControllerRequest,
    phase: "quarantine" | "serving",
  ): Promise<AgentBackupRestoreV3ControllerResponse>;
  attach(): Promise<Readonly<{ bridgePort: number; webUiPort: number; containerPort: number }>>;
  launch(): Promise<void>;
  probe(request: AgentBackupRestoreV3ProbeRequest): Promise<AgentBackupRestoreV3Attestation>;
  stop(): Promise<void>;
}

function transportError(code: string, message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, { code, cause, severity: "ephemeral" });
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS.requestBytes) {
    throw transportError(
      "AGENT_BACKUP_RESTORE_SERVING_REQUEST_TOO_LARGE",
      "Restore controller request exceeds its frame limit",
    );
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.byteLength);
  return Buffer.concat([prefix, body]);
}

function singleJsonLine(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS.responseBytes) {
    throw transportError(
      "AGENT_BACKUP_RESTORE_SERVING_RESPONSE_TOO_LARGE",
      "Restore container response exceeds its limit",
    );
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw transportError(
      "AGENT_BACKUP_RESTORE_SERVING_RESPONSE_INVALID",
      "Restore container returned a non-canonical response",
    );
  }
  try {
    return JSON.parse(lines[0]!);
  } catch (cause) {
    throw transportError(
      "AGENT_BACKUP_RESTORE_SERVING_RESPONSE_INVALID",
      "Restore container returned malformed JSON",
      cause,
    );
  }
}

/** Build the exact command input from the durable operation authority. */
export function exactRestoreCommandInputFromAuthority(
  authority: Readonly<AgentBackupRestoreContainerAuthority>,
): ExactRestoreQuarantineCommandInput {
  const { operation } = authority;
  const platform = operation.expected_image_platform;
  if (
    !operation.expected_image_reference ||
    !operation.expected_image_platform_digest ||
    !operation.expected_image_digest ||
    (platform !== "linux/amd64" && platform !== "linux/arm64")
  ) {
    throw new ElizaError("Restore operation lacks exact image authority", {
      code: "AGENT_BACKUP_RESTORE_SERVING_IMAGE_AUTHORITY_INCOMPLETE",
      severity: "fatal",
    });
  }
  return Object.freeze({
    agentId: operation.agent_id,
    replacementAttemptId: authority.replacementAttemptId,
    containerId: authority.containerId,
    exactRestore: Object.freeze({
      restoreAttemptId: operation.restore_attempt_id,
      target: Object.freeze({
        nodeRecordId: authority.node.nodeRecordId,
        nodeId: authority.node.nodeId,
        nodeIncarnation: authority.node.nodeIncarnation,
        nodeHistoryId: authority.node.nodeHistoryId,
        platform,
      }),
      imageReference: operation.expected_image_reference,
      imageDigest: operation.expected_image_digest,
      imagePlatformDigest: operation.expected_image_platform_digest,
      quarantine: true as const,
    }),
  });
}

/** Production transport: one dedicated, host-key-pinned SSH session per effect. */
export function createDockerAgentBackupRestoreContainerTransport(
  authority: Readonly<AgentBackupRestoreContainerAuthority>,
): AgentBackupRestoreContainerTransport {
  const input = exactRestoreCommandInputFromAuthority(authority);
  const withSsh = async <T>(use: (ssh: DockerSSHClient) => Promise<T>): Promise<T> => {
    const ssh = DockerSSHClient.createDedicated(
      authority.node.hostname,
      authority.node.sshPort,
      authority.node.hostKeyFingerprint,
      authority.node.sshUser,
    );
    try {
      return await use(ssh);
    } finally {
      await ssh.disconnect();
    }
  };
  const transport: AgentBackupRestoreContainerTransport = {
    async controller(request, phase) {
      const payload = frame(request);
      try {
        const raw = await withSsh((ssh) =>
          // The controller treats stdin EOF as cancellation, so stdin stays
          // open until it answers.
          ssh.execStdinForResponse(
            buildExactRestoreControllerCommand(input, phase),
            payload,
            new AbortController().signal,
            CONTROLLER_TIMEOUT_MS,
            AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS.responseBytes,
          ),
        );
        const response = AgentBackupRestoreV3ControllerResponseSchema.parse(singleJsonLine(raw));
        if (response.method !== request.method) {
          throw transportError(
            "AGENT_BACKUP_RESTORE_SERVING_RESPONSE_INVALID",
            "Restore controller answered a different method",
          );
        }
        return response;
      } finally {
        // The boot grant carries the activation token; never retain it.
        payload.fill(0);
      }
    },
    async attach() {
      const raw = await withSsh((ssh) =>
        ssh.exec(buildExactRestoreServingAttachCommand(input), ATTACH_TIMEOUT_MS),
      );
      return parseExactRestoreServingPorts(raw);
    },
    async launch() {
      const { command, receiptDigest } = buildExactRestoreServingLaunchCommand(input);
      const raw = await withSsh((ssh) => ssh.exec(command, LAUNCH_TIMEOUT_MS));
      if (raw.trim() !== receiptDigest) {
        throw transportError(
          "AGENT_BACKUP_RESTORE_SERVING_LAUNCH_UNPROVEN",
          "Restore runtime launch did not return its exact receipt",
        );
      }
    },
    async probe(request) {
      const raw = await withSsh((ssh) =>
        ssh.execStdinForResponse(
          buildExactRestoreServingProbeCommand(input),
          frame(request),
          new AbortController().signal,
          PROBE_TIMEOUT_MS,
          AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS.responseBytes,
        ),
      );
      return AgentBackupRestoreV3AttestationSchema.parse(singleJsonLine(raw));
    },
    async stop() {
      const { command, receiptDigest } = buildExactRestoreServingStopCommand(input);
      const raw = await withSsh((ssh) => ssh.exec(command, STOP_TIMEOUT_MS));
      if (raw.trim() !== receiptDigest) {
        throw transportError(
          "AGENT_BACKUP_RESTORE_SERVING_STOP_UNPROVEN",
          "Restore container stop did not return its exact receipt",
        );
      }
    },
  };
  return Object.freeze(transport);
}
