/**
 * Binds a streamed restore to one Cloud replacement candidate and records its
 * crash-safe terminal acknowledgement. The provider-injected environment is
 * the candidate identity; request headers and the snapshot descriptor must
 * match it exactly before state can be applied.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { resolveStateDir } from "../config/paths.ts";
import {
  type AgentSnapshotUpgradeBinding,
  validateAgentSnapshotUpgradeBinding,
} from "./agent-backup.ts";
import type { AgentSnapshotStreamRestoreResult } from "./agent-snapshot-stream.ts";
import { stableJson } from "./agent-snapshot-stream-protocol.ts";

const RECEIPT_VERSION = 1;
const MAX_RECEIPT_BYTES = 16 * 1024;
const RECEIPT_DIR = path.join("backups", "restore-receipts");

export const AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS = {
  backupId: "x-eliza-snapshot-backup-id",
  captureNonce: "x-eliza-snapshot-capture-nonce",
  sourceEnvironmentRevision: "x-eliza-snapshot-source-environment-revision",
  sourceImageDigest: "x-eliza-snapshot-source-image-digest",
  sourceSandboxId: "x-eliza-snapshot-source-sandbox-id",
  targetImageDigest: "x-eliza-snapshot-target-image-digest",
  targetReplacementAttemptId: "x-eliza-snapshot-target-replacement-attempt-id",
  targetSandboxId: "x-eliza-snapshot-target-sandbox-id",
} as const;

const AGENT_SNAPSHOT_RESTORE_BINDING_ENV = {
  backupId: "ELIZA_SNAPSHOT_RESTORE_BACKUP_ID",
  captureNonce: "ELIZA_SNAPSHOT_RESTORE_NONCE",
  sourceEnvironmentRevision:
    "ELIZA_SNAPSHOT_RESTORE_SOURCE_ENVIRONMENT_REVISION",
  sourceImageDigest: "ELIZA_SNAPSHOT_RESTORE_SOURCE_IMAGE_DIGEST",
  sourceSandboxId: "ELIZA_SNAPSHOT_RESTORE_SOURCE_SANDBOX_ID",
  targetImageDigest: "ELIZA_SNAPSHOT_RESTORE_TARGET_IMAGE_DIGEST",
  targetReplacementAttemptId: "ELIZA_SNAPSHOT_RESTORE_CANDIDATE_ATTEMPT_ID",
  targetSandboxId: "ELIZA_SNAPSHOT_RESTORE_PROVIDER_SANDBOX_ID",
} as const;

export interface AgentCandidateSnapshotRestoreResult
  extends AgentSnapshotStreamRestoreResult {
  binding: AgentSnapshotUpgradeBinding;
  receiptStatus: "committed";
}

interface ApplyingReceipt {
  binding: AgentSnapshotUpgradeBinding;
  status: "applying";
  version: typeof RECEIPT_VERSION;
}

interface CommittedReceipt {
  binding: AgentSnapshotUpgradeBinding;
  result: AgentCandidateSnapshotRestoreResult;
  status: "committed";
  version: typeof RECEIPT_VERSION;
}

type RestoreReceipt = ApplyingReceipt | CommittedReceipt;

function bindingError(
  message: string,
  code = "AGENT_SNAPSHOT_BINDING_INVALID",
): ElizaError {
  return new ElizaError(message, {
    code,
    severity: "fatal",
  });
}

function oneHeader(
  headers: NodeJS.Dict<string | string[]>,
  name: string,
): string {
  const value = headers[name];
  if (typeof value !== "string" || !value) {
    throw bindingError(
      `Snapshot restore header ${name} is missing or repeated`,
    );
  }
  return value;
}

function bindingFromStrings(values: {
  backupId: string;
  captureNonce: string;
  sourceEnvironmentRevision: string;
  sourceImageDigest: string;
  sourceSandboxId: string;
  targetImageDigest: string;
  targetReplacementAttemptId: string;
  targetSandboxId: string;
}): AgentSnapshotUpgradeBinding {
  if (!/^(?:0|[1-9][0-9]*)$/.test(values.sourceEnvironmentRevision)) {
    throw bindingError("Snapshot source environment revision is malformed");
  }
  const sourceEnvironmentRevision = Number(values.sourceEnvironmentRevision);
  return validateAgentSnapshotUpgradeBinding({
    ...values,
    sourceEnvironmentRevision,
  });
}

function requiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name];
  if (typeof value !== "string" || !value) {
    throw bindingError(
      "Candidate snapshot restore environment is partially configured",
    );
  }
  return value;
}

export function resolveCandidateSnapshotRestoreBinding(
  env: NodeJS.ProcessEnv = process.env,
): AgentSnapshotUpgradeBinding | null {
  const values = Object.values(AGENT_SNAPSHOT_RESTORE_BINDING_ENV).map(
    (name) => env[name],
  );
  if (values.every((value) => value === undefined)) return null;
  return bindingFromStrings({
    backupId: requiredEnvironmentValue(
      env,
      AGENT_SNAPSHOT_RESTORE_BINDING_ENV.backupId,
    ),
    captureNonce: requiredEnvironmentValue(
      env,
      AGENT_SNAPSHOT_RESTORE_BINDING_ENV.captureNonce,
    ),
    sourceEnvironmentRevision: requiredEnvironmentValue(
      env,
      AGENT_SNAPSHOT_RESTORE_BINDING_ENV.sourceEnvironmentRevision,
    ),
    sourceImageDigest: requiredEnvironmentValue(
      env,
      AGENT_SNAPSHOT_RESTORE_BINDING_ENV.sourceImageDigest,
    ),
    sourceSandboxId: requiredEnvironmentValue(
      env,
      AGENT_SNAPSHOT_RESTORE_BINDING_ENV.sourceSandboxId,
    ),
    targetImageDigest: requiredEnvironmentValue(
      env,
      AGENT_SNAPSHOT_RESTORE_BINDING_ENV.targetImageDigest,
    ),
    targetReplacementAttemptId: requiredEnvironmentValue(
      env,
      AGENT_SNAPSHOT_RESTORE_BINDING_ENV.targetReplacementAttemptId,
    ),
    targetSandboxId: requiredEnvironmentValue(
      env,
      AGENT_SNAPSHOT_RESTORE_BINDING_ENV.targetSandboxId,
    ),
  });
}

export function verifyCandidateSnapshotRestoreHeaders(
  headers: NodeJS.Dict<string | string[]>,
  expected: AgentSnapshotUpgradeBinding,
): void {
  const actual = bindingFromStrings({
    backupId: oneHeader(
      headers,
      AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.backupId,
    ),
    captureNonce: oneHeader(
      headers,
      AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.captureNonce,
    ),
    sourceEnvironmentRevision: oneHeader(
      headers,
      AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.sourceEnvironmentRevision,
    ),
    sourceImageDigest: oneHeader(
      headers,
      AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.sourceImageDigest,
    ),
    sourceSandboxId: oneHeader(
      headers,
      AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.sourceSandboxId,
    ),
    targetImageDigest: oneHeader(
      headers,
      AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.targetImageDigest,
    ),
    targetReplacementAttemptId: oneHeader(
      headers,
      AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.targetReplacementAttemptId,
    ),
    targetSandboxId: oneHeader(
      headers,
      AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.targetSandboxId,
    ),
  });
  if (stableJson(actual) !== stableJson(expected)) {
    throw bindingError(
      "Snapshot restore request does not match this replacement candidate",
    );
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureReceiptDirectoryDurable(): Promise<string> {
  const stateRoot = path.resolve(resolveStateDir());
  const rootStat = await fs.lstat(stateRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw bindingError(
      "Snapshot restore state root is not a durable directory",
      "AGENT_SNAPSHOT_RECEIPT_INVALID",
    );
  }
  let current = stateRoot;
  for (const segment of RECEIPT_DIR.split(path.sep)) {
    const next = path.join(current, segment);
    try {
      await fs.mkdir(next, { mode: 0o700 });
      await fsyncDirectory(next);
      await fsyncDirectory(current);
    } catch (error) {
      // error-policy:J3 concurrent filesystem state is untrusted; only exact
      // EEXIST plus a real directory is accepted, and every other error rethrows.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.lstat(next);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw bindingError(
          "Snapshot restore receipt path traverses a non-directory",
          "AGENT_SNAPSHOT_RECEIPT_INVALID",
        );
      }
    }
    current = next;
  }
  return current;
}

function receiptPath(
  directory: string,
  binding: AgentSnapshotUpgradeBinding,
): string {
  return path.join(directory, `${binding.backupId}.json`);
}

async function readReceipt(target: string): Promise<RestoreReceipt> {
  const bytes = await fs.readFile(target);
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw bindingError("Snapshot restore receipt exceeds its byte budget");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (cause) {
    // error-policy:J3 receipt bytes are untrusted; malformed JSON becomes an
    // explicit invalid-receipt failure with the parse cause.
    throw new ElizaError("Snapshot restore receipt is malformed", {
      cause,
      code: "AGENT_SNAPSHOT_RECEIPT_INVALID",
      severity: "fatal",
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bindingError(
      "Snapshot restore receipt is malformed",
      "AGENT_SNAPSHOT_RECEIPT_INVALID",
    );
  }
  const record = parsed as Record<string, unknown>;
  const status = record.status;
  const expectedKeys =
    status === "committed"
      ? ["binding", "result", "status", "version"]
      : ["binding", "status", "version"];
  const actualKeys = Object.keys(record).sort();
  if (
    record.version !== RECEIPT_VERSION ||
    (status !== "applying" && status !== "committed") ||
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw bindingError(
      "Snapshot restore receipt has unsupported or missing fields",
      "AGENT_SNAPSHOT_RECEIPT_INVALID",
    );
  }
  validateAgentSnapshotUpgradeBinding(record.binding);
  if (status === "committed") {
    const result = record.result;
    if (
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result)
    ) {
      throw bindingError(
        "Snapshot restore receipt result is malformed",
        "AGENT_SNAPSHOT_RECEIPT_INVALID",
      );
    }
    const resultRecord = result as Record<string, unknown>;
    const resultKeys = Object.keys(resultRecord).sort();
    const expectedResultKeys = [
      "aggregateSha256",
      "binding",
      "fileCount",
      "receiptStatus",
      "requiresRestart",
      "schemaVersion",
      "success",
      "totalBytes",
      "transfer",
    ];
    if (
      resultKeys.length !== expectedResultKeys.length ||
      resultKeys.some((key, index) => key !== expectedResultKeys[index]) ||
      resultRecord.success !== true ||
      resultRecord.requiresRestart !== true ||
      resultRecord.schemaVersion !== 2 ||
      resultRecord.transfer !== "chunked-v1" ||
      resultRecord.receiptStatus !== "committed" ||
      typeof resultRecord.aggregateSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(resultRecord.aggregateSha256) ||
      typeof resultRecord.fileCount !== "number" ||
      !Number.isSafeInteger(resultRecord.fileCount) ||
      resultRecord.fileCount < 0 ||
      typeof resultRecord.totalBytes !== "number" ||
      !Number.isSafeInteger(resultRecord.totalBytes) ||
      resultRecord.totalBytes < 0
    ) {
      throw bindingError(
        "Snapshot restore receipt result is invalid",
        "AGENT_SNAPSHOT_RECEIPT_INVALID",
      );
    }
    validateAgentSnapshotUpgradeBinding(resultRecord.binding);
    if (stableJson(resultRecord.binding) !== stableJson(record.binding)) {
      throw bindingError(
        "Snapshot restore receipt result belongs to a different candidate binding",
        "AGENT_SNAPSHOT_RECEIPT_INVALID",
      );
    }
  }
  return record as unknown as RestoreReceipt;
}

export async function beginCandidateSnapshotRestore(
  binding: AgentSnapshotUpgradeBinding,
): Promise<AgentCandidateSnapshotRestoreResult | null> {
  const directory = await ensureReceiptDirectoryDurable();
  const target = receiptPath(directory, binding);
  const receipt: ApplyingReceipt = {
    binding,
    status: "applying",
    version: RECEIPT_VERSION,
  };
  const temporary = path.join(
    directory,
    `.${binding.backupId}.${process.pid}.${crypto.randomUUID()}.applying`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${stableJson(receipt)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let linked = false;
  try {
    // A hard link publishes the already-fsynced receipt with no empty-file
    // visibility window and fails rather than replacing a competing attempt.
    await fs.link(temporary, target);
    linked = true;
  } catch (error) {
    // error-policy:J3 a competing receipt link is untrusted; only exact EEXIST
    // enters the subsequent binding and result equality checks.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await fs.rm(temporary, { force: true });
    // Persist both the target link and removal of the temporary directory
    // entry before admission or replay returns to the HTTP boundary.
    await fsyncDirectory(directory);
  }
  if (linked) return null;
  const existing = await readReceipt(target);
  if (stableJson(existing.binding) !== stableJson(binding)) {
    throw bindingError(
      "Snapshot restore receipt belongs to a different candidate binding",
      "AGENT_SNAPSHOT_RECEIPT_CONFLICT",
    );
  }
  if (existing.status === "applying") {
    throw bindingError(
      "A prior snapshot restore attempt has an indeterminate apply state",
      "AGENT_SNAPSHOT_RESTORE_INDETERMINATE",
    );
  }
  return existing.result;
}

export async function commitCandidateSnapshotRestore(
  binding: AgentSnapshotUpgradeBinding,
  streamResult: AgentSnapshotStreamRestoreResult,
): Promise<AgentCandidateSnapshotRestoreResult> {
  const directory = await ensureReceiptDirectoryDurable();
  const target = receiptPath(directory, binding);
  const result: AgentCandidateSnapshotRestoreResult = {
    ...streamResult,
    binding,
    receiptStatus: "committed",
  };
  const existing = await readReceipt(target);
  if (stableJson(existing.binding) !== stableJson(binding)) {
    throw bindingError(
      "Snapshot restore receipt belongs to a different candidate binding",
      "AGENT_SNAPSHOT_RECEIPT_CONFLICT",
    );
  }
  if (existing.status === "committed") {
    if (stableJson(existing.result) !== stableJson(result)) {
      throw bindingError(
        "Snapshot restore receipt already committed a different result",
        "AGENT_SNAPSHOT_RECEIPT_CONFLICT",
      );
    }
    return existing.result;
  }
  const receipt: CommittedReceipt = {
    binding,
    result,
    status: "committed",
    version: RECEIPT_VERSION,
  };
  const temporary = path.join(
    directory,
    `.${binding.backupId}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${stableJson(receipt)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    // error-policy:J6 failed publication removes its private temporary receipt;
    // teardown failure is observed while the rename error remains primary.
    try {
      await fs.rm(temporary, { force: true });
      await fsyncDirectory(directory);
    } catch (cleanupError) {
      // error-policy:J6 receipt cleanup is best-effort after publication has
      // already failed; the original rename error remains externally visible.
      logger.warn(
        {
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          src: "agent:snapshot",
        },
        "Failed to remove unpublished snapshot restore receipt",
      );
    }
    throw error;
  }
  await fsyncDirectory(directory);
  return result;
}

export function verifyCandidateSnapshotRestoreReplay(
  committed: AgentCandidateSnapshotRestoreResult,
  replayed: AgentSnapshotStreamRestoreResult,
): void {
  const expected: AgentSnapshotStreamRestoreResult = {
    aggregateSha256: committed.aggregateSha256,
    fileCount: committed.fileCount,
    requiresRestart: committed.requiresRestart,
    schemaVersion: committed.schemaVersion,
    success: committed.success,
    totalBytes: committed.totalBytes,
    transfer: committed.transfer,
  };
  if (stableJson(expected) !== stableJson(replayed)) {
    throw bindingError(
      "Snapshot restore replay does not match the committed transfer",
      "AGENT_SNAPSHOT_RECEIPT_CONFLICT",
    );
  }
}
