/**
 * Builds and executes the byte-native stdin handoff that seeds one quarantined
 * restore volume. The exact attempt-derived path and deterministic receipt are
 * independent of providers and database access so callers must compose them
 * with the durable restore authority before invoking any transport.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isValidUUID } from "../utils/validation";
import {
  buildVolumeVaultPassphraseCommand,
  shellQuote,
  VOLUME_VAULT_STDIN_FRAME_END,
  VOLUME_VAULT_STDIN_FRAME_VERSION,
  validateVolumePath,
} from "./docker-sandbox-utils";

export const AGENT_BACKUP_RESTORE_VAULT_VOLUME_SEED_RECEIPT_FORMAT =
  "eliza.agent-backup-restore.vault-volume-seed-receipt.v1" as const;
export const AGENT_BACKUP_RESTORE_STAGING_VOLUME_PATH_DERIVATION_V1 =
  "eliza.agent-backup-restore.staging-volume-path.v1" as const;
const RESTORE_STAGING_VOLUME_ROOT = "/data/agents/.restore";
export const AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES = 64;

export interface AgentBackupRestoreVaultVolumeSeedReceiptV1 {
  format: typeof AGENT_BACKUP_RESTORE_VAULT_VOLUME_SEED_RECEIPT_FORMAT;
  transport: typeof VOLUME_VAULT_STDIN_FRAME_VERSION;
  pathDerivation: typeof AGENT_BACKUP_RESTORE_STAGING_VOLUME_PATH_DERIVATION_V1;
  agentId: string;
  restoreAttemptId: string;
  replacementAttemptId: string;
  volumePathSha256: string;
  commandSha256: string;
  passphraseByteLength: number;
  completed: true;
}

export interface AgentBackupRestoreVaultVolumeSeedResult {
  receipt: Readonly<AgentBackupRestoreVaultVolumeSeedReceiptV1>;
  receiptDigest: string;
}

/**
 * The injected transport owns process/channel cancellation and must settle
 * only after it has stopped reading `stdin`. The mandatory signal prevents a
 * future caller from selecting a non-cancellable SSH adapter.
 */
export type AgentBackupRestoreVaultSeedExecStdin = (
  command: string,
  stdin: Buffer,
  signal: AbortSignal,
) => Promise<unknown>;

export interface SeedRestoreVolumeVaultPassphraseBytesInput {
  agentId: string;
  restoreAttemptId: string;
  replacementAttemptId: string;
  passphrase: Uint8Array;
  signal: AbortSignal;
  execStdin: AgentBackupRestoreVaultSeedExecStdin;
}

export interface BuildRestoreVolumeVaultSeedReceiptV1Input {
  agentId: string;
  restoreAttemptId: string;
  replacementAttemptId: string;
  passphraseByteLength: number;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireCanonicalUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw new Error(`${field} must be a canonical lowercase UUID.`);
  }
  return value;
}

function validatePassphraseByteLength(passphraseByteLength: number): void {
  if (passphraseByteLength !== AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES) {
    throw new Error(
      `Restore vault passphrase must contain exactly ${AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES} safe bytes.`,
    );
  }
}

function validatePassphraseBytes(passphrase: Uint8Array): void {
  if (!(passphrase instanceof Uint8Array)) {
    throw new Error("Restore vault passphrase must be byte-native.");
  }
  validatePassphraseByteLength(passphrase.byteLength);
  for (const byte of passphrase) {
    // Matches the V1 remote command's LC_ALL=C [:space:]/[:cntrl:] guard
    // without decoding secret bytes into an immutable JavaScript string.
    if (byte <= 0x20 || byte === 0x7f) {
      throw new Error("Restore vault passphrase contains an unsafe byte.");
    }
  }
}

/** Immutable V1 derivation for quarantined restore staging volumes. */
export function deriveRestoreStagingVolumePathV1(
  agentId: string,
  restoreAttemptId: string,
): string {
  const canonicalAgentId = requireCanonicalUuid(agentId, "agentId");
  const canonicalRestoreAttemptId = requireCanonicalUuid(restoreAttemptId, "restoreAttemptId");
  return `${RESTORE_STAGING_VOLUME_ROOT}/${canonicalAgentId}/${canonicalRestoreAttemptId}`;
}

function buildVaultStdinFrame(passphrase: Uint8Array): Buffer {
  const header = `${VOLUME_VAULT_STDIN_FRAME_VERSION} ${passphrase.byteLength}\n`;
  const trailer = `\n${VOLUME_VAULT_STDIN_FRAME_END}\n`;
  const headerByteLength = Buffer.byteLength(header, "utf8");
  const trailerByteLength = Buffer.byteLength(trailer, "utf8");
  const frame = Buffer.alloc(headerByteLength + passphrase.byteLength + trailerByteLength);
  frame.write(header, 0, headerByteLength, "utf8");
  frame.set(passphrase, headerByteLength);
  frame.write(trailer, headerByteLength + passphrase.byteLength, trailerByteLength, "utf8");
  return frame;
}

function safeRestoreDirectoryProof(path: string): string[] {
  const quoted = shellQuote(path);
  return [
    `test -d ${quoted} && test ! -L ${quoted} || exit 45`,
    `test "$(stat -c '%u' -- ${quoted})" = 0 || exit 45`,
    `directory_mode=$(stat -c '%a' -- ${quoted}); case "$directory_mode" in *[2367][0-7]|*[0-7][2367]) exit 45 ;; esac`,
  ];
}

function prepareRestoreDirectoryCommands(path: string): string[] {
  const quoted = shellQuote(path);
  return [
    `if test -e ${quoted} || test -L ${quoted}; then ${safeRestoreDirectoryProof(path).join("; ")}; else install -d -m 700 ${quoted}; fi`,
    ...safeRestoreDirectoryProof(path),
  ];
}

function buildPrecreatedVolumeVaultSeedCommand(input: {
  agentId: string;
  volumePath: string;
  replacementAttemptId: string;
  passphraseByteLength: number;
}): string {
  const agentRoot = `${RESTORE_STAGING_VOLUME_ROOT}/${input.agentId}`;
  const elizaPath = `${input.volumePath}/eliza`;
  return buildVolumeVaultPassphraseCommand(
    input.volumePath,
    input.passphraseByteLength,
    input.replacementAttemptId,
    [
      ...safeRestoreDirectoryProof("/data"),
      ...safeRestoreDirectoryProof("/data/agents"),
      ...prepareRestoreDirectoryCommands(RESTORE_STAGING_VOLUME_ROOT),
      ...prepareRestoreDirectoryCommands(agentRoot),
      ...prepareRestoreDirectoryCommands(input.volumePath),
      ...prepareRestoreDirectoryCommands(elizaPath),
    ],
  );
}

function canonicalReceiptJson(
  receipt: Readonly<AgentBackupRestoreVaultVolumeSeedReceiptV1>,
): string {
  return JSON.stringify({
    format: receipt.format,
    transport: receipt.transport,
    pathDerivation: receipt.pathDerivation,
    agentId: receipt.agentId,
    restoreAttemptId: receipt.restoreAttemptId,
    replacementAttemptId: receipt.replacementAttemptId,
    volumePathSha256: receipt.volumePathSha256,
    commandSha256: receipt.commandSha256,
    passphraseByteLength: receipt.passphraseByteLength,
    completed: receipt.completed,
  });
}

interface RestoreVolumeVaultSeedPlan {
  command: string;
  result: Readonly<AgentBackupRestoreVaultVolumeSeedResult>;
}

function buildRestoreVolumeVaultSeedPlanV1(
  input: Readonly<BuildRestoreVolumeVaultSeedReceiptV1Input>,
): RestoreVolumeVaultSeedPlan {
  validatePassphraseByteLength(input.passphraseByteLength);
  const volumePath = deriveRestoreStagingVolumePathV1(input.agentId, input.restoreAttemptId);
  const replacementAttemptId = requireCanonicalUuid(
    input.replacementAttemptId,
    "replacementAttemptId",
  );
  validateVolumePath(volumePath);
  const command = buildPrecreatedVolumeVaultSeedCommand({
    agentId: input.agentId,
    volumePath,
    replacementAttemptId,
    passphraseByteLength: input.passphraseByteLength,
  });
  const receipt = Object.freeze<AgentBackupRestoreVaultVolumeSeedReceiptV1>({
    format: AGENT_BACKUP_RESTORE_VAULT_VOLUME_SEED_RECEIPT_FORMAT,
    transport: VOLUME_VAULT_STDIN_FRAME_VERSION,
    pathDerivation: AGENT_BACKUP_RESTORE_STAGING_VOLUME_PATH_DERIVATION_V1,
    agentId: input.agentId,
    restoreAttemptId: input.restoreAttemptId,
    replacementAttemptId,
    volumePathSha256: sha256Utf8(volumePath),
    commandSha256: sha256Utf8(command),
    passphraseByteLength: input.passphraseByteLength,
    completed: true,
  });
  return {
    command,
    result: Object.freeze({
      receipt,
      receiptDigest: sha256Utf8(canonicalReceiptJson(receipt)),
    }),
  };
}

/** Pure recomputation surface for the durable database receipt authority. */
export function buildRestoreVolumeVaultSeedReceiptV1(
  input: Readonly<BuildRestoreVolumeVaultSeedReceiptV1Input>,
): Readonly<AgentBackupRestoreVaultVolumeSeedResult> {
  return buildRestoreVolumeVaultSeedPlanV1(input).result;
}

/**
 * Seed a pre-created restore volume with an already-authorized passphrase.
 *
 * This function has no provider, SSH, database, or production caller. Secret
 * bytes exist only in the caller-owned passphrase and one V1 stdin frame; the
 * frame is wiped in `finally`, only after the mandatory cancellable transport
 * has settled and therefore stopped reading caller-owned stdin bytes.
 * The returned receipt contains only deterministic, non-secret completion
 * metadata. A caller must first authorize these exact agent/attempt identities
 * in durable pre-creation authority; the path can never select the live agent
 * volume.
 */
export async function seedRestoreVolumeVaultPassphraseBytes(
  input: Readonly<SeedRestoreVolumeVaultPassphraseBytesInput>,
): Promise<Readonly<AgentBackupRestoreVaultVolumeSeedResult>> {
  validatePassphraseBytes(input.passphrase);
  const plan = buildRestoreVolumeVaultSeedPlanV1({
    agentId: input.agentId,
    restoreAttemptId: input.restoreAttemptId,
    replacementAttemptId: input.replacementAttemptId,
    passphraseByteLength: input.passphrase.byteLength,
  });
  input.signal.throwIfAborted();

  const frame = buildVaultStdinFrame(input.passphrase);

  try {
    input.signal.throwIfAborted();
    await input.execStdin(plan.command, frame, input.signal);
    input.signal.throwIfAborted();
    return plan.result;
  } finally {
    frame.fill(0);
  }
}
