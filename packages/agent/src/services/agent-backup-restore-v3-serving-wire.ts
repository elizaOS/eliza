/**
 * Private stdin/stdout framing shared by the restore-v3 serving entrypoints.
 * One frame is a 4-byte big-endian length plus UTF-8 JSON. Reading stops after
 * that frame without closing stdin, so the caller keeps the pipe as the
 * operation's liveness channel. Paths are derived from the attempt id only;
 * a test data root is accepted solely under NODE_ENV=test.
 */

import { Buffer } from "node:buffer";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AgentBackupRestoreV3ContainerRoots } from "@elizaos/contracts/node";
import {
  AGENT_BACKUP_RESTORE_V3_CONTAINER_DATA_ROOT,
  agentBackupRestoreV3ContainerRoots,
} from "@elizaos/contracts/node";
import { ElizaError } from "@elizaos/core";

export function servingError(code: string, cause?: unknown): ElizaError {
  return new ElizaError("Restore serving operation did not complete", {
    code: `AGENT_BACKUP_RESTORE_V3_SERVING_${code}`,
    severity: "fatal",
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Reads exactly one length-prefixed JSON frame. Oversize or malformed input is
 * rejected, never truncated. Every ingress buffer is zeroed after use.
 */
export async function readServingFrame(
  input: Readable,
  maximumBytes: number,
): Promise<unknown> {
  const prefix = Buffer.alloc(4);
  let prefixBytes = 0;
  let body: Buffer | undefined;
  let bodyBytes = 0;
  try {
    for await (const value of input.iterator({ destroyOnReturn: false })) {
      if (!Buffer.isBuffer(value)) throw servingError("INPUT_INVALID");
      try {
        let offset = 0;
        while (offset < value.length) {
          if (prefixBytes < 4) {
            const count = Math.min(4 - prefixBytes, value.length - offset);
            value.copy(prefix, prefixBytes, offset, offset + count);
            prefixBytes += count;
            offset += count;
            if (prefixBytes === 4) {
              const length = prefix.readUInt32BE();
              if (length === 0 || length > maximumBytes)
                throw servingError("INPUT_INVALID");
              body = Buffer.alloc(length);
            }
          } else if (body && bodyBytes < body.length) {
            const count = Math.min(
              body.length - bodyBytes,
              value.length - offset,
            );
            value.copy(body, bodyBytes, offset, offset + count);
            bodyBytes += count;
            offset += count;
          } else {
            // Bytes after the frame are forbidden trailing input.
            throw servingError("INPUT_INVALID");
          }
        }
      } finally {
        value.fill(0);
      }
      if (body && bodyBytes === body.length) {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        );
      }
    }
    throw servingError("INPUT_INVALID");
  } catch (cause) {
    // error-policy:J1 Never expose private request bytes or parser diagnostics.
    throw servingError("INPUT_INVALID", cause);
  } finally {
    prefix.fill(0);
    body?.fill(0);
  }
}

export function encodeServingFrame(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

export async function writeServingOutput(
  output: Writable,
  text: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    output.write(text, (error) =>
      error ? reject(servingError("OUTPUT_FAILED", error)) : resolve(),
    ),
  );
}

export interface ServingEntrypointOptions {
  /** Test-only pathname emulation for the candidate filesystem on non-Linux. */
  readonly testOnlyAllowNonLinuxFdEmulation: boolean;
  /** Test-only replacement for the fixed container data root. */
  readonly testOnlyDataRoot?: string;
}

/**
 * Production invocations take no arguments. Test flags are honored only with
 * NODE_ENV=test, which `env -i` production invocations cannot carry.
 */
export function parseServingEntrypointArguments(
  args: readonly string[],
): ServingEntrypointOptions {
  let emulate = false;
  let dataRoot: string | undefined;
  for (const arg of args) {
    if (process.env.NODE_ENV !== "test") throw servingError("INPUT_INVALID");
    if (
      arg === "--test-only-non-linux-fs" &&
      !emulate &&
      process.platform !== "linux"
    ) {
      emulate = true;
    } else if (arg.startsWith("--test-only-data-root=") && !dataRoot) {
      const value = arg.slice("--test-only-data-root=".length);
      if (!path.isAbsolute(value) || path.resolve(value) !== value)
        throw servingError("INPUT_INVALID");
      dataRoot = value;
    } else {
      throw servingError("INPUT_INVALID");
    }
  }
  return Object.freeze({
    testOnlyAllowNonLinuxFdEmulation: emulate,
    ...(dataRoot ? { testOnlyDataRoot: dataRoot } : {}),
  });
}

/** Deterministic roots, optionally re-anchored under a test-owned data root. */
export function resolveServingRoots(
  restoreAttemptId: string,
  testOnlyDataRoot?: string,
): AgentBackupRestoreV3ContainerRoots {
  const roots = agentBackupRestoreV3ContainerRoots(restoreAttemptId);
  if (testOnlyDataRoot === undefined) return roots;
  if (process.env.NODE_ENV !== "test") throw servingError("INPUT_INVALID");
  const rebase = (value: string) =>
    path.join(
      testOnlyDataRoot,
      path.relative(AGENT_BACKUP_RESTORE_V3_CONTAINER_DATA_ROOT, value),
    );
  return Object.freeze({
    trustedRoot: rebase(roots.trustedRoot),
    attemptRoot: rebase(roots.attemptRoot),
    generationTrustedRoot: rebase(roots.generationTrustedRoot),
    generationRoot: rebase(roots.generationRoot),
    runtimeRoot: rebase(roots.runtimeRoot),
  });
}

/** Parent of the per-attempt roots; the only directory level not created privately. */
export function servingDataRoot(roots: AgentBackupRestoreV3ContainerRoots) {
  return path.dirname(path.dirname(path.dirname(roots.trustedRoot)));
}

export const RESTORE_V3_BOOT_GRANT_FILE = ".restore-v3-boot-grant.json";
export const RESTORE_V3_BOOT_GRANT_CONSUMED_FILE =
  ".restore-v3-boot-grant-consumed.json";
export const RESTORE_V3_RUNTIME_LOCK_FILE = ".restore-v3-runtime.lock";
export const RESTORE_V3_PROBE_SOCKET_FILE = ".restore-v3-probe.sock";
