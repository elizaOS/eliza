/**
 * Produces a sequential, provider-neutral capture-v2 stream directly from an
 * agent runtime and its local state. The service never calls the legacy JSON
 * snapshot path, never base64-encodes payloads, and retains at most one bounded
 * data frame while downstream backpressure is applied. PGlite 0.4.x remains a
 * bounded materializing exception, enforced by the physical/RSS gate below.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { freemem } from "node:os";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import {
  AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  type AgentBackupCaptureV2ComponentDescriptor,
  AgentBackupCaptureV2ComponentDescriptorSchema,
  type AgentBackupCaptureV2FileEntry,
  type AgentBackupCaptureV2FrameHeader,
  type AgentBackupCaptureV2Request,
  compareAgentBackupCaptureV2FilePaths,
  parseAgentBackupCaptureV2Request,
  readAgentBackupCaptureV2FrameDigest,
  serializeAgentBackupCaptureV2Frame,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import { resolveStateDir, resolveUserPath } from "../config/paths.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";

const MEDIA_DIR_NAME = "media";
const BACKUPS_DIR_NAME = "backups";
const MODELS_DIR_NAME = "models";
const TOOL_CACHE_DIR_NAME = "tool-cache";
const CACHE_DIR_NAME = "cache";
const ACTIVATION_DIR_NAME = ".activation";
const DEFAULT_PGLITE_DIR_NAME = ".elizadb";
const VAULT_PGLITE_DIR_NAME = ".vault-pglite";
const VAULT_AUDIT_DIR_NAME = "audit";
const VAULT_AUDIT_PATH = "audit/vault.jsonl";
const VAULT_JSON_PATH = "vault.json";
const MIB = 1024 * 1024;
const PGLITE_CAPTURE_AVAILABLE_MEMORY_HEADROOM_BYTES = 32 * MIB;

/**
 * PGlite 0.4.x materializes the file list, tar, gzip chunks, joined gzip bytes,
 * and Blob before capture can stream the result. The gate reserves eight
 * archive-sized additional-memory copies (including GC overlap and the
 * downstream frame) plus 32 MiB of emergency headroom from the memory Node/Bun
 * reports as still available to this process. This is cgroup-aware in supported
 * runtimes and does not incorrectly charge the already-resident PGlite WASM
 * heap a second time. The archive estimate charges 4 KiB per entry plus 1 MiB
 * fixed tar/gzip overhead.
 */
export const AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS = Object.freeze({
  /**
   * Terminal ceiling: a directory this large can never pass the available-memory
   * gate below, so failing fast is honest rather than making the caller retry.
   *
   * It has to sit between two measured bounds, and at 40 MiB it sat effectively
   * on the lower one. A freshly initialised PGlite cluster measures 38.0 MiB
   * with zero user data, so the old ceiling left 2 MiB for everything an agent
   * ever writes and tipped over once pgvector and fuzzystrmatch loaded. Because
   * this failure is `fatal`, that did not merely block a backup — it made the
   * agent permanently undeletable (#23116). The upper bound is where the memory gate
   * becomes unsatisfiable: a default 3072 MiB container boots at ~2.1 GiB RSS,
   * leaving ~950 MiB, and the gate needs `archive * 8 + 32 MiB`, so anything
   * past roughly 115 MiB of archive can never succeed anywhere on the fleet.
   *
   * 128 MiB is inside that window with room on both sides. Real capacity
   * pressure is the memory gate's job, and it fails `ephemeral` so it retries.
   */
  maxPhysicalBytes: 128 * MIB,
  availableMemoryHeadroomBytes: PGLITE_CAPTURE_AVAILABLE_MEMORY_HEADROOM_BYTES,
  archiveCopyFactor: 8,
  archiveEntryOverheadBytes: 4 * 1024,
  archiveBaseOverheadBytes: MIB,
});

export interface AgentBackupV2CaptureSourceChunk {
  bytes: Uint8Array;
  /** Required for file-set sources; absent for opaque/record streams. */
  entry?: AgentBackupCaptureV2FileEntry;
}

/** Minimal runtime surface needed by capture; deliberately excludes providers. */
export interface AgentBackupV2CaptureRuntime {
  agentId: string;
  character?: unknown;
  adapter?: unknown;
  getSetting?(key: string): unknown;
}

export interface AgentBackupV2CaptureComponentSource {
  descriptor: AgentBackupCaptureV2ComponentDescriptor;
  /** Optional pre-header preparation for sources that must fail before commit. */
  prepare?(signal: AbortSignal): Promise<void>;
  /** Release any prepared source state when the enclosing capture closes. */
  dispose?(): void;
  open(signal: AbortSignal): AsyncIterable<AgentBackupV2CaptureSourceChunk>;
}

export interface StreamAgentBackupV2CaptureOptions {
  request: AgentBackupCaptureV2Request;
  agentId: string;
  components: readonly AgentBackupV2CaptureComponentSource[];
  signal?: AbortSignal;
  now?: () => number;
}

export interface CreateAgentBackupV2CaptureOptions {
  signal?: AbortSignal;
  components?: readonly AgentBackupV2CaptureComponentSource[];
  now?: () => number;
}

export class AgentBackupV2CaptureError extends ElizaError {
  override readonly name = "AgentBackupV2CaptureError";

  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>,
    options?: { cause?: unknown; severity?: "ephemeral" | "fatal" },
  ) {
    super(message, {
      code,
      context,
      cause: options?.cause,
      severity: options?.severity,
    });
  }
}

function captureError(
  message: string,
  code: string,
  context?: Record<string, unknown>,
  options?: { cause?: unknown; severity?: "ephemeral" | "fatal" },
): never {
  throw new AgentBackupV2CaptureError(message, code, context, options);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason instanceof Error ? signal.reason : undefined;
}

function sourceAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AgentBackupV2CaptureError(
        "Agent backup capture was cancelled",
        "AGENT_BACKUP_V2_CAPTURE_ABORTED",
        undefined,
        { severity: "ephemeral" },
      );
}

function assertCaptureActive(
  request: AgentBackupCaptureV2Request,
  signal: AbortSignal | undefined,
  now: () => number,
): void {
  if (signal?.aborted) {
    if (signal.reason instanceof AgentBackupV2CaptureError) {
      throw signal.reason;
    }
    captureError(
      "Agent backup capture was cancelled",
      "AGENT_BACKUP_V2_CAPTURE_ABORTED",
      { operationId: request.operationId },
      { cause: abortReason(signal), severity: "ephemeral" },
    );
  }
  if (now() >= request.deadlineEpochMs) {
    captureError(
      "Agent backup capture deadline exceeded",
      "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
      {
        operationId: request.operationId,
        deadlineEpochMs: request.deadlineEpochMs,
      },
      { severity: "ephemeral" },
    );
  }
}

async function awaitWithCaptureControl<T>(
  operation: () => PromiseLike<T>,
  request: AgentBackupCaptureV2Request,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<T> {
  assertCaptureActive(request, signal, now);
  const value = Promise.resolve(operation());
  const remainingMs = request.deadlineEpochMs - now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new AgentBackupV2CaptureError(
            "Agent backup capture deadline exceeded",
            "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
            {
              operationId: request.operationId,
              deadlineEpochMs: request.deadlineEpochMs,
            },
            { severity: "ephemeral" },
          ),
        ),
      Math.min(remainingMs, 2_147_483_647),
    );
    if (signal) {
      abortListener = () =>
        reject(
          signal.reason instanceof AgentBackupV2CaptureError
            ? signal.reason
            : new AgentBackupV2CaptureError(
                "Agent backup capture was cancelled",
                "AGENT_BACKUP_V2_CAPTURE_ABORTED",
                { operationId: request.operationId },
                { cause: abortReason(signal), severity: "ephemeral" },
              ),
        );
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    return await Promise.race([value, interrupted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function nodeSha256Digest(bytes: Uint8Array): Uint8Array {
  return createHash("sha256").update(bytes).digest();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelativePath(input: string): string {
  const normalized = path.posix.normalize(input.replaceAll(path.sep, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    captureError(
      `Invalid backup path: ${input}`,
      "AGENT_BACKUP_V2_INVALID_PATH",
      { path: input },
      { severity: "fatal" },
    );
  }
  return normalized;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveCaptureDirectoryIdentity(
  directory: string,
  role: "pglite" | "state",
): string {
  const resolved = path.resolve(directory);
  try {
    const physical = fs.realpathSync.native(resolved);
    if (!fs.statSync(physical).isDirectory()) {
      captureError(
        `Agent backup ${role} path is not a directory`,
        "AGENT_BACKUP_V2_DIRECTORY_IDENTITY_INVALID",
        { role, path: resolved },
        { severity: "fatal" },
      );
    }
    return physical;
  } catch (error) {
    if (error instanceof AgentBackupV2CaptureError) throw error;
    // error-policy:J2 a missing, dangling, or unreadable path has no stable
    // physical identity, so capture cannot prove component disjointness.
    throw new AgentBackupV2CaptureError(
      `Agent backup could not resolve the ${role} directory identity`,
      "AGENT_BACKUP_V2_DIRECTORY_IDENTITY_UNRESOLVED",
      { role, path: resolved },
      { cause: error, severity: "fatal" },
    );
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function resolveStateFilesPgliteExclusion(
  stateDir: string,
  pgliteDir: string,
): string | null {
  const physicalStateDir = resolveCaptureDirectoryIdentity(stateDir, "state");
  const physicalPgliteDir = resolveCaptureDirectoryIdentity(
    pgliteDir,
    "pglite",
  );

  if (isWithin(physicalPgliteDir, physicalStateDir)) {
    captureError(
      "PGlite cannot contain or equal the agent state directory during capture",
      "AGENT_BACKUP_V2_PGLITE_STATE_OVERLAP",
      { stateDir: physicalStateDir, pgliteDir: physicalPgliteDir },
      { severity: "fatal" },
    );
  }
  if (!isWithin(physicalStateDir, physicalPgliteDir)) return null;

  const mediaDir = path.join(physicalStateDir, MEDIA_DIR_NAME);
  const vaultPgliteDir = path.join(physicalStateDir, VAULT_PGLITE_DIR_NAME);
  const vaultAuditDir = path.join(physicalStateDir, VAULT_AUDIT_DIR_NAME);
  if (
    pathsOverlap(mediaDir, physicalPgliteDir) ||
    pathsOverlap(vaultPgliteDir, physicalPgliteDir) ||
    physicalPgliteDir === vaultAuditDir
  ) {
    captureError(
      "PGlite overlaps another dedicated backup component",
      "AGENT_BACKUP_V2_PGLITE_COMPONENT_OVERLAP",
      { stateDir: physicalStateDir, pgliteDir: physicalPgliteDir },
      { severity: "fatal" },
    );
  }

  return normalizeRelativePath(
    path.relative(physicalStateDir, physicalPgliteDir),
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface PglitePhysicalPreflight {
  physicalBytes: number;
  estimatedArchiveBytes: number;
  entryCount: number;
  availableMemoryBytes: number;
  additionalMemoryBudgetBytes: number;
  requiredAvailableMemoryBytes: number;
}

/** Remaining memory available to this process, cgroup-aware when supported. */
export function resolveAgentBackupAvailableMemoryBytes(): number {
  const processAvailableMemory = process.availableMemory?.();
  if (
    typeof processAvailableMemory === "number" &&
    Number.isSafeInteger(processAvailableMemory) &&
    processAvailableMemory >= 0
  ) {
    return processAvailableMemory;
  }
  const hostFreeMemory = freemem();
  if (Number.isSafeInteger(hostFreeMemory) && hostFreeMemory >= 0) {
    return hostFreeMemory;
  }
  captureError(
    "Available memory could not be proven before PGlite export",
    "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
    undefined,
    { severity: "fatal" },
  );
}

function roundUpTarBlock(bytes: bigint): bigint {
  const block = 512n;
  return ((bytes + block - 1n) / block) * block;
}

function sameDirectoryIdentity(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs
  );
}

export async function preflightPglitePhysicalDirectory(
  physicalRoot: string,
  signal: AbortSignal,
  agentId: string,
  options: { archiveCopyFactor?: number } = {},
): Promise<PglitePhysicalPreflight> {
  const limits = AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS;
  let physicalBytes = 0n;
  let estimatedArchiveBytes = BigInt(limits.archiveBaseOverheadBytes);
  let entryCount = 0;
  const pendingDirectories = [physicalRoot];

  try {
    while (pendingDirectories.length > 0) {
      if (signal.aborted) throw sourceAbortError(signal);
      const directory = pendingDirectories.pop();
      if (!directory) break;
      const before = await fs.promises.lstat(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) {
        captureError(
          "PGlite physical-size preflight encountered an unsafe directory",
          "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
          { agentId },
          { severity: "fatal" },
        );
      }

      const entries = await fs.promises.opendir(directory);
      for await (const entry of entries) {
        if (signal.aborted) throw sourceAbortError(signal);
        entryCount += 1;
        if (entryCount > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFiles) {
          captureError(
            "PGlite physical-size preflight exceeds the entry-count limit",
            "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_ENTRY_LIMIT",
            { agentId, entryCount },
            { severity: "fatal" },
          );
        }

        const absolutePath = path.join(directory, entry.name);
        if (!isWithin(physicalRoot, absolutePath)) {
          captureError(
            "PGlite physical-size preflight escaped its configured root",
            "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
            { agentId },
            { severity: "fatal" },
          );
        }
        const stats = await fs.promises.lstat(absolutePath, { bigint: true });
        if (stats.isSymbolicLink()) {
          captureError(
            "PGlite physical-size preflight refuses symbolic links",
            "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
            { agentId },
            { severity: "fatal" },
          );
        }

        estimatedArchiveBytes += BigInt(limits.archiveEntryOverheadBytes);
        if (stats.isDirectory()) {
          pendingDirectories.push(absolutePath);
          continue;
        }
        if (!stats.isFile() || stats.size < 0n) {
          captureError(
            "PGlite physical-size preflight encountered a non-regular entry",
            "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
            { agentId },
            { severity: "fatal" },
          );
        }

        physicalBytes += stats.size;
        if (physicalBytes > BigInt(limits.maxPhysicalBytes)) {
          captureError(
            "PGlite exceeds the bounded materializing-export size limit",
            "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
            {
              agentId,
              maxPhysicalBytes: limits.maxPhysicalBytes,
              observedPhysicalBytes: physicalBytes.toString(),
            },
            { severity: "fatal" },
          );
        }
        estimatedArchiveBytes += roundUpTarBlock(stats.size);
      }

      const after = await fs.promises.lstat(directory, { bigint: true });
      if (!sameDirectoryIdentity(before, after)) {
        captureError(
          "PGlite changed while its physical size was being proven",
          "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_CHANGED",
          { agentId },
          { severity: "ephemeral" },
        );
      }
    }
  } catch (error) {
    if (error instanceof AgentBackupV2CaptureError) throw error;
    throw new AgentBackupV2CaptureError(
      "PGlite physical size could not be proven before export",
      "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
      { agentId },
      { cause: error, severity: "fatal" },
    );
  }

  const estimatedArchive = Number(estimatedArchiveBytes);
  const archiveCopyFactor =
    options.archiveCopyFactor ?? limits.archiveCopyFactor;
  if (
    !Number.isSafeInteger(archiveCopyFactor) ||
    archiveCopyFactor < limits.archiveCopyFactor
  ) {
    captureError(
      "PGlite export requested an invalid archive-copy budget",
      "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
      { agentId, archiveCopyFactor },
      { severity: "fatal" },
    );
  }
  const additionalMemoryBudgetBytes = estimatedArchive * archiveCopyFactor;
  const requiredAvailableMemoryBytes =
    additionalMemoryBudgetBytes + limits.availableMemoryHeadroomBytes;
  const availableMemoryBytes = resolveAgentBackupAvailableMemoryBytes();
  if (availableMemoryBytes < requiredAvailableMemoryBytes) {
    captureError(
      "PGlite export would exceed the available-memory budget",
      // This deployed wire code remains stable for Cloud failure classification.
      "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED",
      {
        agentId,
        availableMemoryBytes,
        estimatedArchiveBytes: estimatedArchive,
        archiveCopyFactor,
        additionalMemoryBudgetBytes,
        requiredAvailableMemoryBytes,
        availableMemoryHeadroomBytes: limits.availableMemoryHeadroomBytes,
      },
      { severity: "ephemeral" },
    );
  }

  return {
    physicalBytes: Number(physicalBytes),
    estimatedArchiveBytes: estimatedArchive,
    entryCount,
    availableMemoryBytes,
    additionalMemoryBudgetBytes,
    requiredAvailableMemoryBytes,
  };
}

async function* splitOpaqueBytes(
  bytes: Uint8Array,
): AsyncGenerator<AgentBackupV2CaptureSourceChunk> {
  for (
    let offset = 0;
    offset < bytes.length;
    offset += AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes
  ) {
    yield {
      bytes: bytes.subarray(
        offset,
        Math.min(
          bytes.length,
          offset + AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
        ),
      ),
    };
  }
}

async function* walkFiles(
  root: string,
  include: ((relativePath: string) => boolean) | undefined,
  signal: AbortSignal,
): AsyncGenerator<{ absolutePath: string; relativePath: string }> {
  const resolvedRoot = path.resolve(root);
  if (!(await pathExists(resolvedRoot))) return;

  async function* visit(
    directory: string,
  ): AsyncGenerator<{ absolutePath: string; relativePath: string }> {
    if (signal.aborted) {
      captureError(
        "Agent backup file walk was cancelled",
        "AGENT_BACKUP_V2_CAPTURE_ABORTED",
        undefined,
        { cause: abortReason(signal), severity: "ephemeral" },
      );
    }
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    entries.sort((left, right) =>
      compareAgentBackupCaptureV2FilePaths(
        `${left.name}${left.isDirectory() ? "/" : ""}`,
        `${right.name}${right.isDirectory() ? "/" : ""}`,
      ),
    );
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (!isWithin(resolvedRoot, absolutePath)) continue;
      const relativePath = normalizeRelativePath(
        path.relative(resolvedRoot, absolutePath),
      );
      if (include && !include(relativePath)) continue;
      if (entry.isDirectory()) {
        yield* visit(absolutePath);
      } else if (entry.isFile()) {
        yield { absolutePath, relativePath };
      }
    }
  }

  yield* visit(resolvedRoot);
}

function fileSetSource(
  descriptor: AgentBackupCaptureV2ComponentDescriptor,
  root: string,
  include?: (relativePath: string) => boolean,
): AgentBackupV2CaptureComponentSource {
  return {
    descriptor,
    async *open(signal) {
      let fileCount = 0;
      for await (const file of walkFiles(root, include, signal)) {
        fileCount += 1;
        if (fileCount > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFiles) {
          captureError(
            `Component ${descriptor.name} exceeds the file-count limit`,
            "AGENT_BACKUP_V2_FILE_LIMIT",
            { componentName: descriptor.name, fileCount },
            { severity: "fatal" },
          );
        }
        const before = await fs.promises.stat(file.absolutePath);
        const commonEntry = {
          path: file.relativePath,
          fileSizeBytes: before.size,
          mode: before.mode & 0o777,
          mtimeMs: Math.max(0, Math.trunc(before.mtimeMs)),
        };
        if (before.size === 0) {
          yield {
            bytes: new Uint8Array(0),
            entry: { ...commonEntry, fileOffsetBytes: 0 },
          };
        } else {
          let fileOffsetBytes = 0;
          const stream = fs.createReadStream(file.absolutePath, {
            highWaterMark: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
          });
          if (signal.aborted) stream.destroy(sourceAbortError(signal));
          const abort = () => stream.destroy(sourceAbortError(signal));
          signal.addEventListener("abort", abort, { once: true });
          try {
            for await (const chunk of stream) {
              const bytes = chunk as Buffer;
              if (bytes.length === 0) {
                captureError(
                  `File stream made no progress for ${file.relativePath}`,
                  "AGENT_BACKUP_V2_ZERO_PROGRESS",
                  { componentName: descriptor.name, path: file.relativePath },
                  { severity: "fatal" },
                );
              }
              yield {
                bytes,
                entry: { ...commonEntry, fileOffsetBytes },
              };
              fileOffsetBytes += bytes.length;
            }
          } finally {
            signal.removeEventListener("abort", abort);
          }
          if (fileOffsetBytes !== before.size) {
            captureError(
              `File size changed while capturing ${file.relativePath}`,
              "AGENT_BACKUP_V2_FILE_CHANGED",
              {
                componentName: descriptor.name,
                path: file.relativePath,
                expectedBytes: before.size,
                observedBytes: fileOffsetBytes,
              },
              { severity: "ephemeral" },
            );
          }
        }
        const after = await fs.promises.stat(file.absolutePath);
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          (after.mode & 0o777) !== (before.mode & 0o777)
        ) {
          captureError(
            `File changed while capturing ${file.relativePath}`,
            "AGENT_BACKUP_V2_FILE_CHANGED",
            { componentName: descriptor.name, path: file.relativePath },
            { severity: "ephemeral" },
          );
        }
      }
    },
  };
}

function jsonSource(
  descriptor: AgentBackupCaptureV2ComponentDescriptor,
  value: unknown,
): AgentBackupV2CaptureComponentSource {
  return {
    descriptor,
    open() {
      return splitOpaqueBytes(new TextEncoder().encode(JSON.stringify(value)));
    },
  };
}

function isPgliteDump(value: unknown): value is {
  size: number;
  stream: () => ReadableStream<Uint8Array>;
} {
  const size = (value as { size?: unknown } | null)?.size;
  return (
    value !== null &&
    typeof value === "object" &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    typeof (value as { stream?: unknown }).stream === "function"
  );
}

const activePgliteDumpByPhysicalDirectory = new Map<string, symbol>();

function pgliteManagedExportErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function acquirePgliteDumpSlot(
  physicalPgliteDir: string,
  agentId: string,
): () => void {
  if (activePgliteDumpByPhysicalDirectory.has(physicalPgliteDir)) {
    captureError(
      "A previous PGlite export is still active or settling",
      "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY",
      { agentId },
      { severity: "ephemeral" },
    );
  }
  const token = Symbol("pglite-dump");
  activePgliteDumpByPhysicalDirectory.set(physicalPgliteDir, token);
  return () => {
    if (activePgliteDumpByPhysicalDirectory.get(physicalPgliteDir) === token) {
      activePgliteDumpByPhysicalDirectory.delete(physicalPgliteDir);
    }
  };
}

function pgliteDumpSource(
  runtime: AgentBackupV2CaptureRuntime,
  physicalPgliteDir: string,
): AgentBackupV2CaptureComponentSource {
  const adapter = runtime.adapter as
    | {
        dumpPgliteDataDirAfterPreflight?: (
          preflight: () => Promise<PglitePhysicalPreflight>,
          compression?: "gzip",
        ) => Promise<{
          dump: unknown;
          preflight: PglitePhysicalPreflight;
          release: () => void;
        }>;
        getPgliteDataDir?: () => unknown;
      }
    | undefined;
  const managedDump = adapter?.dumpPgliteDataDirAfterPreflight;
  if (typeof managedDump !== "function") {
    captureError(
      "Capture v2 requires the fenced, lifecycle-managed PGlite dump exporter",
      "AGENT_BACKUP_V2_PGLITE_MANAGED_DUMP_UNAVAILABLE",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  if (typeof adapter?.getPgliteDataDir !== "function") {
    captureError(
      "The PGlite exporter cannot attest its physical data directory",
      "AGENT_BACKUP_V2_PGLITE_DIRECTORY_UNATTESTED",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  const managedDataDir = adapter.getPgliteDataDir();
  if (
    typeof managedDataDir !== "string" ||
    managedDataDir.length === 0 ||
    managedDataDir === ":memory:" ||
    managedDataDir.includes("://")
  ) {
    captureError(
      "The PGlite exporter did not attest a filesystem-backed data directory",
      "AGENT_BACKUP_V2_PGLITE_DIRECTORY_UNATTESTED",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  const managedPhysicalDir = resolveCaptureDirectoryIdentity(
    resolveUserPath(managedDataDir),
    "pglite",
  );
  if (managedPhysicalDir !== physicalPgliteDir) {
    captureError(
      "The PGlite exporter data directory does not match capture configuration",
      "AGENT_BACKUP_V2_PGLITE_DIRECTORY_MISMATCH",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  const runManagedDump = managedDump.bind(adapter);

  let prepared:
    | { dump: { size: number; stream: () => ReadableStream<Uint8Array> } }
    | undefined;
  let preparing: Promise<void> | undefined;
  let releasePreparedExport: (() => void) | undefined;
  let opened = false;
  let disposed = false;

  const prepare = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw sourceAbortError(signal);
    if (disposed) {
      captureError(
        "The PGlite capture source is already closed",
        "AGENT_BACKUP_V2_PGLITE_DUMP_ALREADY_CONSUMED",
        { agentId: runtime.agentId },
        { severity: "fatal" },
      );
    }
    if (prepared) return;
    if (!preparing) {
      preparing = (async () => {
        const releaseDumpSlot = acquirePgliteDumpSlot(
          physicalPgliteDir,
          runtime.agentId,
        );
        let retainDumpSlot = false;
        let releaseManagedLease: (() => void) | undefined;
        try {
          let boundedDump: {
            dump: unknown;
            preflight: PglitePhysicalPreflight;
            release: () => void;
          };
          let provenPreflight: PglitePhysicalPreflight | undefined;
          try {
            const dumpPromise = Promise.resolve().then(() =>
              runManagedDump(async () => {
                const proof = await preflightPglitePhysicalDirectory(
                  physicalPgliteDir,
                  signal,
                  runtime.agentId,
                );
                provenPreflight = proof;
                return proof;
              }, "gzip"),
            );
            // PGlite 0.4.x cannot cancel a materializing dump. Keep its rejection
            // observed and its directory slot held until this promise settles.
            void dumpPromise.catch(() => undefined);
            boundedDump = await dumpPromise;
          } catch (error) {
            if (error instanceof AgentBackupV2CaptureError) throw error;
            if (
              pgliteManagedExportErrorCode(error) ===
              "PGLITE_DATA_DIR_EXPORT_BUSY"
            ) {
              captureError(
                "A previous PGlite export is still active or settling",
                "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY",
                { agentId: runtime.agentId },
                { severity: "ephemeral" },
              );
            }
            throw new AgentBackupV2CaptureError(
              "PGlite could not create a managed data-dir export",
              "AGENT_BACKUP_V2_PGLITE_DUMP_FAILED",
              { agentId: runtime.agentId },
              { cause: error, severity: "ephemeral" },
            );
          }
          if (typeof boundedDump.release !== "function") {
            captureError(
              "The managed PGlite exporter did not provide a consumer-lifetime lease",
              "AGENT_BACKUP_V2_PGLITE_MANAGED_DUMP_UNAVAILABLE",
              { agentId: runtime.agentId },
              { severity: "fatal" },
            );
          }
          releaseManagedLease = boundedDump.release;
          if (signal.aborted) throw sourceAbortError(signal);
          if (disposed) {
            captureError(
              "The PGlite capture source closed while export was settling",
              "AGENT_BACKUP_V2_CAPTURE_CLOSED",
              { agentId: runtime.agentId },
              { severity: "ephemeral" },
            );
          }
          const { dump, preflight } = boundedDump;
          if (!isPgliteDump(dump)) {
            captureError(
              "PGlite dumpDataDir() did not return a streamable Blob/File",
              "AGENT_BACKUP_V2_PGLITE_DUMP_NOT_STREAMABLE",
              { agentId: runtime.agentId },
              { severity: "fatal" },
            );
          }
          if (
            !provenPreflight ||
            preflight !== provenPreflight ||
            !Number.isSafeInteger(preflight.estimatedArchiveBytes) ||
            preflight.estimatedArchiveBytes < 0
          ) {
            captureError(
              "The managed PGlite exporter skipped its required preflight",
              "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
              { agentId: runtime.agentId },
              { severity: "fatal" },
            );
          }
          if (dump.size > preflight.estimatedArchiveBytes) {
            captureError(
              "PGlite export exceeds its preflighted archive bound",
              "AGENT_BACKUP_V2_PGLITE_DUMP_EXCEEDS_PREFLIGHT",
              {
                agentId: runtime.agentId,
                dumpBytes: dump.size,
                estimatedArchiveBytes: preflight.estimatedArchiveBytes,
                physicalBytes: preflight.physicalBytes,
              },
              { severity: "fatal" },
            );
          }
          prepared = { dump };
          releasePreparedExport = () => {
            const releaseLease = releaseManagedLease;
            releaseManagedLease = undefined;
            releaseLease?.();
            releaseDumpSlot();
          };
          retainDumpSlot = true;
        } finally {
          if (!retainDumpSlot) {
            releaseManagedLease?.();
            releaseDumpSlot();
          }
        }
      })();
      void preparing.catch(() => undefined);
    }
    await preparing;
    if (signal.aborted) throw sourceAbortError(signal);
  };

  return {
    descriptor: {
      name: "database",
      format: "pglite-data-dir-tar-gzip-v1",
      compression: "gzip",
      contentKind: "opaque",
      consistency: "transactional",
    },
    prepare,
    dispose() {
      disposed = true;
      prepared = undefined;
      if (!opened) {
        releasePreparedExport?.();
        releasePreparedExport = undefined;
      }
    },
    async *open(signal) {
      await prepare(signal);
      if (opened) {
        captureError(
          "A prepared PGlite export can only be consumed once",
          "AGENT_BACKUP_V2_PGLITE_DUMP_ALREADY_CONSUMED",
          { agentId: runtime.agentId },
          { severity: "fatal" },
        );
      }
      opened = true;
      const dump = prepared?.dump;
      if (!dump) {
        captureError(
          "The prepared PGlite export is unavailable",
          "AGENT_BACKUP_V2_PGLITE_DUMP_FAILED",
          { agentId: runtime.agentId },
          { severity: "fatal" },
        );
      }
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let abort: (() => void) | undefined;
      try {
        reader = dump.stream().getReader();
        abort = () => {
          // error-policy:J6 cancellation is already observed through the capture
          // signal; a reader cleanup failure is diagnostic and must not be unhandled.
          void reader?.cancel(abortReason(signal)).catch((error) => {
            logger.warn(
              { err: error instanceof Error ? error.message : String(error) },
              "[agent-backup-v2] PGlite reader cancellation failed",
            );
          });
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (next.value.length === 0) {
            captureError(
              "PGlite export made no progress",
              "AGENT_BACKUP_V2_ZERO_PROGRESS",
              { componentName: "database" },
              { severity: "fatal" },
            );
          }
          yield* splitOpaqueBytes(next.value);
        }
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
        try {
          reader?.releaseLock();
        } finally {
          prepared = undefined;
          releasePreparedExport?.();
          releasePreparedExport = undefined;
        }
      }
    },
  };
}

function resolvePgliteDir(config: ElizaConfig): string {
  const configured = process.env.PGLITE_DATA_DIR?.trim();
  if (configured) return resolveUserPath(configured);
  const workspace =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  return path.join(resolveUserPath(workspace), DEFAULT_PGLITE_DIR_NAME);
}

function hasPostgresUrl(runtime: AgentBackupV2CaptureRuntime): boolean {
  const runtimeSetting = runtime.getSetting?.("POSTGRES_URL");
  return (
    (typeof runtimeSetting === "string" && runtimeSetting.trim().length > 0) ||
    Boolean(
      process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim(),
    )
  );
}

function baseStateFileInclude(
  relativePath: string,
  pgliteRelativePath: string | null,
): boolean {
  if (
    pgliteRelativePath !== null &&
    (relativePath === pgliteRelativePath ||
      relativePath.startsWith(`${pgliteRelativePath}/`))
  ) {
    return false;
  }
  const first = relativePath.split("/")[0];
  if (
    first === MEDIA_DIR_NAME ||
    first === BACKUPS_DIR_NAME ||
    first === MODELS_DIR_NAME ||
    first === TOOL_CACHE_DIR_NAME ||
    first === CACHE_DIR_NAME ||
    first === ACTIVATION_DIR_NAME ||
    first === DEFAULT_PGLITE_DIR_NAME ||
    first === VAULT_PGLITE_DIR_NAME ||
    relativePath === VAULT_JSON_PATH ||
    relativePath === VAULT_AUDIT_PATH
  ) {
    return false;
  }
  return !relativePath.endsWith(".log");
}

function vaultFileInclude(relativePath: string): boolean {
  return (
    relativePath === VAULT_JSON_PATH ||
    relativePath === VAULT_AUDIT_DIR_NAME ||
    relativePath === VAULT_AUDIT_PATH ||
    relativePath === VAULT_PGLITE_DIR_NAME ||
    relativePath.startsWith(`${VAULT_PGLITE_DIR_NAME}/`)
  );
}

/** Build the five required full-capture components without provider provenance. */
export function createDefaultAgentBackupV2CaptureSources(
  runtime: AgentBackupV2CaptureRuntime,
  config: ElizaConfig,
): readonly AgentBackupV2CaptureComponentSource[] {
  if (hasPostgresUrl(runtime)) {
    captureError(
      "Capture v2 currently requires the sandbox-local PGlite database export",
      "AGENT_BACKUP_V2_POSTGRES_UNSUPPORTED",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  const stateDir = resolveStateDir();
  const pgliteDir = resolvePgliteDir(config);
  if (pgliteDir === ":memory:" || pgliteDir.includes("://")) {
    captureError(
      "Capture v2 requires a filesystem-backed PGlite database",
      "AGENT_BACKUP_V2_PGLITE_NOT_FILESYSTEM",
      { pgliteDir },
      { severity: "fatal" },
    );
  }
  const pgliteStateFilesExclusion = resolveStateFilesPgliteExclusion(
    stateDir,
    pgliteDir,
  );
  const physicalPgliteDir = resolveCaptureDirectoryIdentity(
    pgliteDir,
    "pglite",
  );
  const database = pgliteDumpSource(runtime, physicalPgliteDir);

  return Object.freeze([
    jsonSource(
      {
        name: "character",
        format: "runtime-character-json-v1",
        compression: "none",
        contentKind: "opaque",
        consistency: "best-effort",
      },
      runtime.character ?? null,
    ),
    database,
    fileSetSource(
      {
        name: "media",
        format: "file-set-v1",
        compression: "none",
        contentKind: "file-set",
        consistency: "best-effort",
      },
      path.join(stateDir, MEDIA_DIR_NAME),
    ),
    fileSetSource(
      {
        name: "state-files",
        format: "file-set-v1",
        compression: "none",
        contentKind: "file-set",
        consistency: "best-effort",
      },
      stateDir,
      (relativePath) =>
        baseStateFileInclude(relativePath, pgliteStateFilesExclusion),
    ),
    fileSetSource(
      {
        name: "vault",
        format: "file-set-v1",
        compression: "none",
        contentKind: "file-set",
        consistency: "best-effort",
      },
      stateDir,
      vaultFileInclude,
    ),
  ]);
}

function assertComponentSources(
  components: readonly AgentBackupV2CaptureComponentSource[],
): void {
  if (
    components.length === 0 ||
    components.length > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxComponents
  ) {
    captureError(
      "Capture component count is outside its bound",
      "AGENT_BACKUP_V2_COMPONENT_COUNT",
      { componentCount: components.length },
      { severity: "fatal" },
    );
  }
  let previousName: string | undefined;
  for (const source of components) {
    AgentBackupCaptureV2ComponentDescriptorSchema.parse(source.descriptor);
    if (previousName && source.descriptor.name <= previousName) {
      captureError(
        "Capture components must be unique and lexicographically ordered",
        "AGENT_BACKUP_V2_COMPONENT_ORDER",
        { previousName, componentName: source.descriptor.name },
        { severity: "fatal" },
      );
    }
    previousName = source.descriptor.name;
  }
}

/** Stream an injected capture source; used by production and large real tests. */
export async function* streamAgentBackupV2Capture(
  options: Readonly<StreamAgentBackupV2CaptureOptions>,
): AsyncGenerator<Uint8Array> {
  const request = parseAgentBackupCaptureV2Request(options.request);
  const now = options.now ?? Date.now;
  if (request.agentId !== options.agentId) {
    captureError(
      "Capture request agent does not match the active runtime",
      "AGENT_BACKUP_V2_AGENT_MISMATCH",
      { requestedAgentId: request.agentId, activeAgentId: options.agentId },
      { severity: "fatal" },
    );
  }
  const deadlineAheadMs = request.deadlineEpochMs - now();
  if (
    deadlineAheadMs <= 0 ||
    deadlineAheadMs > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDeadlineAheadMs
  ) {
    captureError(
      "Capture request deadline is expired or too far in the future",
      "AGENT_BACKUP_V2_INVALID_DEADLINE",
      { deadlineEpochMs: request.deadlineEpochMs, deadlineAheadMs },
      { severity: "fatal" },
    );
  }
  assertComponentSources(options.components);

  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const deadlineTimer = setTimeout(
    () =>
      controller.abort(
        new AgentBackupV2CaptureError(
          "Agent backup capture deadline exceeded",
          "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
          { operationId: request.operationId },
          { severity: "ephemeral" },
        ),
      ),
    Math.min(deadlineAheadMs, 2_147_483_647),
  );
  const frameDigestChain = createHash("sha256");
  let sequence = 0;
  let totalDataFrames = 0;
  let totalPlainBytes = 0;
  const base = {
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  } as const;

  const serialize = async (
    header: AgentBackupCaptureV2FrameHeader,
    payload?: Uint8Array,
    includeInChain = true,
  ): Promise<Uint8Array> => {
    assertCaptureActive(request, signal, now);
    const wire = await serializeAgentBackupCaptureV2Frame(
      { header, payload },
      nodeSha256Digest,
    );
    if (includeInChain) {
      frameDigestChain.update(readAgentBackupCaptureV2FrameDigest(wire));
    }
    return wire;
  };

  try {
    for (const source of options.components) {
      if (!source.prepare) continue;
      try {
        await awaitWithCaptureControl(
          () => source.prepare?.(signal) ?? Promise.resolve(),
          request,
          signal,
          now,
        );
      } catch (error) {
        if (error instanceof AgentBackupV2CaptureError) throw error;
        throw new AgentBackupV2CaptureError(
          `Capture source preparation failed for component ${source.descriptor.name}`,
          "AGENT_BACKUP_V2_SOURCE_PREPARE_FAILED",
          {
            operationId: request.operationId,
            componentName: source.descriptor.name,
          },
          { cause: error, severity: "ephemeral" },
        );
      }
    }

    yield await serialize({
      ...base,
      kind: "capture-start",
      sequence: sequence++,
      operationId: request.operationId,
      agentId: request.agentId,
      activationGeneration: request.activationGeneration,
      lifecycleRevision: request.lifecycleRevision,
      createdAt: new Date(now()).toISOString(),
      componentCount: options.components.length,
      maxFramePayloadBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
    });

    for (const [componentIndex, source] of options.components.entries()) {
      yield await serialize({
        ...base,
        kind: "component-start",
        sequence: sequence++,
        componentIndex,
        component: source.descriptor,
      });
      const payloadHash = createHash("sha256");
      let componentDataFrames = 0;
      let componentPlainBytes = 0;
      const iterator = source.open(signal)[Symbol.asyncIterator]();
      let sourceCompleted = false;
      try {
        for (;;) {
          const next = await awaitWithCaptureControl(
            () => iterator.next(),
            request,
            signal,
            now,
          );
          if (next.done) {
            sourceCompleted = true;
            break;
          }
          const { bytes, entry } = next.value;
          if (!(bytes instanceof Uint8Array)) {
            captureError(
              `Component ${source.descriptor.name} yielded non-byte data`,
              "AGENT_BACKUP_V2_INVALID_SOURCE_CHUNK",
              { componentName: source.descriptor.name },
              { severity: "fatal" },
            );
          }
          if (
            bytes.length > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes
          ) {
            captureError(
              `Component ${source.descriptor.name} exceeded the frame payload bound`,
              "AGENT_BACKUP_V2_SOURCE_CHUNK_TOO_LARGE",
              { componentName: source.descriptor.name, bytes: bytes.length },
              { severity: "fatal" },
            );
          }
          if (
            bytes.length === 0 &&
            (entry?.fileSizeBytes !== 0 || entry.fileOffsetBytes !== 0)
          ) {
            captureError(
              `Component ${source.descriptor.name} made no progress`,
              "AGENT_BACKUP_V2_ZERO_PROGRESS",
              { componentName: source.descriptor.name },
              { severity: "fatal" },
            );
          }
          if (
            totalPlainBytes >
            AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes - bytes.length
          ) {
            captureError(
              "Capture exceeds the plaintext byte limit",
              "AGENT_BACKUP_V2_PLAIN_BYTES_LIMIT",
              { observedBytes: totalPlainBytes + bytes.length },
              { severity: "fatal" },
            );
          }
          if (totalDataFrames >= AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames) {
            captureError(
              "Capture exceeds the data-frame limit",
              "AGENT_BACKUP_V2_DATA_FRAME_LIMIT",
              { observedFrames: totalDataFrames + 1 },
              { severity: "fatal" },
            );
          }
          payloadHash.update(bytes);
          yield await serialize(
            {
              ...base,
              kind: "data",
              sequence: sequence++,
              componentIndex,
              componentName: source.descriptor.name,
              dataIndex: componentDataFrames,
              offsetBytes: componentPlainBytes,
              payloadBytes: bytes.length,
              ...(entry ? { entry } : {}),
            },
            bytes,
          );
          componentDataFrames += 1;
          componentPlainBytes += bytes.length;
          totalDataFrames += 1;
          totalPlainBytes += bytes.length;
        }
      } catch (error) {
        // error-policy:J2 source failures gain stable operation/component
        // context; typed capture failures already carry that context.
        if (error instanceof AgentBackupV2CaptureError) throw error;
        throw new AgentBackupV2CaptureError(
          `Capture source failed for component ${source.descriptor.name}`,
          "AGENT_BACKUP_V2_SOURCE_FAILED",
          {
            operationId: request.operationId,
            componentName: source.descriptor.name,
          },
          { cause: error, severity: "ephemeral" },
        );
      } finally {
        if (!sourceCompleted && !controller.signal.aborted) {
          controller.abort(
            new AgentBackupV2CaptureError(
              "Agent backup capture source closed before completion",
              "AGENT_BACKUP_V2_CAPTURE_CLOSED",
              {
                operationId: request.operationId,
                componentName: source.descriptor.name,
              },
              { severity: "ephemeral" },
            ),
          );
        }
        const closing = iterator.return?.();
        if (closing) {
          if (signal.aborted) {
            // error-policy:J6 an interrupted source may never settle `return`;
            // observe cleanup rejection without pinning the HTTP deadline.
            void Promise.resolve(closing).catch((error) => {
              logger.warn(
                {
                  err: error instanceof Error ? error.message : String(error),
                  componentName: source.descriptor.name,
                },
                "[agent-backup-v2] Interrupted source cleanup failed",
              );
            });
          } else {
            await closing;
          }
        }
      }
      yield await serialize({
        ...base,
        kind: "component-end",
        sequence: sequence++,
        componentIndex,
        componentName: source.descriptor.name,
        dataFrameCount: componentDataFrames,
        plainBytes: componentPlainBytes,
        payloadSha256: payloadHash.digest("hex"),
      });
    }

    assertCaptureActive(request, signal, now);
    const frameDigestChainSha256 = frameDigestChain.digest("hex");
    yield await serialize(
      {
        ...base,
        kind: "capture-end",
        sequence: sequence++,
        componentCount: options.components.length,
        dataFrameCount: totalDataFrames,
        plainBytes: totalPlainBytes,
        frameDigestChainSha256,
      },
      undefined,
      false,
    );
  } finally {
    clearTimeout(deadlineTimer);
    for (const source of options.components) {
      try {
        source.dispose?.();
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            componentName: source.descriptor.name,
          },
          "[agent-backup-v2] Capture source disposal failed",
        );
      }
    }
    if (!controller.signal.aborted) {
      controller.abort(
        new AgentBackupV2CaptureError(
          "Agent backup capture iterator closed",
          "AGENT_BACKUP_V2_CAPTURE_CLOSED",
          { operationId: request.operationId },
          { severity: "ephemeral" },
        ),
      );
    }
  }
}

/** Create the production capture stream for one authenticated runtime. */
export function createAgentBackupV2Capture(
  runtime: AgentBackupV2CaptureRuntime,
  config: ElizaConfig,
  request: AgentBackupCaptureV2Request,
  options: Readonly<CreateAgentBackupV2CaptureOptions> = {},
): AsyncIterable<Uint8Array> {
  const components =
    options.components ??
    createDefaultAgentBackupV2CaptureSources(runtime, config);
  assertComponentSources(components);
  return streamAgentBackupV2Capture({
    request,
    agentId: runtime.agentId,
    components,
    signal: options.signal,
    now: options.now,
  });
}

/** Utility for callers/tests that need the payload digest of one bounded chunk. */
export function sha256AgentBackupV2CaptureChunk(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}
