/**
 * Process-local authority for serving one committed restore-v3 generation:
 * the exclusive runtime lock, one-shot boot-grant consumption, reopening the
 * committed generation from the grant identities, and the private unix-socket
 * probe that answers with an attestation signed under the in-memory token.
 * Nothing here publishes routes; the coordinator verifies the attestation.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, lstatSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/contracts";
import type {
  AgentBackupRestoreV3Attestation,
  AgentBackupRestoreV3BootGrant,
  AgentBackupRestoreV3ContainerRoots,
  AgentBackupRestoreV3ProbeRequest,
} from "@elizaos/contracts/node";
import {
  AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS,
  AgentBackupRestoreV3BootGrantSchema,
  AgentBackupRestoreV3ProbeRequestSchema,
  agentBackupRestoreV3TokenSha256,
  canonicalizeAgentBackupRestoreV3ServingValue,
  signAgentBackupRestoreV3Attestation,
} from "@elizaos/contracts/node";
import { logger } from "@elizaos/core";
import { openAgentBackupRestoreV3CandidateFs } from "./agent-backup-restore-v3-candidate-fs";
import type { AgentBackupRestoreV3PreparedGenerationReceipt } from "./agent-backup-restore-v3-generation";
import { AgentBackupRestoreV3RuntimeGeneration } from "./agent-backup-restore-v3-runtime-generation";
import { consumedGrantRecord } from "./agent-backup-restore-v3-serving-controller";
import {
  inspectPrivateDirectory,
  readPrivateFile,
  sameServingIdentity,
  unlinkPrivateFile,
  writePrivateFileAtomic,
} from "./agent-backup-restore-v3-serving-files";
import { AGENT_BACKUP_RESTORE_V3_PROBE_TIMEOUT_MS } from "./agent-backup-restore-v3-serving-probe";
import {
  RESTORE_V3_BOOT_GRANT_CONSUMED_FILE,
  RESTORE_V3_BOOT_GRANT_FILE,
  RESTORE_V3_PROBE_SOCKET_FILE,
  RESTORE_V3_RUNTIME_LOCK_FILE,
  servingError,
} from "./agent-backup-restore-v3-serving-wire";

/** Probe lines are tiny; anything larger is rejected, never truncated. */
const PROBE_REQUEST_MAX_BYTES = 1024;

function isErrno(cause: unknown, code: string): boolean {
  return (
    cause instanceof Error && (cause as NodeJS.ErrnoException).code === code
  );
}

export interface AgentBackupRestoreV3RuntimeLock {
  readonly path: string;
  release(): Promise<void>;
  /** Synchronous variant for process `exit` handlers. */
  releaseSync(): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // error-policy:J3 ESRCH is the only proof the holder is gone; EPERM means alive.
    return !isErrno(cause, "ESRCH");
  }
}

/**
 * Exclusive O_EXCL lock so a committed generation is never booted twice.
 * A lock whose recorded pid is dead is stale and replaced exactly once.
 */
export async function acquireAgentBackupRestoreV3RuntimeLock(
  runtimeRoot: string,
): Promise<AgentBackupRestoreV3RuntimeLock> {
  await inspectPrivateDirectory(runtimeRoot);
  const lockPath = path.join(runtimeRoot, RESTORE_V3_RUNTIME_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        lockPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (cause) {
      if (!isErrno(cause, "EEXIST")) throw servingError("LOCK_FAILED", cause);
      const existing = await fs.lstat(lockPath, { bigint: true });
      const bytes = await readPrivateFile(
        runtimeRoot,
        RESTORE_V3_RUNTIME_LOCK_FILE,
        32,
      );
      const match = bytes
        ? /^([1-9][0-9]{0,9})\n$/.exec(bytes.toString("utf8"))
        : null;
      const holder = match ? Number(match[1]) : 0;
      // A partially written lock may belong to a concurrent boot: fail closed.
      if (!holder || holder === process.pid || processAlive(holder))
        throw servingError("RUNTIME_LOCKED");
      const current = await fs.lstat(lockPath, { bigint: true });
      if (current.ino !== existing.ino || current.dev !== existing.dev)
        throw servingError("RUNTIME_LOCKED");
      await unlinkPrivateFile(runtimeRoot, RESTORE_V3_RUNTIME_LOCK_FILE);
      continue;
    }
    let identity: { dev: bigint; ino: bigint };
    try {
      await handle.chmod(0o600);
      await handle.write(`${process.pid}\n`);
      await handle.sync();
      identity = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    const owned = () => {
      try {
        const current = lstatSync(lockPath, { bigint: true });
        return current.dev === identity.dev && current.ino === identity.ino;
      } catch {
        // error-policy:J3 A vanished lock has nothing left to release.
        return false;
      }
    };
    let released = false;
    return Object.freeze({
      path: lockPath,
      async release() {
        if (released) return;
        released = true;
        if (owned())
          await unlinkPrivateFile(runtimeRoot, RESTORE_V3_RUNTIME_LOCK_FILE);
      },
      releaseSync() {
        if (released) return;
        released = true;
        if (owned()) unlinkSync(lockPath);
      },
    });
  }
  throw servingError("RUNTIME_LOCKED");
}

export type AgentBackupRestoreV3ConsumedGrant = Readonly<
  Omit<AgentBackupRestoreV3BootGrant, "token">
>;

export interface AgentBackupRestoreV3ConsumedBootGrant {
  readonly grant: AgentBackupRestoreV3ConsumedGrant;
  readonly grantSha256: string;
  /** UTF-8 bytes of the base64url token; the owner zeroes it on exit. */
  readonly token: Buffer;
}

/**
 * Reads, records and unlinks the one-shot boot grant. The consumption record
 * is durable before the grant disappears, so the controller can distinguish a
 * consumed grant from a missing one and never accepts a replacement.
 */
export async function consumeAgentBackupRestoreV3BootGrant(
  runtimeRoot: string,
  restoreAttemptId: string,
): Promise<AgentBackupRestoreV3ConsumedBootGrant> {
  await inspectPrivateDirectory(runtimeRoot);
  const bytes = await readPrivateFile(
    runtimeRoot,
    RESTORE_V3_BOOT_GRANT_FILE,
    AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS.requestBytes,
  );
  if (!bytes) throw servingError("GRANT_MISSING");
  let parsed: AgentBackupRestoreV3BootGrant;
  let grantSha256: string;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = AgentBackupRestoreV3BootGrantSchema.parse(JSON.parse(text));
    if (
      canonicalizeAgentBackupRestoreV3ServingValue(parsed) !== text ||
      parsed.restoreAttemptId !== restoreAttemptId ||
      agentBackupRestoreV3TokenSha256(parsed.token) !== parsed.tokenSha256
    )
      throw servingError("GRANT_INVALID");
    grantSha256 = createHash("sha256").update(bytes).digest("hex");
  } catch (cause) {
    // error-policy:J1 Grant contents carry the token and never reach diagnostics.
    throw servingError("GRANT_INVALID", cause);
  } finally {
    bytes.fill(0);
  }
  await writePrivateFileAtomic(
    runtimeRoot,
    RESTORE_V3_BOOT_GRANT_CONSUMED_FILE,
    Buffer.from(consumedGrantRecord(grantSha256), "utf8"),
  );
  await unlinkPrivateFile(runtimeRoot, RESTORE_V3_BOOT_GRANT_FILE);
  const { token, ...grant } = parsed;
  return Object.freeze({
    grant: Object.freeze(grant),
    grantSha256,
    token: Buffer.from(token, "utf8"),
  });
}

/**
 * Reopens the committed generation from the grant's recorded identities and
 * binds startup to it. The generation filesystem is only needed for the
 * committed-receipt verification and is closed before returning.
 */
export async function openAgentBackupRestoreV3GrantedGeneration(input: {
  readonly roots: AgentBackupRestoreV3ContainerRoots;
  readonly grant: AgentBackupRestoreV3ConsumedGrant;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  readonly testOnlyAllowNonLinuxFdEmulation?: boolean;
}): Promise<AgentBackupRestoreV3RuntimeGeneration> {
  const { roots, grant, control } = input;
  const handoff = grant.generation;
  if (
    !sameServingIdentity(
      await inspectPrivateDirectory(roots.runtimeRoot),
      handoff.runtimeRootIdentity,
    )
  )
    throw servingError("ROOT_CHANGED");
  const generationFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot: roots.generationTrustedRoot,
    attemptRoot: roots.generationRoot,
    control,
    ...(input.testOnlyAllowNonLinuxFdEmulation
      ? { testOnlyAllowNonLinuxFdEmulation: true as const }
      : {}),
  });
  let authority: AgentBackupRestoreV3RuntimeGeneration | undefined;
  try {
    if (
      !sameServingIdentity(
        generationFs.trustedRootIdentity,
        handoff.generationTrustedRootIdentity,
      ) ||
      !sameServingIdentity(
        generationFs.attemptRootIdentity,
        handoff.generationRootIdentity,
      ) ||
      handoff.preparedReceipt.receiptSha256 !== handoff.preparedReceiptSha256
    )
      throw servingError("ROOT_CHANGED");
    authority = await AgentBackupRestoreV3RuntimeGeneration.open(
      {
        generationFs,
        preparedReceipt:
          handoff.preparedReceipt as unknown as AgentBackupRestoreV3PreparedGenerationReceipt,
        runtimeRoot: roots.runtimeRoot,
        runtimeRootIdentity: handoff.runtimeRootIdentity,
        control,
      },
      grant.agentId,
    );
    if (
      authority.receipt.receiptSha256 !== handoff.committedReceiptSha256 ||
      authority.receipt.preparedReceiptSha256 !== handoff.preparedReceiptSha256
    )
      throw servingError("RECEIPT_CONFLICT");
    const result = authority;
    authority = undefined;
    return result;
  } finally {
    await authority?.close();
    await generationFs.close();
  }
}

export interface AgentBackupRestoreV3LiveRuntimeFacts {
  readonly listenPort: number;
  readonly characterName: string;
}

/** Signs the runtime attestation for one probe nonce under the grant token. */
export function buildAgentBackupRestoreV3RuntimeAttestation(
  grant: AgentBackupRestoreV3ConsumedGrant,
  token: Buffer,
  nonce: string,
  facts: AgentBackupRestoreV3LiveRuntimeFacts,
): AgentBackupRestoreV3Attestation {
  return signAgentBackupRestoreV3Attestation(token.toString("utf8"), {
    version: 1,
    format: "elizaos.agent-backup.restore-v3-runtime-attestation.v1",
    agentId: grant.agentId,
    organizationId: grant.organizationId,
    restoreAttemptId: grant.restoreAttemptId,
    containerId: grant.containerId,
    nodeIncarnation: grant.nodeIncarnation,
    committedReceiptSha256: grant.generation.committedReceiptSha256,
    tokenSha256: grant.tokenSha256,
    nonce,
    runtimeReady: true,
    listenPort: facts.listenPort,
    characterName: facts.characterName,
  });
}

/** Resolves true only when a TCP connection to the local port completes. */
export async function isAgentBackupRestoreV3PortListening(
  port: number,
  timeoutMs = 2_000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface AgentBackupRestoreV3ProbeServer {
  readonly socketPath: string;
  close(): Promise<void>;
  closeSync(): void;
}

/**
 * Listens on the private probe socket. Each connection carries one probe line
 * and receives one attestation line, or is closed without an answer when
 * `answer` declines (runtime not alive or identity mismatch) or input is bad.
 */
export async function startAgentBackupRestoreV3ProbeServer(input: {
  readonly runtimeRoot: string;
  readonly restoreAttemptId: string;
  readonly answer: (
    request: AgentBackupRestoreV3ProbeRequest,
  ) => Promise<AgentBackupRestoreV3Attestation | null>;
}): Promise<AgentBackupRestoreV3ProbeServer> {
  await inspectPrivateDirectory(input.runtimeRoot);
  const socketPath = path.join(input.runtimeRoot, RESTORE_V3_PROBE_SOCKET_FILE);
  try {
    const stale = await fs.lstat(socketPath);
    // Only this lock holder may own the socket; a stale one is replaced.
    if (!stale.isSocket() || stale.uid !== process.getuid?.())
      throw servingError("SOCKET_UNSAFE");
    await fs.unlink(socketPath);
  } catch (cause) {
    if (!isErrno(cause, "ENOENT")) throw servingError("SOCKET_UNSAFE", cause);
  }
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let handled = false;
    const reject = () => {
      handled = true;
      for (const chunk of chunks) chunk.fill(0);
      socket.destroy();
    };
    socket.setTimeout(AGENT_BACKUP_RESTORE_V3_PROBE_TIMEOUT_MS, reject);
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      const newline = chunk.indexOf(0x0a);
      received += newline === -1 ? chunk.length : newline;
      if (received > PROBE_REQUEST_MAX_BYTES) return reject();
      if (newline === -1) {
        chunks.push(Buffer.from(chunk));
        return;
      }
      if (newline !== chunk.length - 1) return reject();
      chunks.push(Buffer.from(chunk.subarray(0, newline)));
      handled = true;
      socket.pause();
      let request: AgentBackupRestoreV3ProbeRequest;
      try {
        request = AgentBackupRestoreV3ProbeRequestSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ),
        );
        if (request.restoreAttemptId !== input.restoreAttemptId)
          return reject();
      } catch {
        // error-policy:J1 Malformed probes are closed without an answer.
        return reject();
      }
      input
        .answer(request)
        .then((attestation) => {
          if (!attestation || socket.destroyed) return reject();
          socket.end(
            `${canonicalizeAgentBackupRestoreV3ServingValue(attestation)}\n`,
          );
        })
        .catch((cause: unknown) => {
          // error-policy:J1 The probe fails closed; only the code is logged.
          logger.warn(
            {
              src: "agent-backup-restore-v3",
              code: (cause as { code?: unknown })?.code,
            },
            "Restore probe declined after a liveness check failed",
          );
          reject();
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    await fs.chmod(socketPath, 0o600);
  } catch (cause) {
    server.close();
    throw servingError("SOCKET_UNSAFE", cause);
  }
  let closed = false;
  const unlinkSocket = () => {
    try {
      unlinkSync(socketPath);
    } catch {
      // error-policy:J3 An already removed socket is the desired end state.
    }
  };
  return Object.freeze({
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      unlinkSocket();
    },
    closeSync() {
      if (closed) return;
      closed = true;
      server.close();
      unlinkSocket();
    },
  });
}
