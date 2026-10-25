/**
 * Client half of the private restore-v3 probe socket. Kept free of runtime,
 * filesystem-authority and generation imports so the one-shot probe relay
 * loads only framing, the serving contract and node:net.
 */

import { Buffer } from "node:buffer";
import net from "node:net";
import type {
  AgentBackupRestoreV3Attestation,
  AgentBackupRestoreV3ProbeRequest,
} from "@elizaos/contracts/node";
import {
  AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS,
  AgentBackupRestoreV3AttestationSchema,
  AgentBackupRestoreV3ProbeRequestSchema,
  canonicalizeAgentBackupRestoreV3ServingValue,
} from "@elizaos/contracts/node";
import { servingError } from "./agent-backup-restore-v3-serving-wire";

export const AGENT_BACKUP_RESTORE_V3_PROBE_TIMEOUT_MS = 10_000;

/**
 * Sends one probe to the runtime socket and returns the schema-valid
 * attestation bound to the same attempt and nonce. The MAC is verified by the
 * coordinator, which alone holds the token outside this runtime.
 */
export async function requestAgentBackupRestoreV3Probe(
  socketPath: string,
  request: AgentBackupRestoreV3ProbeRequest,
  timeoutMs = AGENT_BACKUP_RESTORE_V3_PROBE_TIMEOUT_MS,
): Promise<AgentBackupRestoreV3Attestation> {
  const parsedRequest = AgentBackupRestoreV3ProbeRequestSchema.parse(request);
  const line = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(socketPath);
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const fail = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(servingError("PROBE_FAILED", cause));
    };
    const timer = setTimeout(() => fail(), timeoutMs);
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(
        `${canonicalizeAgentBackupRestoreV3ServingValue(parsedRequest)}\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS.responseBytes)
        return fail();
      chunks.push(chunk);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (settled) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1)
        return fail();
      settled = true;
      resolve(text.slice(0, -1));
    });
  });
  let attestation: AgentBackupRestoreV3Attestation;
  try {
    attestation = AgentBackupRestoreV3AttestationSchema.parse(JSON.parse(line));
  } catch (cause) {
    throw servingError("PROBE_FAILED", cause);
  }
  if (
    attestation.body.restoreAttemptId !== parsedRequest.restoreAttemptId ||
    attestation.body.nonce !== parsedRequest.nonce
  )
    throw servingError("PROBE_FAILED");
  return attestation;
}
