/**
 * Local process adapter for the durable coordinator's Agent materializer seam.
 * Each call owns one private worker and one bounded raw record, snapshots its
 * authority before yielding, and joins the worker before settling. This does
 * not authorize remote Docker execution or start a live Agent generation.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AgentBackupRestoreV3ComponentReceiptSchema,
  type AgentBackupRestoreV3OperationControl,
  parseAgentBackupRestoreV3CandidateReceipt,
} from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFs,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { snapshotOperationControl } from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import type { AgentBackupRestoreV3CandidateMaterializer } from "./agent-backup-restore-v3-candidate-materializer";
import {
  snapshotAgentBackupRestoreV3CandidateRecord,
  snapshotAgentBackupRestoreV3CandidateSession,
} from "./agent-backup-restore-v3-candidate-records";
import {
  MATERIALIZER_METADATA_MAX_BYTES,
  MaterializerRequestSchema,
  materializerReceiptDigest,
  materializerWireError,
} from "./agent-backup-restore-v3-materializer-wire";

export function createAgentBackupRestoreV3ProcessMaterializer(input: {
  readonly candidateFs: AgentBackupRestoreV3CandidateFs;
  readonly testOnlyAllowNonLinuxFdEmulation?: true;
}): AgentBackupRestoreV3CandidateMaterializer {
  const candidateFs = input.candidateFs;
  if (!isAgentBackupRestoreV3CandidateFs(candidateFs))
    throw materializerWireError("INPUT_INVALID");
  const emulate = input.testOnlyAllowNonLinuxFdEmulation === true;
  if (
    emulate &&
    (process.platform === "linux" || process.env.NODE_ENV !== "test")
  )
    throw materializerWireError("INPUT_INVALID");
  const roots = Object.freeze({
    version: 2 as const,
    trustedRoot: candidateFs.trustedRoot,
    attemptRoot: candidateFs.attemptRoot,
    trustedRootIdentity: candidateFs.trustedRootIdentity,
    attemptRootIdentity: candidateFs.attemptRootIdentity,
  });
  const execute = async (
    metadata: Buffer,
    payload: Uint8Array,
    expectedDigest: string,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ) => {
    try {
      await candidateFs.assertAuthority(control);
      await runWorker(metadata, payload, expectedDigest, control, emulate);
      await candidateFs.assertAuthority(control);
    } finally {
      metadata.fill(0);
      payload.fill(0);
    }
  };
  const encode = (value: unknown): Buffer => {
    const validated = MaterializerRequestSchema.parse(value);
    const metadata = Buffer.from(candidateFsCanonicalJson(validated));
    if (metadata.length > MATERIALIZER_METADATA_MAX_BYTES) {
      metadata.fill(0);
      throw materializerWireError("INPUT_INVALID");
    }
    return metadata;
  };
  const materializer: AgentBackupRestoreV3CandidateMaterializer = {
    stageRecord(sessionValue, recordValue, controlValue) {
      const control = snapshotOperationControl(controlValue);
      const session =
        snapshotAgentBackupRestoreV3CandidateSession(sessionValue);
      const { receipt, payload } = snapshotAgentBackupRestoreV3CandidateRecord(
        recordValue,
        control,
      );
      let metadata: Buffer;
      try {
        metadata = encode({
          ...roots,
          session,
          deadlineEpochMs: control.deadlineEpochMs,
          method: "stageRecord",
          receipt,
        });
      } catch (cause) {
        // error-policy:J2 Release the owned plaintext copy before propagating validation failure.
        payload.fill(0);
        throw cause;
      }
      return execute(
        metadata,
        payload,
        materializerReceiptDigest(receipt),
        control,
      ).then(() => receipt);
    },
    finishComponent(sessionValue, receiptValue, controlValue) {
      const control = snapshotOperationControl(controlValue);
      const session =
        snapshotAgentBackupRestoreV3CandidateSession(sessionValue);
      const receipt = AgentBackupRestoreV3ComponentReceiptSchema.parse(
        JSON.parse(candidateFsCanonicalJson(receiptValue)),
      );
      const metadata = encode({
        ...roots,
        session,
        deadlineEpochMs: control.deadlineEpochMs,
        method: "finishComponent",
        receipt,
      });
      return execute(
        metadata,
        new Uint8Array(),
        materializerReceiptDigest(receipt),
        control,
      ).then(() => receipt);
    },
    assembleCandidate(sessionValue, receiptValue, controlValue) {
      const control = snapshotOperationControl(controlValue);
      const session =
        snapshotAgentBackupRestoreV3CandidateSession(sessionValue);
      const receipt = parseAgentBackupRestoreV3CandidateReceipt(
        JSON.parse(candidateFsCanonicalJson(receiptValue)),
      );
      const metadata = encode({
        ...roots,
        session,
        deadlineEpochMs: control.deadlineEpochMs,
        method: "assembleCandidate",
        receipt,
      });
      return execute(
        metadata,
        new Uint8Array(),
        materializerReceiptDigest(receipt),
        control,
      ).then(() => receipt);
    },
  };
  return Object.freeze(materializer);
}

async function runWorker(
  metadata: Buffer,
  payload: Uint8Array,
  expectedDigest: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  emulate: boolean,
): Promise<void> {
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./agent-backup-restore-v3-materializer-worker.ts"
        : "./agent-backup-restore-v3-materializer-worker.js",
      import.meta.url,
    ),
  );
  const child = spawn(
    process.execPath,
    [
      // Source checkout only; published JS uses rewritten ESM imports directly.
      ...(worker.endsWith(".ts") && !process.versions.bun
        ? ["--import", import.meta.resolve("tsx/esm")]
        : []),
      worker,
      ...(emulate ? ["--test-only-non-linux-fs"] : []),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // Never inherit NODE_OPTIONS, model credentials, preload hooks or vault keys.
      env: emulate ? { NODE_ENV: "test" } : {},
    },
  );
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    throw materializerWireError("PROCESS_FAILED");
  }
  const output = Buffer.alloc(64);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(metadata.length);
  let outputBytes = 0;
  let failure: Error | undefined;
  const interrupt = (code: string) => {
    if (failure) return;
    failure = materializerWireError(code);
    // EOF cooperatively aborts the worker, which joins its validation children.
    // Killing only the worker PID could leave a child writing after DB rollback.
    child.stdin?.destroy();
  };
  const abort = () => interrupt("INTERRUPTED");
  const timeout = setTimeout(
    abort,
    Math.min(2_147_483_647, Math.max(1, control.deadlineEpochMs - Date.now())),
  );
  const reaped = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  control.signal.addEventListener("abort", abort, { once: true });
  child.on("error", () => interrupt("PROCESS_FAILED"));
  child.stdin.on("error", () => interrupt("INPUT_FAILED"));
  child.stdout.on("error", () => interrupt("OUTPUT_INVALID"));
  child.stderr.on("error", () => interrupt("PROCESS_FAILED"));
  child.stderr.on("data", (chunk: Buffer) => chunk.fill(0));
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      if (chunk.length > output.length - outputBytes) {
        interrupt("OUTPUT_INVALID");
        return;
      }
      chunk.copy(output, outputBytes);
      outputBytes += chunk.length;
    } finally {
      chunk.fill(0);
    }
  });
  try {
    if (control.signal.aborted) abort();
    if (!failure) {
      child.stdin.write(prefix);
      child.stdin.write(metadata);
      child.stdin.write(payload);
    }
    const code = await reaped;
    if (failure) throw failure;
    if (
      code !== 0 ||
      outputBytes !== 64 ||
      output.toString("utf8") !== expectedDigest
    )
      throw materializerWireError("RECEIPT_UNPROVEN");
  } finally {
    clearTimeout(timeout);
    control.signal.removeEventListener("abort", abort);
    child.stdin.destroy();
    await reaped;
    prefix.fill(0);
    output.fill(0);
  }
}
