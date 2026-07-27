/**
 * Bounded producer and staged consumer for schema-v2 pre-upgrade snapshots.
 * Capture hashes regular files before emitting a canonical descriptor, then
 * re-reads them in fixed chunks and commits only with a terminal aggregate.
 * Restore writes those chunks into an isolated staging directory and does not
 * touch active state until the complete descriptor, files, and trailer verify.
 */
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import { resolveConfigPath, resolveStateDir } from "../config/paths.ts";
import {
  type AgentSnapshotSourceAttestation,
  type AgentSnapshotUpgradeBinding,
  createExternalPostgresReference,
  verifyExternalPostgresReference,
} from "./agent-backup.ts";
import {
  resolveAgentSnapshotSourceAttestation,
  verifyAgentSnapshotSourceAttestation,
} from "./agent-snapshot-source-attestation.ts";
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
  compareSnapshotWirePaths,
  encodeSnapshotStreamFrame,
  fileSetSha256,
  parseCanonicalSnapshotStreamFrame,
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
  requiresRestart: true;
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

async function syncFile(target: string): Promise<void> {
  const handle = await fs.open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(target: string): Promise<void> {
  const handle = await fs.open(target, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectoryDurable(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const missing: string[] = [];
  let current = resolved;
  while (!(await pathExists(current))) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) {
      throw invalidStream(`Snapshot durability root is missing: ${directory}`);
    }
    current = parent;
  }
  const ancestorStat = await fs.lstat(current);
  if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()) {
    throw invalidStream(
      `Snapshot durability path traverses a non-directory: ${directory}`,
    );
  }
  for (const segment of missing) {
    const next = path.join(current, segment);
    try {
      await fs.mkdir(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.lstat(next);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw invalidStream(
          `Snapshot durability path traverses a non-directory: ${directory}`,
        );
      }
    }
    await syncDirectory(next);
    await syncDirectory(current);
    current = next;
  }
}

async function syncDirectoryHierarchy(
  directory: string,
  boundary: string,
): Promise<void> {
  const resolvedBoundary = path.resolve(boundary);
  let current = path.resolve(directory);
  if (!isWithin(resolvedBoundary, current)) {
    throw invalidStream(
      `Snapshot durability path escapes its root: ${directory}`,
    );
  }
  while (true) {
    await syncDirectory(current);
    if (current === resolvedBoundary) return;
    current = path.dirname(current);
  }
}

function hasPostgresUrl(runtime: IAgentRuntime | AgentRuntime): string | null {
  const runtimeSetting = runtime.getSetting?.("POSTGRES_URL");
  if (typeof runtimeSetting === "string" && runtimeSetting.trim()) {
    return runtimeSetting.trim();
  }
  const postgresUrl = process.env.POSTGRES_URL?.trim();
  if (postgresUrl) return postgresUrl;
  const runtimePglite = runtime.getSetting?.("PGLITE_DATA_DIR");
  if (
    (typeof runtimePglite === "string" && runtimePglite.trim()) ||
    process.env.PGLITE_DATA_DIR?.trim()
  ) {
    return null;
  }
  return process.env.DATABASE_URL?.trim() || null;
}

async function resolvePgliteDir(
  runtime?: IAgentRuntime | AgentRuntime,
): Promise<string> {
  const runtimeSetting = runtime?.getSetting?.("PGLITE_DATA_DIR");
  const configured =
    (typeof runtimeSetting === "string" ? runtimeSetting.trim() : "") ||
    process.env.PGLITE_DATA_DIR?.trim();
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
  const traversalBudget = { entryCount: 0, pathBytes: 0 };

  async function visit(directory: string): Promise<void> {
    const entries = [];
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(
        path.relative(root, absolutePath),
      );
      traversalBudget.entryCount += 1;
      traversalBudget.pathBytes += Buffer.byteLength(relativePath);
      if (
        traversalBudget.entryCount > AGENT_SNAPSHOT_STREAM_MAX_FILES ||
        traversalBudget.pathBytes >
          AGENT_SNAPSHOT_STREAM_MAX_DESCRIPTOR_PATH_BYTES
      ) {
        throw invalidStream("Snapshot traversal exceeds its metadata budget");
      }
      entries.push(entry);
    }
    entries.sort((left, right) =>
      compareSnapshotWirePaths(left.name, right.name),
    );
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

async function capturePgliteFilesToTemporaryDirectory(
  runtime: IAgentRuntime | AgentRuntime,
  pgliteDir: string,
  temporaryRoot: string,
  budget: SnapshotPlanBudget,
): Promise<PlannedSnapshotFile[]> {
  const raw = (
    runtime.adapter as
      | {
          getRawConnection?: () => unknown;
        }
      | undefined
  )?.getRawConnection?.();
  if (!raw || typeof raw !== "object") {
    throw new ElizaError(
      "PGlite snapshot requires an exclusive database connection",
      {
        code: "AGENT_SNAPSHOT_DATABASE_UNCAPTURABLE",
        severity: "fatal",
      },
    );
  }
  const connection = raw as {
    runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  };
  if (typeof connection.runExclusive !== "function") {
    throw new ElizaError(
      "PGlite snapshot requires an exclusive database connection",
      {
        code: "AGENT_SNAPSHOT_DATABASE_UNCAPTURABLE",
        severity: "fatal",
      },
    );
  }
  const destinationRoot = path.join(temporaryRoot, "pglite");
  await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await connection.runExclusive(async () => {
    const sourceFiles = await collectPlannedFiles({
      budget: { fileCount: 0, pathBytes: 0 },
      component: "database",
      include: pgliteFileInclude,
      root: pgliteDir,
    });
    const totalBytes = sourceFiles.reduce(
      (total, file) => total + file.descriptor.size,
      0,
    );
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES
    ) {
      throw invalidStream("PGlite files exceed the snapshot byte budget");
    }
    for (const source of sourceFiles) {
      const destination = path.join(
        destinationRoot,
        ...source.descriptor.path.split("/"),
      );
      if (!isWithin(destinationRoot, destination)) {
        throw invalidStream(
          `PGlite snapshot path escapes staging: ${source.descriptor.path}`,
        );
      }
      await writeFileAtomically(
        source.absolutePath,
        destination,
        source.descriptor,
        destinationRoot,
      );
    }
  });
  return collectPlannedFiles({
    budget,
    component: "database",
    include: pgliteFileInclude,
    root: destinationRoot,
  });
}

function indexFiles(files: PlannedSnapshotFile[]): PlannedSnapshotFile[] {
  files.sort((left, right) => {
    const componentDelta =
      FILE_COMPONENT_ORDER.indexOf(left.descriptor.component) -
      FILE_COMPONENT_ORDER.indexOf(right.descriptor.component);
    return (
      componentDelta ||
      compareSnapshotWirePaths(left.descriptor.path, right.descriptor.path)
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
  binding: AgentSnapshotUpgradeBinding,
): Promise<SnapshotStreamPlan> {
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const postgresUrl = hasPostgresUrl(runtime);
  const pgliteDir = postgresUrl ? null : await resolvePgliteDir(runtime);
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
  let databaseKind: "external" | "files";
  const files: PlannedSnapshotFile[] = [];
  const budget: SnapshotPlanBudget = { fileCount: 0, pathBytes: 0 };

  try {
    if (postgresUrl) {
      databaseKind = "external";
    } else {
      temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "eliza-agent-snapshot-capture-"),
      );
      files.push(
        ...(await capturePgliteFilesToTemporaryDirectory(
          runtime,
          pgliteDir as string,
          temporaryRoot,
          budget,
        )),
      );
      databaseKind = "files";
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
      binding,
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
  binding: AgentSnapshotUpgradeBinding,
  sourceAttestation: AgentSnapshotSourceAttestation | null = resolveAgentSnapshotSourceAttestation(),
): AsyncGenerator<Buffer> {
  verifyAgentSnapshotSourceAttestation(binding, sourceAttestation);
  const plan = await createSnapshotStreamPlan(runtime, binding);
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
  durabilityRoot = path.dirname(destination),
): Promise<void> {
  await ensureDirectoryDurable(path.dirname(destination));
  const temporary = `${destination}.snapshot-${crypto.randomUUID()}`;
  try {
    await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    await fs.chmod(temporary, descriptor.mode);
    const mtime = new Date(descriptor.mtimeMs);
    await fs.utimes(temporary, mtime, mtime);
    await syncFile(temporary);
    await fs.rename(temporary, destination);
    await syncDirectoryHierarchy(path.dirname(destination), durabilityRoot);
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
      if (!pgliteFileInclude(file.path)) {
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
        try {
          await fs.rmdir(absolutePath);
          await syncDirectory(directory);
        } catch (error) {
          // error-policy:J3 Concurrent absence/non-empty state is an explicit no-prune result.
          if (
            (error as NodeJS.ErrnoException).code === "ENOENT" ||
            (error as NodeJS.ErrnoException).code === "ENOTEMPTY"
          ) {
            continue;
          }
          throw error;
        }
      } else if (entry.isFile() && !keepPaths.has(relativePath)) {
        await fs.rm(absolutePath, { force: true });
        await syncDirectory(directory);
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
  await ensureDirectoryDurable(parent);
  const candidate = await fs.mkdtemp(
    path.join(parent, `.${path.basename(target)}.snapshot-candidate-`),
  );
  await syncDirectory(parent);
  const previous = path.join(
    parent,
    `.${path.basename(target)}.snapshot-previous-${crypto.randomUUID()}`,
  );
  let movedPrevious = false;
  try {
    await populate(candidate);
    await syncDirectory(candidate);
    if (await pathExists(target)) {
      await fs.rename(target, previous);
      await syncDirectory(parent);
      movedPrevious = true;
    }
    try {
      await fs.rename(candidate, target);
      await syncDirectory(parent);
    } catch (error) {
      // error-policy:J6 A failed directory swap restores the pre-apply directory.
      if (movedPrevious) {
        await fs.rename(previous, target);
        await syncDirectory(parent);
      }
      throw error;
    }
    if (movedPrevious) {
      await fs.rm(previous, { force: true, recursive: true });
      await syncDirectory(parent);
    }
  } finally {
    if (await pathExists(candidate)) {
      await fs.rm(candidate, { force: true, recursive: true });
      await syncDirectory(parent);
    }
  }
}

async function applyDirectoryFileSet(params: {
  descriptors: readonly AgentSnapshotStreamFileDescriptor[];
  root: string;
  stagedFiles: string[];
}): Promise<void> {
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
      await writeFileAtomically(source, destination, descriptor, candidate);
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
    await writeFileAtomically(source, destination, descriptor, params.root);
  }
  await pruneExtraFiles(params.root, params.include, keepPaths);
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
    pgliteDir = await resolvePgliteDir(runtime);
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
    if (database.kind !== "pglite-files") {
      throw invalidStream(
        "PGlite dump snapshots are not bounded-memory restores",
      );
    }
    const databaseFiles = descriptor.files.filter(
      (file) => file.component === "database",
    );
    await applyDirectoryFileSet({
      descriptors: databaseFiles,
      root: pgliteDir,
      stagedFiles,
    });
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
    await syncDirectory(path.dirname(configPath));
  } else {
    const configDescriptor = descriptor.files[configIndex];
    const stagedFile = stagedFiles[configIndex];
    if (!configDescriptor || !stagedFile) {
      throw invalidStream("Character config staging is missing");
    }
    await writeFileAtomically(
      stagedFile,
      configPath,
      configDescriptor,
      path.dirname(configPath),
    );
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

async function consumeAgentSnapshotStream(
  runtime: IAgentRuntime | AgentRuntime,
  input: AsyncIterable<Uint8Array | string>,
  expectedBinding: AgentSnapshotUpgradeBinding,
  apply: boolean,
): Promise<AgentSnapshotStreamRestoreResult> {
  const stagingRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), RESTORE_STAGING_PREFIX),
  );
  await fs.chmod(stagingRoot, 0o700);
  const filesRoot = path.join(stagingRoot, "files");
  await fs.mkdir(filesRoot, { recursive: true, mode: 0o700 });
  await syncDirectory(filesRoot);
  await syncDirectory(stagingRoot);

  let pendingBuffer = Buffer.allocUnsafe(
    Math.min(64 * 1024, AGENT_SNAPSHOT_STREAM_MAX_LINE_BYTES),
  );
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
    await syncFile(stagedPath);
    await syncDirectory(filesRoot);
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
      if (stableJson(descriptor.binding) !== stableJson(expectedBinding)) {
        throw invalidStream(
          "Snapshot does not match this replacement candidate",
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
    const nextBytes = pendingBytes + bytes.length;
    if (
      !Number.isSafeInteger(nextBytes) ||
      nextBytes > AGENT_SNAPSHOT_STREAM_MAX_LINE_BYTES
    ) {
      throw invalidStream("Snapshot stream line exceeds its byte budget");
    }
    if (nextBytes > pendingBuffer.byteLength) {
      let capacity = pendingBuffer.byteLength;
      while (capacity < nextBytes) {
        capacity = Math.min(AGENT_SNAPSHOT_STREAM_MAX_LINE_BYTES, capacity * 2);
      }
      const expanded = Buffer.allocUnsafe(capacity);
      pendingBuffer.copy(expanded, 0, 0, pendingBytes);
      pendingBuffer = expanded;
    }
    bytes.copy(pendingBuffer, pendingBytes);
    pendingBytes = nextBytes;
  };

  const consumeLine = async (tail: Buffer): Promise<void> => {
    appendPending(tail);
    await processLine(pendingBuffer.subarray(0, pendingBytes));
    pendingBytes = 0;
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
    if (apply) {
      await applyVerifiedSnapshotStream({
        descriptor,
        runtime,
        stagedFiles,
      });
    }
    return {
      aggregateSha256: verifiedTrailer.aggregateSha256,
      fileCount: verifiedTrailer.fileCount,
      requiresRestart: true,
      schemaVersion: 2,
      success: true,
      totalBytes: verifiedTrailer.totalBytes,
      transfer: AGENT_SNAPSHOT_STREAM_TRANSFER,
    };
  } finally {
    await fs.rm(stagingRoot, { force: true, recursive: true });
  }
}

export async function restoreAgentSnapshotStream(
  runtime: IAgentRuntime | AgentRuntime,
  input: AsyncIterable<Uint8Array | string>,
  expectedBinding: AgentSnapshotUpgradeBinding,
): Promise<AgentSnapshotStreamRestoreResult> {
  return consumeAgentSnapshotStream(runtime, input, expectedBinding, true);
}

export async function validateAgentSnapshotStream(
  runtime: IAgentRuntime | AgentRuntime,
  input: AsyncIterable<Uint8Array | string>,
  expectedBinding: AgentSnapshotUpgradeBinding,
): Promise<AgentSnapshotStreamRestoreResult> {
  return consumeAgentSnapshotStream(runtime, input, expectedBinding, false);
}
