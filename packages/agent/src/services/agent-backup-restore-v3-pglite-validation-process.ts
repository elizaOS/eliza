/**
 * Runs and reaps an isolated PGlite validation lifecycle before releasing its
 * caller's quarantine lock. Only a private scratch copy may be passed here.
 * Credentials and process options are not inherited; diagnostics are discarded.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import { AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_DIRECTORY } from "./agent-backup-restore-v3-candidate-database";
import {
  type AgentBackupRestoreV3CandidateFs,
  type AgentBackupRestoreV3CandidateFsLock,
  type AgentBackupRestoreV3CandidateTreeProof,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { snapshotOperationControl } from "./agent-backup-restore-v3-candidate-fs-control";
import { AgentBackupRestoreV3PgliteArchiveError } from "./agent-backup-restore-v3-pglite-archive";

export function runAgentBackupRestoreV3PgliteValidationProcess(input: {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly heldLock: AgentBackupRestoreV3CandidateFsLock;
  readonly copyTree: Readonly<AgentBackupRestoreV3CandidateTreeProof>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
}): Promise<Readonly<{ serverVersion: string }>> {
  const control = snapshotOperationControl(input.control);
  const candidateFs = input.candidateFs;
  if (!isAgentBackupRestoreV3CandidateFs(candidateFs))
    throw new AgentBackupRestoreV3PgliteArchiveError(
      "INPUT_INVALID",
      "Validation requires a real candidate filesystem authority",
    );
  const expected = {
    dataDirectory: path.join(
      candidateFs.attemptRoot,
      AGENT_BACKUP_RESTORE_V3_DATABASE_VALIDATION_DIRECTORY,
    ),
    device: input.copyTree.device,
    inode: input.copyTree.inode,
    lockDevice: candidateFs.attemptRootIdentity.device,
    lockInode: candidateFs.attemptRootIdentity.inode,
  };
  return candidateFs.withInheritedLockDescriptor(
    input.heldLock,
    (descriptor) => runWorker(expected, descriptor, control),
    control,
  );
}

async function runWorker(
  expected: Readonly<{
    dataDirectory: string;
    device: string;
    inode: string;
    lockDevice: string;
    lockInode: string;
  }>,
  inheritedLockDescriptor: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<Readonly<{ serverVersion: string }>> {
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./agent-backup-restore-v3-pglite-validation-worker.ts"
        : "./agent-backup-restore-v3-pglite-validation-worker.js",
      import.meta.url,
    ),
  );
  // fd 3 is the parent-liveness pipe; fd 4 retains the exact kernel flock.
  const child = spawn(process.execPath, [worker], {
    stdio: ["pipe", "pipe", "pipe", "pipe", inheritedLockDescriptor],
    env: {},
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    throw new AgentBackupRestoreV3PgliteArchiveError(
      "VALIDATION_PROCESS_FAILED",
      "Validation process pipes are unavailable",
    );
  }
  let failure: Error | undefined;
  const output = Buffer.alloc(4096);
  let outputBytes = 0;
  const fail = (code: string) => {
    failure ??= new AgentBackupRestoreV3PgliteArchiveError(
      code,
      "Isolated PGlite validation failed; no database diagnostics were exposed",
    );
    child.kill("SIGKILL");
  };
  const abort = () => fail("VALIDATION_INTERRUPTED");
  const timeout = setTimeout(
    abort,
    Math.min(2_147_483_647, Math.max(1, control.deadlineEpochMs - Date.now())),
  );
  control.signal.addEventListener("abort", abort, { once: true });
  child.on("error", () => fail("VALIDATION_PROCESS_FAILED"));
  child.stdin.on("error", () => fail("VALIDATION_INPUT_FAILED"));
  child.stdout.on("error", () => fail("VALIDATION_OUTPUT_INVALID"));
  child.stderr.on("error", () => fail("VALIDATION_PROCESS_FAILED"));
  child.stdout.on("data", (chunk: Buffer) => {
    if (chunk.length > output.length - outputBytes) {
      chunk.fill(0);
      fail("VALIDATION_OUTPUT_INVALID");
      return;
    }
    chunk.copy(output, outputBytes);
    outputBytes += chunk.length;
    chunk.fill(0);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    chunk.fill(0);
  });
  const reaped = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    if (control.signal.aborted) abort();
    child.stdin.end(JSON.stringify(expected));
    // A timeout is not a completed cleanup: always join the child's close event.
    const exit = await reaped;
    if (failure) throw failure;
    if (exit.code !== 0 || exit.signal !== null)
      throw new AgentBackupRestoreV3PgliteArchiveError(
        "VALIDATION_FAILED",
        "PGlite could not open, query and close the isolated physical database",
      );
    let value: unknown;
    try {
      value = JSON.parse(output.toString("utf8", 0, outputBytes));
    } catch (cause) {
      // error-policy:J3 Do not propagate stdout content through parse diagnostics.
      throw new AgentBackupRestoreV3PgliteArchiveError(
        "VALIDATION_OUTPUT_INVALID",
        "PGlite validation returned no canonical proof",
        cause instanceof SyntaxError ? undefined : cause,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AgentBackupRestoreV3PgliteArchiveError(
        "VALIDATION_OUTPUT_INVALID",
        "PGlite validation returned no canonical proof",
      );
    const result = value as Record<string, unknown>;
    if (
      Object.keys(result).sort().join(",") !==
        "device,inode,serverVersion,version" ||
      result.version !== 1 ||
      result.device !== expected.device ||
      result.inode !== expected.inode ||
      typeof result.serverVersion !== "string" ||
      !/^[1-9][0-9]{4,5}$/.test(result.serverVersion)
    )
      throw new AgentBackupRestoreV3PgliteArchiveError(
        "VALIDATION_OUTPUT_INVALID",
        "PGlite validation proof differs from the exact worker request",
      );
    return Object.freeze({ serverVersion: result.serverVersion });
  } finally {
    clearTimeout(timeout);
    control.signal.removeEventListener("abort", abort);
    child.kill("SIGKILL");
    await reaped;
    output.fill(0);
  }
}
