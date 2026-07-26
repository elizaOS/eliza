/**
 * Bounded producer and staged consumer for schema-v2 pre-upgrade snapshots.
 * Capture hashes regular files before emitting a canonical descriptor, then
 * re-reads them in fixed chunks and commits only with a terminal aggregate.
 * Restore writes those chunks into an isolated staging directory and does not
 * touch active state until the complete descriptor, files, and trailer verify.
 */
import crypto from "node:crypto";
import { constants as fsConstants, openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import { resolveConfigPath, resolveStateDir } from "../config/paths.ts";
import {
  createExternalPostgresReference,
  verifyExternalPostgresReference,
} from "./agent-backup.ts";
import {
  AGENT_SNAPSHOT_STREAM_CHUNK_BYTES,
  AGENT_SNAPSHOT_STREAM_FORMAT,
  AGENT_SNAPSHOT_STREAM_MAX_DESCRIPTOR_PATH_BYTES,
  AGENT_SNAPSHOT_STREAM_MAX_FILES,
  AGENT_SNAPSHOT_STREAM_MAX_LINE_BYTES,
  AGENT_SNAPSHOT_STREAM_MAX_PATH_BYTES,
  AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES,
  AGENT_SNAPSHOT_STREAM_TRANSFER,
  type AgentSnapshotStreamChunkFrame,
  type AgentSnapshotStreamDatabaseDescriptor,
  type AgentSnapshotStreamDescriptor,
  type AgentSnapshotStreamFileComponent,
  type AgentSnapshotStreamFileDescriptor,
  type AgentSnapshotStreamFileSetDescriptor,
  type AgentSnapshotStreamTrailer,
  characterConfigSha256,
  encodeSnapshotStreamFrame,
  fileSetSha256,
  parseCanonicalSnapshotStreamFrame,
  pgliteDumpSha256,
  sha256Bytes,
  stableJson,
  validateSnapshotStreamChunkFrame,
  validateSnapshotStreamDescriptor,
  validateSnapshotStreamTrailer,
} from "./agent-snapshot-stream-protocol.ts";

interface PlannedSnapshotFile {
  absolutePath: string;
  descriptor: AgentSnapshotStreamFileDescriptor;
}

interface SnapshotStreamPlan {
  descriptor: AgentSnapshotStreamDescriptor;
  files: PlannedSnapshotFile[];
  temporaryRoot: string | null;
}

export interface AgentSnapshotStreamRestoreResult {
  aggregateSha256: string;
  fileCount: number;
  schemaVersion: 2;
  success: true;
  totalBytes: number;
  transfer: typeof AGENT_SNAPSHOT_STREAM_TRANSFER;
}

const MEDIA_DIR_NAME = "media";
const BACKUPS_DIR_NAME = "backups";
const DEFAULT_PGLITE_DIR_NAME = ".elizadb";
const VAULT_PGLITE_DIR_NAME = ".vault-pglite";
const VAULT_AUDIT_PATH = "audit/vault.jsonl";
const VAULT_JSON_PATH = "vault.json";
const PGLITE_DUMP_PATH = "pglite-data-dir.tar.gz";
const PGLITE_VOLATILE_ROOT_FILES = new Set([
  "eliza-pglite.lock",
  "postmaster.opts",
  "postmaster.pid",
]);
const FILE_COMPONENT_ORDER: readonly AgentSnapshotStreamFileComponent[] = [
  "database",
  "media",
  "vault",
  "character-config",
  "state",
];
const RESTORE_STAGING_PREFIX = "eliza-agent-snapshot-restore-";

interface SnapshotPlanBudget {
  fileCount: number;
  pathBytes: number;
}

function invalidStream(message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_SNAPSHOT_STREAM_INVALID",
    cause,
    severity: "fatal",
  });
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
    throw invalidStream(`Snapshot file path escapes its root: ${input}`);
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    // error-policy:J3 ENOENT is the explicit absent result for this filesystem probe.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function hasPostgresUrl(runtime: IAgentRuntime | AgentRuntime): string | null {
  const runtimeSetting = runtime.getSetting?.("POSTGRES_URL");
  if (typeof runtimeSetting === "string" && runtimeSetting.trim()) {
    return runtimeSetting.trim();
  }
  return (
    process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim() || null
  );
}

async function resolvePgliteDir(): Promise<string> {
  const configured = process.env.PGLITE_DATA_DIR?.trim();
  if (configured) {
    if (configured === ":memory:" || configured.includes("://")) {
      return configured;
    }
    return configured.startsWith("~")
      ? path.join(process.cwd(), configured.slice(1))
      : path.resolve(configured);
  }

  let current = process.cwd();
  while (true) {
    if (await pathExists(path.join(current, "packages", "core"))) {
      return path.join(current, ".eliza", ".elizadb");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(process.cwd(), ".eliza", ".elizadb");
}

function pgliteFileInclude(relativePath: string): boolean {
  const first = relativePath.split("/")[0];
  if (PGLITE_VOLATILE_ROOT_FILES.has(relativePath)) return false;
  if (first.startsWith(".s.PGSQL.")) return false;
  if (relativePath === "pg_stat_tmp" || relativePath.startsWith("pg_stat_tmp/"))
    return false;
  return true;
}

function vaultFileInclude(relativePath: string): boolean {
  return (
    relativePath === VAULT_JSON_PATH ||
    relativePath === "audit" ||
    relativePath === VAULT_AUDIT_PATH ||
    relativePath === VAULT_PGLITE_DIR_NAME ||
    relativePath.startsWith(`${VAULT_PGLITE_DIR_NAME}/`)
  );
}

function vaultSnapshotFileInclude(relativePath: string): boolean {
  return (
    relativePath === VAULT_JSON_PATH ||
    relativePath === VAULT_AUDIT_PATH ||
    relativePath.startsWith(`${VAULT_PGLITE_DIR_NAME}/`)
  );
}

function relativeRootWithin(
  root: string,
  target: string | null,
): string | null {
  if (!target) return null;
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return null;
  return normalizeRelativePath(relative);
}

function makeStateFileInclude(params: {
  configPath: string;
  pgliteDir: string | null;
  stateDir: string;
}): (relativePath: string) => boolean {
  const stateRoot = path.resolve(params.stateDir);
  const pgliteRoot = relativeRootWithin(
    stateRoot,
    params.pgliteDir ? path.resolve(params.pgliteDir) : null,
  );
  const configFile = relativeRootWithin(
    stateRoot,
    path.resolve(params.configPath),
  );
  return (relativePath: string): boolean => {
    const first = relativePath.split("/")[0];
    if (
      first === MEDIA_DIR_NAME ||
      first === BACKUPS_DIR_NAME ||
      first === DEFAULT_PGLITE_DIR_NAME ||
      first === VAULT_PGLITE_DIR_NAME ||
      relativePath === VAULT_JSON_PATH ||
      relativePath === "audit" ||
      relativePath === VAULT_AUDIT_PATH ||
      relativePath.endsWith(".log")
    ) {
      return false;
    }
    if (
      configFile &&
      (relativePath === configFile || configFile.startsWith(`${relativePath}/`))
    ) {
      return false;
    }
    if (
      pgliteRoot &&
      (relativePath === pgliteRoot ||
        relativePath.startsWith(`${pgliteRoot}/`) ||
        pgliteRoot.startsWith(`${relativePath}/`))
    ) {
      return false;
    }
    return true;
  };
}

async function openRegularFileNoFollow(absolutePath: string) {
  const before = await fs.lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw invalidStream(
      `Snapshot source is not a regular file: ${absolutePath}`,
    );
  }
  const handle = await fs.open(
    absolutePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  const opened = await handle.stat();
  if (
    !opened.isFile() ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino
  ) {
    await handle.close();
    throw invalidStream(
      `Snapshot source changed while opening: ${absolutePath}`,
    );
  }
  return { before, handle };
}

async function hashRegularFile(absolutePath: string): Promise<{
  mode: number;
  mtimeMs: number;
  sha256: string;
  size: number;
}> {
  const { before, handle } = await openRegularFileNoFollow(absolutePath);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(AGENT_SNAPSHOT_STREAM_CHUNK_BYTES);
  let offset = 0;
  try {
    while (offset < before.size) {
      const length = Math.min(buffer.length, before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw invalidStream(
          `Snapshot source was truncated while hashing: ${absolutePath}`,
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw invalidStream(
        `Snapshot source changed while hashing: ${absolutePath}`,
      );
    }
    return {
      mode: before.mode & 0o777,
      mtimeMs: before.mtimeMs,
      sha256: hash.digest("hex"),
      size: before.size,
    };
  } finally {
    await handle.close();
  }
}

async function collectPlannedFiles(params: {
  budget: SnapshotPlanBudget;
  component: AgentSnapshotStreamFileComponent;
  include?: (relativePath: string) => boolean;
  root: string;
}): Promise<PlannedSnapshotFile[]> {
  const root = path.resolve(params.root);
  if (!(await pathExists(root))) return [];
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw invalidStream(`Snapshot source root is not a directory: ${root}`);
  }
  const result: PlannedSnapshotFile[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (!isWithin(root, absolutePath)) {
        throw invalidStream(
          `Snapshot source escapes its root: ${absolutePath}`,
        );
      }
      const relativePath = normalizeRelativePath(
        path.relative(root, absolutePath),
      );
      if (params.include && !params.include(relativePath)) continue;
      const pathBytes = Buffer.byteLength(relativePath);
      if (
        pathBytes > AGENT_SNAPSHOT_STREAM_MAX_PATH_BYTES ||
        params.budget.fileCount >= AGENT_SNAPSHOT_STREAM_MAX_FILES ||
        params.budget.pathBytes + pathBytes >
          AGENT_SNAPSHOT_STREAM_MAX_DESCRIPTOR_PATH_BYTES
      ) {
        throw invalidStream("Snapshot descriptor exceeds its metadata budget");
      }
      if (entry.isSymbolicLink()) {
        throw invalidStream(
          `Snapshot source contains a symbolic link: ${relativePath}`,
        );
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw invalidStream(
          `Snapshot source contains a non-regular file: ${relativePath}`,
        );
      }
      const metadata = await hashRegularFile(absolutePath);
      params.budget.fileCount += 1;
      params.budget.pathBytes += pathBytes;
      result.push({
        absolutePath,
        descriptor: {
          component: params.component,
          index: -1,
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
          path: relativePath,
          sha256: metadata.sha256,
          size: metadata.size,
        },
      });
    }
  }

  await visit(root);
  return result;
}

async function planSingleFile(params: {
  absolutePath: string;
  budget: SnapshotPlanBudget;
  component: AgentSnapshotStreamFileComponent;
  relativePath: string;
}): Promise<PlannedSnapshotFile> {
  const relativePath = normalizeRelativePath(params.relativePath);
  const pathBytes = Buffer.byteLength(relativePath);
  if (
    pathBytes > AGENT_SNAPSHOT_STREAM_MAX_PATH_BYTES ||
    params.budget.fileCount >= AGENT_SNAPSHOT_STREAM_MAX_FILES ||
    params.budget.pathBytes + pathBytes >
      AGENT_SNAPSHOT_STREAM_MAX_DESCRIPTOR_PATH_BYTES
  ) {
    throw invalidStream("Snapshot descriptor exceeds its metadata budget");
  }
  const metadata = await hashRegularFile(params.absolutePath);
  params.budget.fileCount += 1;
  params.budget.pathBytes += pathBytes;
  return {
    absolutePath: params.absolutePath,
    descriptor: {
      component: params.component,
      index: -1,
      mode: metadata.mode,
      mtimeMs: metadata.mtimeMs,
      path: relativePath,
      sha256: metadata.sha256,
      size: metadata.size,
    },
  };
}

function isStreamableBlob(value: unknown): value is Blob {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Blob).size === "number" &&
    typeof (value as Blob).stream === "function"
  );
}

async function capturePgliteDumpToTemporaryFile(
  runtime: IAgentRuntime | AgentRuntime,
  temporaryRoot: string,
  budget: SnapshotPlanBudget,
): Promise<PlannedSnapshotFile | null> {
  const raw = (
    runtime.adapter as
      | {
          getRawConnection?: () => unknown;
        }
      | undefined
  )?.getRawConnection?.();
  if (!raw || typeof raw !== "object") return null;
  const connection = raw as {
    dumpDataDir?: (compression?: "gzip") => Promise<unknown>;
    runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  };
  if (typeof connection.dumpDataDir !== "function") return null;
  const dumpDataDir = connection.dumpDataDir.bind(connection);
  const capture = () => dumpDataDir("gzip");
  const dump = connection.runExclusive
    ? await connection.runExclusive(capture)
    : await capture();
  if (!isStreamableBlob(dump)) {
    throw invalidStream("PGlite dumpDataDir() did not return a Blob/File");
  }
  if (dump.size > AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES) {
    throw invalidStream("PGlite dump exceeds the snapshot byte budget");
  }
  const destination = path.join(temporaryRoot, PGLITE_DUMP_PATH);
  const handle = await fs.open(destination, "wx", 0o600);
  const reader = dump.stream().getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw invalidStream("PGlite dump emitted a non-byte chunk");
      }
      offset += value.byteLength;
      if (offset > AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES) {
        throw invalidStream("PGlite dump exceeds the snapshot byte budget");
      }
      let written = 0;
      while (written < value.byteLength) {
        const result = await handle.write(
          value,
          written,
          value.byteLength - written,
          null,
        );
        if (result.bytesWritten === 0) {
          throw invalidStream("PGlite dump staging made no write progress");
        }
        written += result.bytesWritten;
      }
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }
  if (offset !== dump.size) {
    throw invalidStream("PGlite dump size changed during capture");
  }
  return planSingleFile({
    absolutePath: destination,
    budget,
    component: "database",
    relativePath: PGLITE_DUMP_PATH,
  });
}

function indexFiles(files: PlannedSnapshotFile[]): PlannedSnapshotFile[] {
  files.sort((left, right) => {
    const componentDelta =
      FILE_COMPONENT_ORDER.indexOf(left.descriptor.component) -
      FILE_COMPONENT_ORDER.indexOf(right.descriptor.component);
    return (
      componentDelta ||
      left.descriptor.path.localeCompare(right.descriptor.path)
    );
  });
  let totalBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) throw invalidStream("Snapshot file index is sparse");
    file.descriptor.index = index;
    totalBytes += file.descriptor.size;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES
    ) {
      throw invalidStream("Snapshot source exceeds the aggregate byte budget");
    }
    if (
      index > 0 &&
      files[index - 1]?.descriptor.component === file.descriptor.component &&
      files[index - 1]?.descriptor.path === file.descriptor.path
    ) {
      throw invalidStream("Snapshot source contains a duplicate file path");
    }
  }
  return files;
}

function fileSetDescriptor(
  files: readonly PlannedSnapshotFile[],
  component: AgentSnapshotStreamFileComponent,
): AgentSnapshotStreamFileSetDescriptor {
  const descriptors = files
    .filter((file) => file.descriptor.component === component)
    .map((file) => file.descriptor);
  return {
    fileIndices: descriptors.map((file) => file.index),
    kind: "file-set",
    sha256: fileSetSha256(descriptors),
  };
}

async function createSnapshotStreamPlan(
  runtime: IAgentRuntime | AgentRuntime,
): Promise<SnapshotStreamPlan> {
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const postgresUrl = hasPostgresUrl(runtime);
  const pgliteDir = postgresUrl ? null : await resolvePgliteDir();
  if (pgliteDir && (pgliteDir === ":memory:" || pgliteDir.includes("://"))) {
    throw new ElizaError(
      `Pre-upgrade snapshot cannot capture PGlite data dir ${pgliteDir}`,
      {
        code: "AGENT_SNAPSHOT_DATABASE_UNCAPTURABLE",
        severity: "fatal",
      },
    );
  }
  let temporaryRoot: string | null = null;
  let databaseKind: "external" | "dump" | "files";
  const files: PlannedSnapshotFile[] = [];
  const budget: SnapshotPlanBudget = { fileCount: 0, pathBytes: 0 };
  let databaseFile: PlannedSnapshotFile | null = null;

  try {
    if (postgresUrl) {
      databaseKind = "external";
    } else {
      temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "eliza-agent-snapshot-capture-"),
      );
      databaseFile = await capturePgliteDumpToTemporaryFile(
        runtime,
        temporaryRoot,
        budget,
      );
      if (databaseFile) {
        databaseKind = "dump";
        files.push(databaseFile);
      } else {
        databaseKind = "files";
        files.push(
          ...(await collectPlannedFiles({
            budget,
            component: "database",
            include: pgliteFileInclude,
            root: pgliteDir as string,
          })),
        );
      }
    }

    files.push(
      ...(await collectPlannedFiles({
        budget,
        component: "media",
        root: path.join(stateDir, MEDIA_DIR_NAME),
      })),
      ...(await collectPlannedFiles({
        budget,
        component: "vault",
        include: vaultFileInclude,
        root: stateDir,
      })),
    );
    if (await pathExists(configPath)) {
      files.push(
        await planSingleFile({
          absolutePath: configPath,
          budget,
          component: "character-config",
          relativePath: path.basename(configPath),
        }),
      );
    }
    files.push(
      ...(await collectPlannedFiles({
        budget,
        component: "state",
        include: makeStateFileInclude({
          configPath,
          pgliteDir,
          stateDir,
        }),
        root: stateDir,
      })),
    );
    indexFiles(files);
    if (
      databaseKind === "files" &&
      !files.some((file) => file.descriptor.component === "database")
    ) {
      throw new ElizaError(
        "Pre-upgrade snapshot cannot capture an empty PGlite data directory",
        {
          code: "AGENT_SNAPSHOT_DATABASE_UNCAPTURABLE",
          severity: "fatal",
        },
      );
    }

    let database: AgentSnapshotStreamDatabaseDescriptor;
    if (databaseKind === "external") {
      const externalPostgres = createExternalPostgresReference(
        postgresUrl as string,
        runtime.agentId,
      );
      database = {
        externalPostgres,
        kind: "external-postgres-reference",
        sha256: externalPostgres.sha256,
      };
    } else if (databaseKind === "dump") {
      const descriptor = databaseFile?.descriptor;
      if (!descriptor) throw invalidStream("PGlite dump file is missing");
      database = {
        compression: "gzip",
        fileIndex: descriptor.index,
        kind: "pglite-dump",
        sha256: pgliteDumpSha256(descriptor),
      };
    } else {
      const databaseFiles = files
        .filter((file) => file.descriptor.component === "database")
        .map((file) => file.descriptor);
      database = {
        fileIndices: databaseFiles.map((file) => file.index),
        kind: "pglite-files",
        sha256: fileSetSha256(databaseFiles),
      };
    }
    const characterFile =
      files.find((file) => file.descriptor.component === "character-config")
        ?.descriptor ?? null;
    const descriptor: AgentSnapshotStreamDescriptor = {
      agentId: runtime.agentId,
      chunkSize: AGENT_SNAPSHOT_STREAM_CHUNK_BYTES,
      components: {
        character: {
          configFileIndex: characterFile?.index ?? null,
          kind: "character-config",
          sha256: characterConfigSha256(characterFile),
        },
        database,
        media: fileSetDescriptor(files, "media"),
        stateFiles: fileSetDescriptor(files, "state"),
        vault: fileSetDescriptor(files, "vault"),
      },
      createdAt: new Date().toISOString(),
      files: files.map((file) => file.descriptor),
      format: AGENT_SNAPSHOT_STREAM_FORMAT,
      schemaVersion: 2,
      transfer: AGENT_SNAPSHOT_STREAM_TRANSFER,
      type: "descriptor",
    };
    validateSnapshotStreamDescriptor(descriptor);
    return { descriptor, files, temporaryRoot };
  } catch (error) {
    // error-policy:J6 Failed capture plans remove their private staging directory.
    if (temporaryRoot) {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    }
    throw error;
  }
}

export async function* createAgentSnapshotStream(
  runtime: IAgentRuntime | AgentRuntime,
): AsyncGenerator<Buffer> {
  const plan = await createSnapshotStreamPlan(runtime);
  const aggregateHash = crypto.createHash("sha256");
  let chunkCount = 0;
  let totalBytes = 0;
  try {
    yield encodeSnapshotStreamFrame(plan.descriptor);
    for (const planned of plan.files) {
      const { before, handle } = await openRegularFileNoFollow(
        planned.absolutePath,
      );
      if (
        before.size !== planned.descriptor.size ||
        (before.mode & 0o777) !== planned.descriptor.mode ||
        before.mtimeMs !== planned.descriptor.mtimeMs
      ) {
        await handle.close();
        throw invalidStream(
          `Snapshot source changed before streaming: ${planned.descriptor.path}`,
        );
      }
      const fileHash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(AGENT_SNAPSHOT_STREAM_CHUNK_BYTES);
      let offset = 0;
      let chunkIndex = 0;
      try {
        while (offset < before.size) {
          const length = Math.min(buffer.length, before.size - offset);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead !== length) {
            throw invalidStream(
              `Snapshot source was truncated while streaming: ${planned.descriptor.path}`,
            );
          }
          const bytes = Buffer.from(buffer.subarray(0, bytesRead));
          fileHash.update(bytes);
          aggregateHash.update(bytes);
          const frame: AgentSnapshotStreamChunkFrame = {
            bytesBase64: bytes.toString("base64"),
            chunkIndex,
            fileIndex: planned.descriptor.index,
            offset,
            sha256: sha256Bytes(bytes),
            size: bytes.length,
            type: "chunk",
          };
          yield encodeSnapshotStreamFrame(frame);
          offset += bytesRead;
          totalBytes += bytesRead;
          chunkIndex += 1;
          chunkCount += 1;
        }
        const after = await handle.stat();
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          fileHash.digest("hex") !== planned.descriptor.sha256
        ) {
          throw invalidStream(
            `Snapshot source changed while streaming: ${planned.descriptor.path}`,
          );
        }
      } finally {
        await handle.close();
      }
    }
    const trailer: AgentSnapshotStreamTrailer = {
      aggregateSha256: aggregateHash.digest("hex"),
      chunkCount,
      descriptorSha256: sha256Bytes(stableJson(plan.descriptor)),
      fileCount: plan.files.length,
      totalBytes,
      type: "trailer",
    };
    yield encodeSnapshotStreamFrame(trailer);
  } finally {
    if (plan.temporaryRoot) {
      await fs.rm(plan.temporaryRoot, { force: true, recursive: true });
    }
  }
}

async function writeFileAtomically(
  source: string,
  destination: string,
  descriptor: AgentSnapshotStreamFileDescriptor,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.snapshot-${crypto.randomUUID()}`;
  try {
    await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    await fs.chmod(temporary, descriptor.mode);
    const mtime = new Date(descriptor.mtimeMs);
    await fs.utimes(temporary, mtime, mtime);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function assertSafeDestination(
  root: string,
  relativePath: string,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  if (await pathExists(resolvedRoot)) {
    const rootStat = await fs.lstat(resolvedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw invalidStream(`Snapshot restore root is not a directory: ${root}`);
    }
  }
  const segments = relativePath.split("/");
  let current = resolvedRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (!(await pathExists(current))) break;
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw invalidStream(
        `Snapshot destination traverses a non-directory: ${relativePath}`,
      );
    }
  }
  const destination = path.resolve(resolvedRoot, relativePath);
  if (await pathExists(destination)) {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw invalidStream(
        `Snapshot destination is not a regular file: ${relativePath}`,
      );
    }
  }
}

async function assertSafeIncludedTree(
  root: string,
  include: (relativePath: string) => boolean,
): Promise<void> {
  if (!(await pathExists(root))) return;
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw invalidStream(`Snapshot restore root is not a directory: ${root}`);
  }
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(
        path.relative(root, absolutePath),
      );
      if (!include(relativePath)) continue;
      if (entry.isSymbolicLink()) {
        throw invalidStream(
          `Snapshot restore root contains a symbolic link: ${relativePath}`,
        );
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (!entry.isFile()) {
        throw invalidStream(
          `Snapshot restore root contains a non-regular file: ${relativePath}`,
        );
      }
    }
  }
  await visit(root);
}

async function preflightSnapshotDestinations(params: {
  configPath: string;
  descriptor: AgentSnapshotStreamDescriptor;
  pgliteDir: string | null;
  stateDir: string;
}): Promise<void> {
  const { configPath, descriptor, pgliteDir, stateDir } = params;
  const stateInclude = makeStateFileInclude({
    configPath,
    pgliteDir,
    stateDir,
  });
  for (const file of descriptor.files) {
    if (file.component === "database") {
      if (
        descriptor.components.database.kind === "pglite-dump"
          ? file.path !== PGLITE_DUMP_PATH
          : !pgliteFileInclude(file.path)
      ) {
        throw invalidStream(
          `Snapshot database path is unsupported: ${file.path}`,
        );
      }
    } else if (
      file.component === "vault" &&
      !vaultSnapshotFileInclude(file.path)
    ) {
      throw invalidStream(`Snapshot vault path is unsupported: ${file.path}`);
    } else if (file.component === "state" && !stateInclude(file.path)) {
      throw invalidStream(`Snapshot state path is unsupported: ${file.path}`);
    } else if (
      file.component === "character-config" &&
      file.path !== path.basename(configPath)
    ) {
      throw invalidStream(
        `Snapshot character config path is unsupported: ${file.path}`,
      );
    }
  }
  await assertSafeIncludedTree(stateDir, vaultFileInclude);
  await assertSafeIncludedTree(stateDir, stateInclude);
  for (const file of descriptor.files) {
    if (file.component === "vault" || file.component === "state") {
      await assertSafeDestination(stateDir, file.path);
    }
  }
  await assertSafeDestination(
    path.dirname(configPath),
    path.basename(configPath),
  );
}

async function pruneExtraFiles(
  root: string,
  include: (relativePath: string) => boolean,
  keepPaths: ReadonlySet<string>,
): Promise<void> {
  if (!(await pathExists(root))) return;
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(
        path.relative(root, absolutePath),
      );
      if (!include(relativePath)) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        await fs.rmdir(absolutePath).catch((error: NodeJS.ErrnoException) => {
          // error-policy:J3 Concurrent absence/non-empty state is an explicit no-prune result.
          if (error.code === "ENOENT" || error.code === "ENOTEMPTY") return;
          throw error;
        });
      } else if (entry.isFile() && !keepPaths.has(relativePath)) {
        await fs.rm(absolutePath, { force: true });
      }
    }
  }
  await visit(root);
}

async function replaceDirectory(
  target: string,
  populate: (candidate: string) => Promise<void>,
): Promise<void> {
  const parent = path.dirname(target);
  const candidate = await fs.mkdtemp(
    path.join(parent, `.${path.basename(target)}.snapshot-candidate-`),
  );
  const previous = path.join(
    parent,
    `.${path.basename(target)}.snapshot-previous-${crypto.randomUUID()}`,
  );
  let movedPrevious = false;
  try {
    await populate(candidate);
    if (await pathExists(target)) {
      await fs.rename(target, previous);
      movedPrevious = true;
    }
    try {
      await fs.rename(candidate, target);
    } catch (error) {
      // error-policy:J6 A failed directory swap restores the pre-apply directory.
      if (movedPrevious) await fs.rename(previous, target);
      throw error;
    }
    if (movedPrevious) {
      await fs.rm(previous, { force: true, recursive: true });
    }
  } finally {
    await fs.rm(candidate, { force: true, recursive: true });
  }
}

async function applyDirectoryFileSet(params: {
  descriptors: readonly AgentSnapshotStreamFileDescriptor[];
  root: string;
  stagedFiles: string[];
}): Promise<void> {
  await fs.mkdir(path.dirname(params.root), { recursive: true });
  await replaceDirectory(params.root, async (candidate) => {
    for (const descriptor of params.descriptors) {
      const destination = path.resolve(candidate, descriptor.path);
      if (!isWithin(candidate, destination)) {
        throw invalidStream(
          `Snapshot file escapes restore root: ${descriptor.path}`,
        );
      }
      const source = params.stagedFiles[descriptor.index];
      if (!source) throw invalidStream("Snapshot staged file is missing");
      await assertSafeDestination(candidate, descriptor.path);
      await writeFileAtomically(source, destination, descriptor);
    }
  });
}

async function applySharedRootFileSet(params: {
  descriptors: readonly AgentSnapshotStreamFileDescriptor[];
  include: (relativePath: string) => boolean;
  root: string;
  stagedFiles: string[];
}): Promise<void> {
  const keepPaths = new Set(params.descriptors.map((file) => file.path));
  for (const descriptor of params.descriptors) {
    const destination = path.resolve(params.root, descriptor.path);
    if (!isWithin(params.root, destination)) {
      throw invalidStream(
        `Snapshot file escapes restore root: ${descriptor.path}`,
      );
    }
    const source = params.stagedFiles[descriptor.index];
    if (!source) throw invalidStream("Snapshot staged file is missing");
    await assertSafeDestination(params.root, descriptor.path);
    await writeFileAtomically(source, destination, descriptor);
  }
  await pruneExtraFiles(params.root, params.include, keepPaths);
}

async function restorePgliteDumpFromFile(
  pgliteDir: string,
  stagedFile: string,
): Promise<void> {
  await fs.mkdir(path.dirname(pgliteDir), { recursive: true });
  await replaceDirectory(pgliteDir, async (candidate) => {
    const dump = await openAsBlob(stagedFile, {
      type: "application/gzip",
    });
    const { PGlite } = await import("@electric-sql/pglite");
    const database = new PGlite({
      dataDir: candidate,
      loadDataDir: dump,
    });
    try {
      await database.waitReady;
    } finally {
      await database.close();
    }
    await Promise.all(
      [...PGLITE_VOLATILE_ROOT_FILES].map((fileName) =>
        fs.rm(path.join(candidate, fileName), { force: true }),
      ),
    );
    await fs.rm(path.join(candidate, "pg_stat_tmp"), {
      force: true,
      recursive: true,
    });
  });
}

async function applyVerifiedSnapshotStream(params: {
  descriptor: AgentSnapshotStreamDescriptor;
  runtime: IAgentRuntime | AgentRuntime;
  stagedFiles: string[];
}): Promise<void> {
  const { descriptor, runtime, stagedFiles } = params;
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const database = descriptor.components.database;
  let pgliteDir: string | null = null;
  if (database.kind !== "external-postgres-reference") {
    pgliteDir = await resolvePgliteDir();
    if (pgliteDir === ":memory:" || pgliteDir.includes("://")) {
      throw invalidStream(
        `Cannot restore PGlite snapshot into non-filesystem data dir ${pgliteDir}`,
      );
    }
  }
  await preflightSnapshotDestinations({
    configPath,
    descriptor,
    pgliteDir,
    stateDir,
  });
  if (database.kind === "external-postgres-reference") {
    const postgresUrl = hasPostgresUrl(runtime);
    if (!postgresUrl) {
      throw new ElizaError(
        "Snapshot references external Postgres but POSTGRES_URL is not configured",
        {
          code: "AGENT_SNAPSHOT_POSTGRES_CONFIG_MISSING",
          severity: "fatal",
        },
      );
    }
    verifyExternalPostgresReference(postgresUrl, runtime.agentId, database);
  } else {
    if (!pgliteDir) throw invalidStream("PGlite restore path is missing");
    if (
      typeof (runtime.adapter as { close?: () => Promise<void> }).close ===
      "function"
    ) {
      await (runtime.adapter as { close: () => Promise<void> }).close();
    }
    if (database.kind === "pglite-dump") {
      const stagedFile = stagedFiles[database.fileIndex];
      if (!stagedFile) throw invalidStream("PGlite dump staging is missing");
      await restorePgliteDumpFromFile(pgliteDir, stagedFile);
    } else {
      const databaseFiles = descriptor.files.filter(
        (file) => file.component === "database",
      );
      await applyDirectoryFileSet({
        descriptors: databaseFiles,
        root: pgliteDir,
        stagedFiles,
      });
    }
  }

  await applyDirectoryFileSet({
    descriptors: descriptor.files.filter((file) => file.component === "media"),
    root: path.join(stateDir, MEDIA_DIR_NAME),
    stagedFiles,
  });
  await applySharedRootFileSet({
    descriptors: descriptor.files.filter((file) => file.component === "vault"),
    include: vaultFileInclude,
    root: stateDir,
    stagedFiles,
  });
  await applySharedRootFileSet({
    descriptors: descriptor.files.filter((file) => file.component === "state"),
    include: makeStateFileInclude({
      configPath,
      pgliteDir,
      stateDir,
    }),
    root: stateDir,
    stagedFiles,
  });

  const configIndex = descriptor.components.character.configFileIndex;
  if (configIndex === null) {
    await fs.rm(configPath, { force: true });
  } else {
    const configDescriptor = descriptor.files[configIndex];
    const stagedFile = stagedFiles[configIndex];
    if (!configDescriptor || !stagedFile) {
      throw invalidStream("Character config staging is missing");
    }
    await writeFileAtomically(stagedFile, configPath, configDescriptor);
  }

  logger.info(
    {
      agentId: runtime.agentId,
      database: database.kind,
      files: descriptor.files.length,
    },
    "[agent-backup] Streamed snapshot restored",
  );
}

function decodeChunkBytes(frame: AgentSnapshotStreamChunkFrame): Buffer {
  const bytes = Buffer.from(frame.bytesBase64, "base64");
  if (sha256Bytes(bytes) !== frame.sha256) {
    throw invalidStream("Snapshot chunk hash mismatch");
  }
  return bytes;
}

export async function restoreAgentSnapshotStream(
  runtime: IAgentRuntime | AgentRuntime,
  input: AsyncIterable<Uint8Array | string>,
): Promise<AgentSnapshotStreamRestoreResult> {
  const stagingRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), RESTORE_STAGING_PREFIX),
  );
  await fs.chmod(stagingRoot, 0o700);
  const filesRoot = path.join(stagingRoot, "files");
  await fs.mkdir(filesRoot, { recursive: true, mode: 0o700 });

  let pendingParts: Buffer[] = [];
  let pendingBytes = 0;
  let descriptor: AgentSnapshotStreamDescriptor | null = null;
  let trailer: AgentSnapshotStreamTrailer | null = null;
  let currentFileIndex = 0;
  let currentFileOffset = 0;
  let currentChunkIndex = 0;
  let currentFileHash = crypto.createHash("sha256");
  const aggregateHash = crypto.createHash("sha256");
  let chunkCount = 0;
  let totalBytes = 0;
  const stagedFiles: string[] = [];

  const finalizeCurrentFile = async (): Promise<void> => {
    if (!descriptor) throw invalidStream("Snapshot descriptor is missing");
    const file = descriptor.files[currentFileIndex];
    if (!file) return;
    if (currentFileOffset !== file.size) {
      throw invalidStream(`Snapshot file ${file.path} is truncated`);
    }
    const actual = currentFileHash.digest("hex");
    if (actual !== file.sha256) {
      throw invalidStream(`Snapshot file ${file.path} hash is inconsistent`);
    }
    const stagedPath = path.join(filesRoot, String(file.index));
    if (!(await pathExists(stagedPath))) {
      await fs.writeFile(stagedPath, Buffer.alloc(0), {
        flag: "wx",
        mode: 0o600,
      });
    }
    stagedFiles[file.index] = stagedPath;
    currentFileIndex += 1;
    currentFileOffset = 0;
    currentChunkIndex = 0;
    currentFileHash = crypto.createHash("sha256");
  };

  const advanceEmptyFiles = async (): Promise<void> => {
    if (!descriptor) return;
    while (
      currentFileIndex < descriptor.files.length &&
      descriptor.files[currentFileIndex]?.size === 0
    ) {
      await finalizeCurrentFile();
    }
  };

  const processLine = async (line: Buffer): Promise<void> => {
    if (trailer) {
      throw invalidStream("Snapshot stream contains frames after its trailer");
    }
    const frame = parseCanonicalSnapshotStreamFrame(line);
    if (!descriptor) {
      descriptor = validateSnapshotStreamDescriptor(frame);
      if (descriptor.agentId !== runtime.agentId) {
        throw invalidStream(
          `Snapshot belongs to agent ${descriptor.agentId}, not ${runtime.agentId}`,
        );
      }
      await advanceEmptyFiles();
      return;
    }
    if (
      frame !== null &&
      typeof frame === "object" &&
      (frame as { type?: unknown }).type === "chunk"
    ) {
      const chunk = validateSnapshotStreamChunkFrame(frame);
      await advanceEmptyFiles();
      const file = descriptor.files[currentFileIndex];
      if (!file) {
        throw invalidStream("Snapshot stream contains an extra chunk");
      }
      const expectedSize = Math.min(
        descriptor.chunkSize,
        file.size - currentFileOffset,
      );
      if (
        chunk.fileIndex !== file.index ||
        chunk.chunkIndex !== currentChunkIndex ||
        chunk.offset !== currentFileOffset ||
        chunk.size !== expectedSize
      ) {
        throw invalidStream("Snapshot chunks are duplicated or reordered");
      }
      const bytes = decodeChunkBytes(chunk);
      const stagedPath = path.join(filesRoot, String(file.index));
      await fs.appendFile(stagedPath, bytes, {
        flag: currentFileOffset === 0 ? "wx" : "a",
        mode: 0o600,
      });
      stagedFiles[file.index] = stagedPath;
      currentFileHash.update(bytes);
      aggregateHash.update(bytes);
      currentFileOffset += bytes.length;
      currentChunkIndex += 1;
      chunkCount += 1;
      totalBytes += bytes.length;
      if (
        totalBytes > AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES ||
        !Number.isSafeInteger(totalBytes)
      ) {
        throw invalidStream("Snapshot stream exceeds its byte budget");
      }
      if (currentFileOffset === file.size) {
        await finalizeCurrentFile();
        await advanceEmptyFiles();
      }
      return;
    }
    trailer = validateSnapshotStreamTrailer(frame);
    await advanceEmptyFiles();
    if (currentFileIndex !== descriptor.files.length) {
      throw invalidStream("Snapshot stream is truncated before its trailer");
    }
    const actualAggregate = aggregateHash.digest("hex");
    const expectedDescriptorHash = sha256Bytes(stableJson(descriptor));
    if (
      trailer.aggregateSha256 !== actualAggregate ||
      trailer.descriptorSha256 !== expectedDescriptorHash ||
      trailer.chunkCount !== chunkCount ||
      trailer.fileCount !== descriptor.files.length ||
      trailer.totalBytes !== totalBytes
    ) {
      throw invalidStream("Snapshot stream trailer is inconsistent");
    }
  };

  const appendPending = (bytes: Buffer): void => {
    if (bytes.length === 0) return;
    pendingBytes += bytes.length;
    if (pendingBytes > AGENT_SNAPSHOT_STREAM_MAX_LINE_BYTES) {
      throw invalidStream("Snapshot stream line exceeds its byte budget");
    }
    pendingParts.push(bytes);
  };

  const consumeLine = async (tail: Buffer): Promise<void> => {
    appendPending(tail);
    const line =
      pendingParts.length === 1
        ? pendingParts[0]
        : Buffer.concat(pendingParts, pendingBytes);
    if (!line) throw invalidStream("Snapshot stream line is missing");
    pendingParts = [];
    pendingBytes = 0;
    await processLine(line);
  };

  try {
    for await (const inputChunk of input) {
      const bytes =
        typeof inputChunk === "string"
          ? Buffer.from(inputChunk)
          : Buffer.from(
              inputChunk.buffer,
              inputChunk.byteOffset,
              inputChunk.byteLength,
            );
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(0x0a, start);
        if (newline === -1) {
          appendPending(bytes.subarray(start));
          break;
        }
        await consumeLine(bytes.subarray(start, newline));
        start = newline + 1;
      }
    }
    if (pendingBytes !== 0 || !descriptor || !trailer) {
      throw invalidStream("Snapshot stream is truncated");
    }
    const verifiedTrailer = validateSnapshotStreamTrailer(trailer);
    await applyVerifiedSnapshotStream({
      descriptor,
      runtime,
      stagedFiles,
    });
    return {
      aggregateSha256: verifiedTrailer.aggregateSha256,
      fileCount: verifiedTrailer.fileCount,
      schemaVersion: 2,
      success: true,
      totalBytes: verifiedTrailer.totalBytes,
      transfer: AGENT_SNAPSHOT_STREAM_TRANSFER,
    };
  } finally {
    await fs.rm(stagingRoot, { force: true, recursive: true });
  }
}
