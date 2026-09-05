/**
 * Durable protected→spool cleanup reconciliation. A local operation directory
 * is only a discovery cursor: authoritative catalogue state and matching
 * primary+secondary provider receipts are re-proved before an outbox intent is
 * persisted or any ciphertext is removed.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core/edge";
import z from "zod";
import {
  type AuthorizeAgentBackupProtectedSpoolCleanupInput,
  type AuthorizeAgentBackupTerminalSpoolCleanupInput,
  authorizeAgentBackupProtectedSpoolCleanup,
  authorizeAgentBackupTerminalSpoolCleanup,
  listAgentBackupProtectedSpoolCleanupCandidates,
} from "../../db/repositories/agent-backup-publication";
import type { StoredAgentSandboxBackup } from "../../db/schemas/agent-sandboxes";
import {
  type AgentBackupCaptureV3DurableOperationAuthority,
  AgentBackupCaptureV3Spool,
  type AgentBackupCaptureV3SpoolConfig,
} from "./agent-backup-capture-v2-spool";
import {
  type AgentBackupCaptureV3SpoolAuthority,
  deriveAgentBackupCaptureV3SpoolAuthorityFromCatalogBackup,
} from "./agent-backup-capture-v3-publication-source";

const OUTBOX_DIRECTORY = "agent-backup-capture-v3-cleanup-outbox";
const TERMINAL_OUTBOX_DIRECTORY = "agent-backup-capture-v3-terminal-cleanup-outbox";
const TERMINAL_CANDIDATE_DIRECTORY = "agent-backup-capture-v3-terminal-cleanup-candidates";
const OUTBOX_FORMAT = "elizaos.agent-backup.capture-v3-cleanup" as const;
const TERMINAL_OUTBOX_FORMAT = "elizaos.agent-backup.capture-v3-terminal-cleanup" as const;
const TERMINAL_CANDIDATE_FORMAT =
  "elizaos.agent-backup.capture-v3-terminal-cleanup-candidate" as const;
const OUTBOX_VERSION = 1 as const;
const MAX_INTENT_BYTES = 16 * 1024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const DEFAULT_BATCH_SIZE = 32;
const MAX_BATCH_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OWNED_TEMPORARY_PATTERN =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

const IntentSchema = z.strictObject({
  format: z.literal(OUTBOX_FORMAT),
  version: z.literal(OUTBOX_VERSION),
  organizationId: z.string().regex(UUID_PATTERN),
  agentId: z.string().regex(UUID_PATTERN),
  backupId: z.string().regex(UUID_PATTERN),
  operationId: z.string().regex(UUID_PATTERN),
  activationGeneration: z.string().regex(UUID_PATTERN),
  lifecycleRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/),
  manifestDigest: z.string().regex(SHA256_PATTERN),
  objectInventoryDigest: z.string().regex(SHA256_PATTERN),
  requestSha256: z.string().regex(SHA256_PATTERN),
  authoritySha256: z.string().regex(SHA256_PATTERN),
  authorizedAt: z.string().datetime({ offset: true }),
});

type CleanupIntent = z.infer<typeof IntentSchema>;

const TerminalIntentSchema = z.strictObject({
  format: z.literal(TERMINAL_OUTBOX_FORMAT),
  version: z.literal(OUTBOX_VERSION),
  organizationId: z.string().regex(UUID_PATTERN),
  agentId: z.string().regex(UUID_PATTERN),
  backupId: z.string().regex(UUID_PATTERN),
  operationId: z.string().regex(UUID_PATTERN),
  activationGeneration: z.string().regex(UUID_PATTERN),
  lifecycleRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/),
  requestSha256: z.string().regex(SHA256_PATTERN),
  authoritySha256: z.string().regex(SHA256_PATTERN),
  runtimePrincipalSha256: z.string().regex(SHA256_PATTERN),
  terminalErrorCode: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  authorizedAt: z.string().datetime({ offset: true }),
});

type TerminalCleanupIntent = z.infer<typeof TerminalIntentSchema>;

const TerminalCandidateSchema = TerminalIntentSchema.omit({
  format: true,
  authorizedAt: true,
}).extend({
  format: z.literal(TERMINAL_CANDIDATE_FORMAT),
  stagedAt: z.string().datetime({ offset: true }),
});

type TerminalCleanupCandidate = z.infer<typeof TerminalCandidateSchema>;

export interface AgentBackupCaptureV3TerminalSpoolCleanupAuthority {
  organizationId: string;
  agentId: string;
  backupId: string;
  operationId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  requestSha256: string;
  authoritySha256: string;
  runtimePrincipalSha256: string;
}

export interface AgentBackupCaptureV3SpoolCleanupDependencies {
  listCandidates(params: {
    operationId: string;
    limit?: number;
  }): Promise<StoredAgentSandboxBackup[]>;
  authorize(
    input: Readonly<AuthorizeAgentBackupProtectedSpoolCleanupInput>,
  ): Promise<StoredAgentSandboxBackup>;
  authorizeTerminal(
    input: Readonly<AuthorizeAgentBackupTerminalSpoolCleanupInput>,
  ): Promise<StoredAgentSandboxBackup>;
  deriveAuthority(
    backup: Readonly<StoredAgentSandboxBackup>,
  ): Promise<AgentBackupCaptureV3SpoolAuthority>;
  listDurableOperations(
    config: Readonly<AgentBackupCaptureV3SpoolConfig>,
  ): Promise<AgentBackupCaptureV3DurableOperationAuthority[]>;
  openExisting(
    config: Readonly<AgentBackupCaptureV3SpoolConfig>,
    input: {
      operationId: string;
      executionToken: string;
      requestSha256: string;
      authoritySha256: string;
      runtimePrincipalSha256?: string;
    },
  ): Promise<AgentBackupCaptureV3Spool | undefined>;
  now(): number;
  executionToken(): string;
}

const DEFAULT_DEPENDENCIES: AgentBackupCaptureV3SpoolCleanupDependencies = {
  listCandidates: listAgentBackupProtectedSpoolCleanupCandidates,
  authorize: authorizeAgentBackupProtectedSpoolCleanup,
  authorizeTerminal: authorizeAgentBackupTerminalSpoolCleanup,
  deriveAuthority: deriveAgentBackupCaptureV3SpoolAuthorityFromCatalogBackup,
  listDurableOperations: AgentBackupCaptureV3Spool.listDurableOperationAuthorities,
  openExisting: AgentBackupCaptureV3Spool.openExisting,
  now: Date.now,
  executionToken: randomUUID,
};

export interface AgentBackupCaptureV3SpoolCleanupJanitorConfig {
  spool: Readonly<AgentBackupCaptureV3SpoolConfig>;
  batchSize?: number;
}

export interface AgentBackupCaptureV3SpoolCleanupSummary {
  discovered: number;
  authorized: number;
  completed: number;
  pending: number;
  skippedUnprotected: number;
  indeterminate: number;
}

export interface AgentBackupCaptureV3SpoolCleanupJanitor {
  enqueueProtectedBackup(backup: Readonly<StoredAgentSandboxBackup>): Promise<"pending">;
  /** Persist non-authorizing evidence before the terminal catalogue CAS. */
  stageTerminalFailure(input: {
    authority: Readonly<AgentBackupCaptureV3TerminalSpoolCleanupAuthority>;
    terminalErrorCode: string;
  }): Promise<"pending">;
  runCycle(signal?: AbortSignal): Promise<AgentBackupCaptureV3SpoolCleanupSummary>;
}

function batchSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_BATCH_SIZE) {
    throw new Error(`Backup spool cleanup batch size must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return resolved;
}

function authorizationInput(
  authority: Readonly<AgentBackupCaptureV3SpoolAuthority>,
): AuthorizeAgentBackupProtectedSpoolCleanupInput {
  return {
    organizationId: authority.organizationId,
    agentId: authority.agentId,
    backupId: authority.backupId,
    operationId: authority.operationId,
    activationGeneration: authority.activationGeneration,
    lifecycleRevision: authority.lifecycleRevision,
    manifestDigest: authority.manifestDigest,
    objectInventoryDigest: authority.objectInventoryDigest,
  };
}

function terminalAuthorizationInput(
  evidence: Readonly<AgentBackupCaptureV3TerminalSpoolCleanupAuthority> & {
    terminalErrorCode: string;
  },
): AuthorizeAgentBackupTerminalSpoolCleanupInput {
  return {
    organizationId: evidence.organizationId,
    agentId: evidence.agentId,
    backupId: evidence.backupId,
    operationId: evidence.operationId,
    activationGeneration: evidence.activationGeneration,
    lifecycleRevision: evidence.lifecycleRevision,
    terminalErrorCode: evidence.terminalErrorCode,
  };
}

function terminalCleanupAuthority(
  evidence: Readonly<AgentBackupCaptureV3TerminalSpoolCleanupAuthority>,
): AgentBackupCaptureV3TerminalSpoolCleanupAuthority {
  return {
    organizationId: evidence.organizationId,
    agentId: evidence.agentId,
    backupId: evidence.backupId,
    operationId: evidence.operationId,
    activationGeneration: evidence.activationGeneration,
    lifecycleRevision: evidence.lifecycleRevision,
    requestSha256: evidence.requestSha256,
    authoritySha256: evidence.authoritySha256,
    runtimePrincipalSha256: evidence.runtimePrincipalSha256,
  };
}

function sameAuthority(
  left: Readonly<AgentBackupCaptureV3SpoolAuthority>,
  right: Readonly<AgentBackupCaptureV3SpoolAuthority>,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.agentId === right.agentId &&
    left.backupId === right.backupId &&
    left.operationId === right.operationId &&
    left.activationGeneration === right.activationGeneration &&
    left.lifecycleRevision === right.lifecycleRevision &&
    left.manifestDigest === right.manifestDigest &&
    left.objectInventoryDigest === right.objectInventoryDigest &&
    left.requestSha256 === right.requestSha256 &&
    left.authoritySha256 === right.authoritySha256
  );
}

function intentAuthority(intent: Readonly<CleanupIntent>): AgentBackupCaptureV3SpoolAuthority {
  return {
    organizationId: intent.organizationId,
    agentId: intent.agentId,
    backupId: intent.backupId,
    operationId: intent.operationId,
    activationGeneration: intent.activationGeneration,
    lifecycleRevision: intent.lifecycleRevision,
    manifestDigest: intent.manifestDigest,
    objectInventoryDigest: intent.objectInventoryDigest,
    requestSha256: intent.requestSha256,
    authoritySha256: intent.authoritySha256,
  };
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readIntent(file: string): Promise<CleanupIntent> {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INTENT_BYTES) {
      throw new Error("Backup spool cleanup intent has an invalid size");
    }
    const bytes = new Uint8Array(stat.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (read.bytesRead !== bytes.byteLength) {
      throw new Error("Backup spool cleanup intent is truncated");
    }
    return IntentSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } finally {
    await handle.close();
  }
}

async function readTerminalIntent(file: string): Promise<TerminalCleanupIntent> {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INTENT_BYTES) {
      throw new Error("Terminal backup spool cleanup intent has an invalid size");
    }
    const bytes = new Uint8Array(stat.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (read.bytesRead !== bytes.byteLength) {
      throw new Error("Terminal backup spool cleanup intent is truncated");
    }
    return TerminalIntentSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } finally {
    await handle.close();
  }
}

async function readTerminalCandidate(file: string): Promise<TerminalCleanupCandidate> {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INTENT_BYTES) {
      throw new Error("Terminal backup spool cleanup candidate has an invalid size");
    }
    const bytes = new Uint8Array(stat.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (read.bytesRead !== bytes.byteLength) {
      throw new Error("Terminal backup spool cleanup candidate is truncated");
    }
    return TerminalCandidateSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } finally {
    await handle.close();
  }
}

async function ensureOutboxDirectory(
  stateDirectoryInput: string,
  directoryName = OUTBOX_DIRECTORY,
): Promise<string> {
  if (!path.isAbsolute(stateDirectoryInput)) {
    throw new Error("Backup spool cleanup StateDirectory must be absolute");
  }
  const stateDirectory = path.resolve(stateDirectoryInput);
  await fs.promises.mkdir(stateDirectory, { recursive: true, mode: DIRECTORY_MODE });
  const stateStat = await fs.promises.lstat(stateDirectory);
  const realStateDirectory = await fs.promises.realpath(stateDirectory);
  if (
    stateStat.isSymbolicLink() ||
    !stateStat.isDirectory() ||
    realStateDirectory !== stateDirectory
  ) {
    throw new Error("Backup spool cleanup StateDirectory is not a safe directory");
  }
  const realTemporaryDirectory = await fs.promises.realpath(os.tmpdir());
  const relativeToTemporary = path.relative(realTemporaryDirectory, stateDirectory);
  if (
    relativeToTemporary === "" ||
    (!relativeToTemporary.startsWith("..") && !path.isAbsolute(relativeToTemporary))
  ) {
    throw new Error("Backup spool cleanup StateDirectory must be persistent");
  }
  const outbox = path.join(stateDirectory, directoryName);
  await fs.promises.mkdir(outbox, { recursive: true, mode: DIRECTORY_MODE });
  const stat = await fs.promises.lstat(outbox);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Backup spool cleanup outbox is not a safe directory");
  }
  const real = await fs.promises.realpath(outbox);
  if (real !== outbox || path.dirname(real) !== stateDirectory) {
    throw new Error("Backup spool cleanup outbox escaped its StateDirectory");
  }
  return outbox;
}

async function persistIntent(params: {
  outbox: string;
  authority: Readonly<AgentBackupCaptureV3SpoolAuthority>;
  authorizedAt: string;
  nonce: string;
}): Promise<void> {
  const intent = IntentSchema.parse({
    format: OUTBOX_FORMAT,
    version: OUTBOX_VERSION,
    ...params.authority,
    authorizedAt: params.authorizedAt,
  });
  const finalPath = path.join(params.outbox, `${intent.operationId}.json`);
  try {
    const existing = await readIntent(finalPath);
    if (!sameAuthority(intentAuthority(existing), intentAuthority(intent))) {
      throw new Error("Backup spool cleanup operation already has different authority");
    }
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const temporaryPath = path.join(params.outbox, `.${intent.operationId}.${params.nonce}.tmp`);
  const bytes = new TextEncoder().encode(`${JSON.stringify(intent)}\n`);
  if (bytes.byteLength > MAX_INTENT_BYTES)
    throw new Error("Backup spool cleanup intent is too large");
  const handle = await fs.promises.open(
    temporaryPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    FILE_MODE,
  );
  let failure: unknown;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (cause) {
    failure = cause;
  }
  try {
    await handle.close();
  } catch (cause) {
    failure = failure === undefined ? cause : new AggregateError([failure, cause]);
  }
  if (failure !== undefined) {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw failure;
  }
  try {
    // Same-directory hard-link publication is create-only on POSIX. `rename`
    // would replace an existing different authority instead of failing closed.
    await fs.promises.link(temporaryPath, finalPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const existing = await readIntent(finalPath);
    if (!sameAuthority(intentAuthority(existing), intentAuthority(intent))) throw cause;
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
  await fsyncDirectory(params.outbox);
}

function sameTerminalIntent(
  left: Readonly<TerminalCleanupIntent>,
  right: Readonly<TerminalCleanupIntent>,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.agentId === right.agentId &&
    left.backupId === right.backupId &&
    left.operationId === right.operationId &&
    left.activationGeneration === right.activationGeneration &&
    left.lifecycleRevision === right.lifecycleRevision &&
    left.requestSha256 === right.requestSha256 &&
    left.authoritySha256 === right.authoritySha256 &&
    left.runtimePrincipalSha256 === right.runtimePrincipalSha256 &&
    left.terminalErrorCode === right.terminalErrorCode
  );
}

async function persistTerminalIntent(params: {
  outbox: string;
  authority: Readonly<AgentBackupCaptureV3TerminalSpoolCleanupAuthority>;
  terminalErrorCode: string;
  authorizedAt: string;
  nonce: string;
}): Promise<void> {
  const intent = TerminalIntentSchema.parse({
    format: TERMINAL_OUTBOX_FORMAT,
    version: OUTBOX_VERSION,
    ...params.authority,
    terminalErrorCode: params.terminalErrorCode,
    authorizedAt: params.authorizedAt,
  });
  const finalPath = path.join(params.outbox, `${intent.operationId}.json`);
  try {
    const existing = await readTerminalIntent(finalPath);
    if (!sameTerminalIntent(existing, intent)) {
      throw new Error("Terminal backup spool cleanup operation already has different authority");
    }
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const temporaryPath = path.join(params.outbox, `.${intent.operationId}.${params.nonce}.tmp`);
  const bytes = new TextEncoder().encode(`${JSON.stringify(intent)}\n`);
  if (bytes.byteLength > MAX_INTENT_BYTES) {
    throw new Error("Terminal backup spool cleanup intent is too large");
  }
  const handle = await fs.promises.open(
    temporaryPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    FILE_MODE,
  );
  let failure: unknown;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (cause) {
    failure = cause;
  }
  try {
    await handle.close();
  } catch (cause) {
    failure = failure === undefined ? cause : new AggregateError([failure, cause]);
  }
  if (failure !== undefined) {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw failure;
  }
  try {
    await fs.promises.link(temporaryPath, finalPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const existing = await readTerminalIntent(finalPath);
    if (!sameTerminalIntent(existing, intent)) throw cause;
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
  await fsyncDirectory(params.outbox);
}

function sameTerminalCandidate(
  left: Readonly<TerminalCleanupCandidate>,
  right: Readonly<TerminalCleanupCandidate>,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.agentId === right.agentId &&
    left.backupId === right.backupId &&
    left.operationId === right.operationId &&
    left.activationGeneration === right.activationGeneration &&
    left.lifecycleRevision === right.lifecycleRevision &&
    left.requestSha256 === right.requestSha256 &&
    left.authoritySha256 === right.authoritySha256 &&
    left.runtimePrincipalSha256 === right.runtimePrincipalSha256 &&
    left.terminalErrorCode === right.terminalErrorCode
  );
}

async function persistTerminalCandidate(params: {
  outbox: string;
  authority: Readonly<AgentBackupCaptureV3TerminalSpoolCleanupAuthority>;
  terminalErrorCode: string;
  stagedAt: string;
  nonce: string;
}): Promise<void> {
  const candidate = TerminalCandidateSchema.parse({
    format: TERMINAL_CANDIDATE_FORMAT,
    version: OUTBOX_VERSION,
    ...params.authority,
    terminalErrorCode: params.terminalErrorCode,
    stagedAt: params.stagedAt,
  });
  const finalPath = path.join(params.outbox, `${candidate.operationId}.json`);
  try {
    const existing = await readTerminalCandidate(finalPath);
    if (!sameTerminalCandidate(existing, candidate)) {
      throw new Error("Terminal backup spool cleanup candidate already has different authority");
    }
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const temporaryPath = path.join(params.outbox, `.${candidate.operationId}.${params.nonce}.tmp`);
  const bytes = new TextEncoder().encode(`${JSON.stringify(candidate)}\n`);
  if (bytes.byteLength > MAX_INTENT_BYTES) {
    throw new Error("Terminal backup spool cleanup candidate is too large");
  }
  const handle = await fs.promises.open(
    temporaryPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    FILE_MODE,
  );
  let failure: unknown;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (cause) {
    failure = cause;
  }
  try {
    await handle.close();
  } catch (cause) {
    failure = failure === undefined ? cause : new AggregateError([failure, cause]);
  }
  if (failure !== undefined) {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw failure;
  }
  try {
    await fs.promises.link(temporaryPath, finalPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const existing = await readTerminalCandidate(finalPath);
    if (!sameTerminalCandidate(existing, candidate)) throw cause;
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
  await fsyncDirectory(params.outbox);
}

async function listIntents(outbox: string, limit: number): Promise<CleanupIntent[]> {
  const entries = await fs.promises.readdir(outbox, { withFileTypes: true });
  const intents: CleanupIntent[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (OWNED_TEMPORARY_PATTERN.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Backup spool cleanup outbox contains an unsafe temporary entry");
      }
      // An in-flight concurrent writer may still own this create-only file.
      // It is ignored, not reaped, until an age-aware maintenance pass exists.
      continue;
    }
    if (!entry.name.endsWith(".json") || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Backup spool cleanup outbox contains an unsafe entry");
    }
    const operationId = entry.name.slice(0, -5);
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error("Backup spool cleanup outbox contains an invalid operation identity");
    }
    const intent = await readIntent(path.join(outbox, entry.name));
    if (intent.operationId !== operationId) {
      throw new Error("Backup spool cleanup intent differs from its filename");
    }
    intents.push(intent);
    if (intents.length >= limit) break;
  }
  return intents;
}

async function listTerminalIntents(
  outbox: string,
  limit: number,
): Promise<TerminalCleanupIntent[]> {
  const entries = await fs.promises.readdir(outbox, { withFileTypes: true });
  const intents: TerminalCleanupIntent[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (OWNED_TEMPORARY_PATTERN.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Terminal backup spool cleanup outbox contains an unsafe temporary entry");
      }
      continue;
    }
    if (!entry.name.endsWith(".json") || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Terminal backup spool cleanup outbox contains an unsafe entry");
    }
    const operationId = entry.name.slice(0, -5);
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error("Terminal backup spool cleanup outbox has an invalid operation identity");
    }
    const intent = await readTerminalIntent(path.join(outbox, entry.name));
    if (intent.operationId !== operationId) {
      throw new Error("Terminal backup spool cleanup intent differs from its filename");
    }
    intents.push(intent);
    if (intents.length >= limit) break;
  }
  return intents;
}

async function listTerminalCandidates(
  outbox: string,
  limit: number,
): Promise<TerminalCleanupCandidate[]> {
  const entries = await fs.promises.readdir(outbox, { withFileTypes: true });
  const candidates: TerminalCleanupCandidate[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (OWNED_TEMPORARY_PATTERN.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          "Terminal backup spool cleanup candidate outbox contains an unsafe temporary entry",
        );
      }
      continue;
    }
    if (!entry.name.endsWith(".json") || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Terminal backup spool cleanup candidate outbox contains an unsafe entry");
    }
    const operationId = entry.name.slice(0, -5);
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error(
        "Terminal backup spool cleanup candidate outbox has an invalid operation identity",
      );
    }
    const candidate = await readTerminalCandidate(path.join(outbox, entry.name));
    if (candidate.operationId !== operationId) {
      throw new Error("Terminal backup spool cleanup candidate differs from its filename");
    }
    candidates.push(candidate);
    if (candidates.length >= limit) break;
  }
  return candidates;
}

async function removeIntent(outbox: string, operationId: string): Promise<void> {
  await fs.promises.unlink(path.join(outbox, `${operationId}.json`)).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  });
  await fsyncDirectory(outbox);
}

type AccountDeletionSpoolAuthorityArtifact = {
  directory: string;
  operationId: string;
  organizationId: string;
};

function accountDeletionSpoolArtifactError(code: string, message: string, cause?: unknown): never {
  throw new ElizaError(message, { code, cause, severity: "fatal" });
}

async function existingAuthorityOutbox(
  stateDirectory: string,
  directoryName: string,
): Promise<string | null> {
  const resolvedState = path.resolve(stateDirectory);
  if (!path.isAbsolute(stateDirectory) || resolvedState !== stateDirectory) {
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_STATE_DIRECTORY_INVALID",
      "Account deletion spool authority requires an exact persistent StateDirectory",
    );
  }
  const outbox = path.join(resolvedState, directoryName);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(outbox);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    // error-policy:J2 preserve the filesystem failure behind a static authority error.
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_OUTBOX_UNAVAILABLE",
      "Account deletion spool authority could not inspect an outbox",
      cause,
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_OUTBOX_UNSAFE",
      "Account deletion spool authority encountered an unsafe outbox",
    );
  }
  const real = await fs.promises.realpath(outbox);
  if (real !== outbox || path.dirname(real) !== resolvedState) {
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_OUTBOX_UNSAFE",
      "Account deletion spool authority outbox escaped its StateDirectory",
    );
  }
  const entries = await fs.promises.readdir(outbox, { withFileTypes: true });
  if (entries.some((entry) => OWNED_TEMPORARY_PATTERN.test(entry.name))) {
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_OUTBOX_BUSY",
      "Account deletion spool authority found an in-flight outbox write",
    );
  }
  return outbox;
}

async function requireAccountDeletionSpoolStateDirectory(stateDirectory: string): Promise<void> {
  const resolvedState = path.resolve(stateDirectory);
  if (!path.isAbsolute(stateDirectory) || resolvedState !== stateDirectory) {
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_STATE_DIRECTORY_INVALID",
      "Account deletion spool authority requires an exact persistent StateDirectory",
    );
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(resolvedState);
  } catch (cause) {
    // error-policy:J2 a missing or unmounted authority root cannot prove absence.
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_STATE_DIRECTORY_UNAVAILABLE",
      "Account deletion spool authority StateDirectory is unavailable",
      cause,
    );
  }
  const real = await fs.promises.realpath(resolvedState);
  if (stat.isSymbolicLink() || !stat.isDirectory() || real !== resolvedState) {
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_STATE_DIRECTORY_UNSAFE",
      "Account deletion spool authority StateDirectory is not an exact directory",
    );
  }
  const realTemporaryDirectory = await fs.promises.realpath(os.tmpdir());
  const relativeToTemporary = path.relative(realTemporaryDirectory, resolvedState);
  if (
    relativeToTemporary === "" ||
    (!relativeToTemporary.startsWith("..") && !path.isAbsolute(relativeToTemporary))
  ) {
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_STATE_DIRECTORY_UNSAFE",
      "Account deletion spool authority StateDirectory must be persistent",
    );
  }
}

async function listAccountDeletionSpoolAuthorityArtifacts(
  stateDirectory: string,
): Promise<readonly AccountDeletionSpoolAuthorityArtifact[]> {
  await requireAccountDeletionSpoolStateDirectory(stateDirectory);
  const artifacts: AccountDeletionSpoolAuthorityArtifact[] = [];
  const protectedOutbox = await existingAuthorityOutbox(stateDirectory, OUTBOX_DIRECTORY);
  if (protectedOutbox) {
    for (const intent of await listIntents(protectedOutbox, Number.MAX_SAFE_INTEGER)) {
      artifacts.push({
        directory: protectedOutbox,
        operationId: intent.operationId,
        organizationId: intent.organizationId,
      });
    }
  }
  const terminalOutbox = await existingAuthorityOutbox(stateDirectory, TERMINAL_OUTBOX_DIRECTORY);
  if (terminalOutbox) {
    for (const intent of await listTerminalIntents(terminalOutbox, Number.MAX_SAFE_INTEGER)) {
      artifacts.push({
        directory: terminalOutbox,
        operationId: intent.operationId,
        organizationId: intent.organizationId,
      });
    }
  }
  const terminalCandidates = await existingAuthorityOutbox(
    stateDirectory,
    TERMINAL_CANDIDATE_DIRECTORY,
  );
  if (terminalCandidates) {
    for (const intent of await listTerminalCandidates(
      terminalCandidates,
      Number.MAX_SAFE_INTEGER,
    )) {
      artifacts.push({
        directory: terminalCandidates,
        operationId: intent.operationId,
        organizationId: intent.organizationId,
      });
    }
  }
  return Object.freeze(artifacts);
}

/** Inspect durable janitor authority files without creating a missing outbox. */
export async function inspectAgentBackupOrganizationSpoolAuthorityArtifacts(input: {
  stateDirectory: string;
  organizationId: string;
}): Promise<"absent" | "present"> {
  if (!UUID_PATTERN.test(input.organizationId)) {
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_ORGANIZATION_INVALID",
      "Account deletion spool authority requires a canonical organization identity",
    );
  }
  return (await listAccountDeletionSpoolAuthorityArtifacts(input.stateDirectory)).some(
    (artifact) => artifact.organizationId === input.organizationId,
  )
    ? "present"
    : "absent";
}

/** Remove only janitor authority files already bound to the exact organization. */
export async function purgeAgentBackupOrganizationSpoolAuthorityArtifacts(input: {
  stateDirectory: string;
  organizationId: string;
}): Promise<void> {
  if (!UUID_PATTERN.test(input.organizationId)) {
    accountDeletionSpoolArtifactError(
      "ACCOUNT_DELETION_SPOOL_ORGANIZATION_INVALID",
      "Account deletion spool authority requires a canonical organization identity",
    );
  }
  const artifacts = await listAccountDeletionSpoolAuthorityArtifacts(input.stateDirectory);
  for (const artifact of artifacts) {
    if (artifact.organizationId === input.organizationId) {
      await removeIntent(artifact.directory, artifact.operationId);
    }
  }
}

function canonicalAuthorizedAt(now: number): string {
  if (!Number.isSafeInteger(now) || now < 1)
    throw new Error("Backup spool cleanup clock is invalid");
  return new Date(now).toISOString();
}

function assertTerminalCleanupAuthorization(params: {
  backup: Readonly<StoredAgentSandboxBackup>;
  authority: Readonly<AgentBackupCaptureV3TerminalSpoolCleanupAuthority>;
  terminalErrorCode: string;
}): void {
  const { backup, authority } = params;
  if (
    backup.catalog_version !== 2 ||
    backup.catalog_state !== "failed_terminal" ||
    backup.catalog_resume_state !== "capturing" ||
    backup.id !== authority.backupId ||
    backup.catalog_organization_id !== authority.organizationId ||
    backup.catalog_agent_id !== authority.agentId ||
    backup.backup_operation_id !== authority.operationId ||
    backup.lifecycle_generation !== authority.activationGeneration ||
    backup.lifecycle_revision?.toString() !== authority.lifecycleRevision ||
    backup.catalog_last_error_code !== params.terminalErrorCode ||
    backup.manifest_digest !== null ||
    backup.object_inventory_digest !== null
  ) {
    throw new Error(
      "Terminal spool cleanup requires the exact confirmed pre-publication failure authority",
    );
  }
  TerminalIntentSchema.pick({
    organizationId: true,
    agentId: true,
    backupId: true,
    operationId: true,
    activationGeneration: true,
    lifecycleRevision: true,
    requestSha256: true,
    authoritySha256: true,
    runtimePrincipalSha256: true,
    terminalErrorCode: true,
  }).parse({ ...authority, terminalErrorCode: params.terminalErrorCode });
}

export function createAgentBackupCaptureV3SpoolCleanupJanitor(
  config: Readonly<AgentBackupCaptureV3SpoolCleanupJanitorConfig>,
  dependenciesInput: Partial<AgentBackupCaptureV3SpoolCleanupDependencies> = {},
): AgentBackupCaptureV3SpoolCleanupJanitor {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
  const limit = batchSize(config.batchSize);

  const authorizeAndPersist = async (
    outbox: string,
    authority: Readonly<AgentBackupCaptureV3SpoolAuthority>,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const authorized = await dependencies.authorize(authorizationInput(authority));
    signal?.throwIfAborted();
    const rederived = await dependencies.deriveAuthority(authorized);
    signal?.throwIfAborted();
    if (!sameAuthority(authority, rederived)) {
      throw new Error("Protected cleanup repository returned different spool authority");
    }
    signal?.throwIfAborted();
    await persistIntent({
      outbox,
      authority,
      authorizedAt: canonicalAuthorizedAt(dependencies.now()),
      nonce: dependencies.executionToken(),
    });
    signal?.throwIfAborted();
  };

  return {
    async enqueueProtectedBackup(backup) {
      await dependencies.listDurableOperations(config.spool);
      const outbox = await ensureOutboxDirectory(config.spool.stateDirectory);
      const authority = await dependencies.deriveAuthority(backup);
      await authorizeAndPersist(outbox, authority);
      const candidateOutbox = await ensureOutboxDirectory(
        config.spool.stateDirectory,
        TERMINAL_CANDIDATE_DIRECTORY,
      );
      await removeIntent(candidateOutbox, authority.operationId);
      return "pending";
    },

    async stageTerminalFailure(input) {
      TerminalCandidateSchema.pick({
        organizationId: true,
        agentId: true,
        backupId: true,
        operationId: true,
        activationGeneration: true,
        lifecycleRevision: true,
        requestSha256: true,
        authoritySha256: true,
        runtimePrincipalSha256: true,
        terminalErrorCode: true,
      }).parse({ ...input.authority, terminalErrorCode: input.terminalErrorCode });
      const durable = await dependencies.listDurableOperations(config.spool);
      const operation = durable.find(
        (candidate) => candidate.operationId === input.authority.operationId,
      );
      if (
        operation &&
        (operation.requestSha256 !== input.authority.requestSha256 ||
          operation.authoritySha256 !== input.authority.authoritySha256 ||
          operation.runtimePrincipalSha256 !== input.authority.runtimePrincipalSha256 ||
          operation.recordCaptured)
      ) {
        throw new Error("Terminal spool cleanup candidate differs from durable capture state");
      }
      const outbox = await ensureOutboxDirectory(
        config.spool.stateDirectory,
        TERMINAL_CANDIDATE_DIRECTORY,
      );
      await persistTerminalCandidate({
        outbox,
        authority: input.authority,
        terminalErrorCode: input.terminalErrorCode,
        stagedAt: canonicalAuthorizedAt(dependencies.now()),
        nonce: dependencies.executionToken(),
      });
      return "pending";
    },

    async runCycle(signal) {
      const throwIfAborted = (): void => signal?.throwIfAborted();
      throwIfAborted();
      const summary: AgentBackupCaptureV3SpoolCleanupSummary = {
        discovered: 0,
        authorized: 0,
        completed: 0,
        pending: 0,
        skippedUnprotected: 0,
        indeterminate: 0,
      };
      throwIfAborted();
      const durable = await dependencies.listDurableOperations(config.spool);
      throwIfAborted();
      const outbox = await ensureOutboxDirectory(config.spool.stateDirectory);
      throwIfAborted();
      const terminalOutbox = await ensureOutboxDirectory(
        config.spool.stateDirectory,
        TERMINAL_OUTBOX_DIRECTORY,
      );
      throwIfAborted();
      const terminalCandidateOutbox = await ensureOutboxDirectory(
        config.spool.stateDirectory,
        TERMINAL_CANDIDATE_DIRECTORY,
      );
      throwIfAborted();
      summary.discovered = durable.length;
      const terminalCandidates = await listTerminalCandidates(terminalCandidateOutbox, limit);
      throwIfAborted();
      for (const candidate of terminalCandidates) {
        throwIfAborted();
        const operation = durable.find(
          (durableOperation) => durableOperation.operationId === candidate.operationId,
        );
        if (!operation) {
          throwIfAborted();
          await removeIntent(terminalCandidateOutbox, candidate.operationId);
          throwIfAborted();
          continue;
        }
        if (operation.recordCaptured) {
          // A confirmed local handoff is written only after exact catalogue
          // proof. The stale pre-CAS candidate must never block publication or
          // the later protected-spool cleanup path.
          throwIfAborted();
          await removeIntent(terminalCandidateOutbox, candidate.operationId);
          throwIfAborted();
          continue;
        }
        if (
          operation.requestSha256 !== candidate.requestSha256 ||
          operation.authoritySha256 !== candidate.authoritySha256 ||
          operation.runtimePrincipalSha256 !== candidate.runtimePrincipalSha256
        ) {
          summary.indeterminate += 1;
          continue;
        }
        try {
          throwIfAborted();
          const authority = terminalCleanupAuthority(candidate);
          const authorized = await dependencies.authorizeTerminal(
            terminalAuthorizationInput(candidate),
          );
          throwIfAborted();
          assertTerminalCleanupAuthorization({
            backup: authorized,
            authority,
            terminalErrorCode: candidate.terminalErrorCode,
          });
          throwIfAborted();
          await persistTerminalIntent({
            outbox: terminalOutbox,
            authority,
            terminalErrorCode: candidate.terminalErrorCode,
            authorizedAt: canonicalAuthorizedAt(dependencies.now()),
            nonce: dependencies.executionToken(),
          });
          throwIfAborted();
          await removeIntent(terminalCandidateOutbox, candidate.operationId);
          throwIfAborted();
          summary.authorized += 1;
        } catch {
          throwIfAborted();
          // A staged candidate is deliberately non-authorizing. Keep it until
          // the exact terminal row becomes visible or a confirmed handoff makes
          // the candidate stale.
          summary.pending += 1;
        }
      }
      throwIfAborted();
      const terminalIntents = await listTerminalIntents(terminalOutbox, limit);
      throwIfAborted();
      const terminalOperationIds = new Set(terminalIntents.map((intent) => intent.operationId));
      const protectedIntents = await listIntents(outbox, MAX_BATCH_SIZE);
      throwIfAborted();
      const existingIntents = new Set(protectedIntents.map((intent) => intent.operationId));
      for (const operation of durable.slice(0, limit)) {
        throwIfAborted();
        if (
          existingIntents.has(operation.operationId) ||
          terminalOperationIds.has(operation.operationId)
        ) {
          continue;
        }
        if (!operation.recordCaptured || operation.phase !== "published") {
          summary.skippedUnprotected += 1;
          continue;
        }
        try {
          throwIfAborted();
          const candidates = await dependencies.listCandidates({
            operationId: operation.operationId,
          });
          throwIfAborted();
          const matches: AgentBackupCaptureV3SpoolAuthority[] = [];
          for (const candidate of candidates) {
            throwIfAborted();
            const authority = await dependencies.deriveAuthority(candidate);
            throwIfAborted();
            if (
              authority.operationId === operation.operationId &&
              authority.requestSha256 === operation.requestSha256 &&
              authority.authoritySha256 === operation.authoritySha256
            ) {
              matches.push(authority);
            }
          }
          if (matches.length === 0) {
            summary.skippedUnprotected += 1;
            continue;
          }
          if (matches.length !== 1) throw new Error("Protected cleanup authority is ambiguous");
          throwIfAborted();
          await authorizeAndPersist(outbox, matches[0]!, signal);
          throwIfAborted();
          await removeIntent(terminalCandidateOutbox, operation.operationId);
          throwIfAborted();
          existingIntents.add(operation.operationId);
          summary.authorized += 1;
        } catch {
          throwIfAborted();
          summary.indeterminate += 1;
        }
      }

      for (const intent of terminalIntents) {
        throwIfAborted();
        let spool: AgentBackupCaptureV3Spool | undefined;
        try {
          throwIfAborted();
          const authority = terminalCleanupAuthority(intent);
          const authorized = await dependencies.authorizeTerminal(
            terminalAuthorizationInput(intent),
          );
          throwIfAborted();
          assertTerminalCleanupAuthorization({
            backup: authorized,
            authority,
            terminalErrorCode: intent.terminalErrorCode,
          });
          throwIfAborted();
          spool = await dependencies.openExisting(config.spool, {
            operationId: intent.operationId,
            executionToken: dependencies.executionToken(),
            requestSha256: intent.requestSha256,
            authoritySha256: intent.authoritySha256,
            runtimePrincipalSha256: intent.runtimePrincipalSha256,
          });
          throwIfAborted();
          if (!spool) {
            await removeIntent(terminalOutbox, intent.operationId);
            throwIfAborted();
            summary.completed += 1;
            continue;
          }
          if (spool.recordCaptured) {
            await spool.close();
            throwIfAborted();
            summary.indeterminate += 1;
            continue;
          }
          throwIfAborted();
          const receipt = await spool.cleanup();
          throwIfAborted();
          if (receipt.status === "complete") {
            await removeIntent(terminalOutbox, intent.operationId);
            throwIfAborted();
            summary.completed += 1;
          } else {
            await spool.close();
            throwIfAborted();
            summary.pending += 1;
          }
        } catch {
          throwIfAborted();
          if (spool) await spool.close().catch(() => undefined);
          throwIfAborted();
          summary.pending += 1;
        }
      }

      throwIfAborted();
      const protectedCleanupLimit = Math.max(0, limit - terminalIntents.length);
      const intents =
        protectedCleanupLimit > 0 ? await listIntents(outbox, protectedCleanupLimit) : [];
      throwIfAborted();
      for (const intent of intents) {
        throwIfAborted();
        const authority = intentAuthority(intent);
        let spool: AgentBackupCaptureV3Spool | undefined;
        try {
          throwIfAborted();
          const authorized = await dependencies.authorize(authorizationInput(authority));
          throwIfAborted();
          const rederived = await dependencies.deriveAuthority(authorized);
          throwIfAborted();
          if (!sameAuthority(authority, rederived)) {
            throw new Error("Protected cleanup intent no longer matches catalogue authority");
          }
          throwIfAborted();
          spool = await dependencies.openExisting(config.spool, {
            operationId: authority.operationId,
            executionToken: dependencies.executionToken(),
            requestSha256: authority.requestSha256,
            authoritySha256: authority.authoritySha256,
          });
          throwIfAborted();
          if (!spool) {
            await removeIntent(outbox, authority.operationId);
            throwIfAborted();
            await removeIntent(terminalCandidateOutbox, authority.operationId);
            throwIfAborted();
            summary.completed += 1;
            continue;
          }
          if (!spool.recordCaptured || spool.phase !== "published") {
            await spool.close();
            throwIfAborted();
            summary.pending += 1;
            continue;
          }
          throwIfAborted();
          const receipt = await spool.cleanup();
          throwIfAborted();
          if (receipt.status === "complete") {
            await removeIntent(outbox, authority.operationId);
            throwIfAborted();
            await removeIntent(terminalCandidateOutbox, authority.operationId);
            throwIfAborted();
            summary.completed += 1;
          } else {
            await spool.close();
            throwIfAborted();
            summary.pending += 1;
          }
        } catch {
          throwIfAborted();
          if (spool) await spool.close().catch(() => undefined);
          throwIfAborted();
          summary.pending += 1;
        }
      }
      throwIfAborted();
      return summary;
    },
  };
}
