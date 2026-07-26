/**
 * Canonical wire contract for bounded pre-upgrade agent snapshots. The
 * descriptor carries only identity and content metadata; ordered NDJSON chunk
 * frames carry fixed-size file bytes, and a terminal frame commits the complete
 * aggregate. Strict shape and ordering checks make stored transfers replayable
 * without accepting ambiguous or partially written state.
 */
import crypto from "node:crypto";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import type { AgentBackupExternalPostgresReference } from "./agent-backup.ts";

export const AGENT_SNAPSHOT_STREAM_CONTENT_TYPE =
  "application/x-elizaos-agent-snapshot-v2+ndjson";
export const AGENT_SNAPSHOT_STREAM_FORMAT =
  "elizaos.agent-snapshot-stream" as const;
export const AGENT_SNAPSHOT_STREAM_TRANSFER = "chunked-v1" as const;
export const AGENT_SNAPSHOT_STREAM_CHUNK_BYTES = 256 * 1024;
export const AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
export const AGENT_SNAPSHOT_STREAM_MAX_FILES = 16_384;
export const AGENT_SNAPSHOT_STREAM_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const AGENT_SNAPSHOT_STREAM_MAX_PATH_BYTES = 4 * 1024;
export const AGENT_SNAPSHOT_STREAM_MAX_DESCRIPTOR_PATH_BYTES = 2 * 1024 * 1024;

export type AgentSnapshotStreamFileComponent =
  | "database"
  | "media"
  | "vault"
  | "character-config"
  | "state";

export interface AgentSnapshotStreamFileDescriptor {
  component: AgentSnapshotStreamFileComponent;
  index: number;
  mode: number;
  mtimeMs: number;
  path: string;
  sha256: string;
  size: number;
}

export interface AgentSnapshotStreamFileSetDescriptor {
  fileIndices: number[];
  kind: "file-set";
  sha256: string;
}

export type AgentSnapshotStreamDatabaseDescriptor =
  | {
      externalPostgres: AgentBackupExternalPostgresReference;
      kind: "external-postgres-reference";
      sha256: string;
    }
  | {
      compression: "gzip";
      fileIndex: number;
      kind: "pglite-dump";
      sha256: string;
    }
  | {
      fileIndices: number[];
      kind: "pglite-files";
      sha256: string;
    };

export interface AgentSnapshotStreamDescriptor {
  agentId: string;
  chunkSize: number;
  components: {
    character: {
      configFileIndex: number | null;
      kind: "character-config";
      sha256: string;
    };
    database: AgentSnapshotStreamDatabaseDescriptor;
    media: AgentSnapshotStreamFileSetDescriptor;
    stateFiles: AgentSnapshotStreamFileSetDescriptor;
    vault: AgentSnapshotStreamFileSetDescriptor;
  };
  createdAt: string;
  files: AgentSnapshotStreamFileDescriptor[];
  format: typeof AGENT_SNAPSHOT_STREAM_FORMAT;
  schemaVersion: 2;
  transfer: typeof AGENT_SNAPSHOT_STREAM_TRANSFER;
  type: "descriptor";
}

export interface AgentSnapshotStreamChunkFrame {
  bytesBase64: string;
  chunkIndex: number;
  fileIndex: number;
  offset: number;
  sha256: string;
  size: number;
  type: "chunk";
}

export interface AgentSnapshotStreamTrailer {
  aggregateSha256: string;
  chunkCount: number;
  descriptorSha256: string;
  fileCount: number;
  totalBytes: number;
  type: "trailer";
}

export type AgentSnapshotStreamFrame =
  | AgentSnapshotStreamDescriptor
  | AgentSnapshotStreamChunkFrame
  | AgentSnapshotStreamTrailer;

const FILE_COMPONENT_ORDER: readonly AgentSnapshotStreamFileComponent[] = [
  "database",
  "media",
  "vault",
  "character-config",
  "state",
];
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ECMASCRIPT_TIMESTAMP_MS = 8_640_000_000_000_000;

function invalidProtocol(message: string): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_SNAPSHOT_STREAM_INVALID",
    severity: "fatal",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (stableJson(actual) !== stableJson(canonical)) {
    throw invalidProtocol(`${label} has unsupported or missing fields`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw invalidProtocol(`${label} is not a SHA-256 digest`);
  }
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidProtocol(`${label} is outside its integer budget`);
  }
}

function assertIndexArray(
  value: unknown,
  label: string,
): asserts value is number[] {
  if (!Array.isArray(value)) {
    throw invalidProtocol(`${label} must be an index array`);
  }
  let previous = -1;
  for (const item of value) {
    assertSafeInteger(item, `${label} index`);
    if (item <= previous) {
      throw invalidProtocol(`${label} indices are duplicated or reordered`);
    }
    previous = item;
  }
}

function normalizeWirePath(input: string): string {
  if (
    !input ||
    input.includes("\\") ||
    [...input].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    }) ||
    Buffer.byteLength(input) > AGENT_SNAPSHOT_STREAM_MAX_PATH_BYTES
  ) {
    throw invalidProtocol("Snapshot file path is malformed");
  }
  const normalized = path.posix.normalize(input);
  if (
    normalized !== input ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw invalidProtocol(`Snapshot file path escapes its root: ${input}`);
  }
  return normalized;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Bytes(stableJson(value));
}

export function compareSnapshotWirePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function fileSetSha256(
  files: readonly AgentSnapshotStreamFileDescriptor[],
): string {
  return sha256Json(
    files.map(({ path: filePath, sha256, size }) => ({
      path: filePath,
      sha256,
      size,
    })),
  );
}

export function characterConfigSha256(
  file: AgentSnapshotStreamFileDescriptor | null,
): string {
  return sha256Json({
    configFile: file
      ? {
          path: file.path,
          sha256: file.sha256,
          size: file.size,
        }
      : null,
  });
}

function validateExternalPostgresDescriptor(
  value: unknown,
): asserts value is Extract<
  AgentSnapshotStreamDatabaseDescriptor,
  { kind: "external-postgres-reference" }
> {
  if (!isRecord(value)) {
    throw invalidProtocol("Snapshot database descriptor is malformed");
  }
  assertExactKeys(
    value,
    ["externalPostgres", "kind", "sha256"],
    "External Postgres database descriptor",
  );
  if (value.kind !== "external-postgres-reference") {
    throw invalidProtocol("Snapshot database kind is inconsistent");
  }
  assertDigest(value.sha256, "Snapshot database hash");
  if (!isRecord(value.externalPostgres)) {
    throw invalidProtocol("External Postgres identity is malformed");
  }
  assertExactKeys(
    value.externalPostgres,
    ["algorithm", "identitySha256", "identityVersion", "kind", "sha256"],
    "External Postgres identity",
  );
  if (
    value.externalPostgres.kind !== "external-postgres-reference" ||
    value.externalPostgres.identityVersion !== 1 ||
    value.externalPostgres.algorithm !== "sha256"
  ) {
    throw invalidProtocol("External Postgres identity is malformed");
  }
  assertDigest(
    value.externalPostgres.identitySha256,
    "External Postgres identity hash",
  );
  assertDigest(value.externalPostgres.sha256, "External Postgres hash");
  const expected = sha256Json({
    algorithm: "sha256",
    identitySha256: value.externalPostgres.identitySha256,
    identityVersion: 1,
    kind: "external-postgres-reference",
  });
  if (expected !== value.externalPostgres.sha256 || expected !== value.sha256) {
    throw invalidProtocol("External Postgres identity hash is inconsistent");
  }
}

function validateDatabaseDescriptor(
  value: unknown,
  files: readonly AgentSnapshotStreamFileDescriptor[],
): asserts value is AgentSnapshotStreamDatabaseDescriptor {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw invalidProtocol("Snapshot database descriptor is malformed");
  }
  if (value.kind === "external-postgres-reference") {
    validateExternalPostgresDescriptor(value);
    if (files.some((file) => file.component === "database")) {
      throw invalidProtocol(
        "External Postgres descriptor contains hydrated database files",
      );
    }
    return;
  }
  if (value.kind === "pglite-dump") {
    throw invalidProtocol(
      "PGlite dump snapshots are not a bounded-memory transfer",
    );
  }
  if (value.kind === "pglite-files") {
    assertExactKeys(
      value,
      ["fileIndices", "kind", "sha256"],
      "PGlite file-set descriptor",
    );
    assertIndexArray(value.fileIndices, "PGlite file-set");
    assertDigest(value.sha256, "PGlite file-set hash");
    const databaseFiles = files.filter((file) => file.component === "database");
    if (
      databaseFiles.length === 0 ||
      stableJson(value.fileIndices) !==
        stableJson(databaseFiles.map((file) => file.index)) ||
      fileSetSha256(databaseFiles) !== value.sha256
    ) {
      throw invalidProtocol("PGlite file-set index or hash is inconsistent");
    }
    return;
  }
  throw invalidProtocol("Snapshot database kind is unsupported");
}

function validateFileSetDescriptor(
  value: unknown,
  label: string,
  component: AgentSnapshotStreamFileComponent,
  files: readonly AgentSnapshotStreamFileDescriptor[],
): asserts value is AgentSnapshotStreamFileSetDescriptor {
  if (!isRecord(value)) {
    throw invalidProtocol(`${label} descriptor is malformed`);
  }
  assertExactKeys(
    value,
    ["fileIndices", "kind", "sha256"],
    `${label} descriptor`,
  );
  if (value.kind !== "file-set") {
    throw invalidProtocol(`${label} descriptor kind is unsupported`);
  }
  assertIndexArray(value.fileIndices, label);
  assertDigest(value.sha256, `${label} hash`);
  const componentFiles = files.filter((file) => file.component === component);
  if (
    stableJson(value.fileIndices) !==
      stableJson(componentFiles.map((file) => file.index)) ||
    fileSetSha256(componentFiles) !== value.sha256
  ) {
    throw invalidProtocol(`${label} file index or hash is inconsistent`);
  }
}

function validateCharacterDescriptor(
  value: unknown,
  files: readonly AgentSnapshotStreamFileDescriptor[],
): asserts value is AgentSnapshotStreamDescriptor["components"]["character"] {
  if (!isRecord(value)) {
    throw invalidProtocol("Character config descriptor is malformed");
  }
  assertExactKeys(
    value,
    ["configFileIndex", "kind", "sha256"],
    "Character config descriptor",
  );
  if (value.kind !== "character-config") {
    throw invalidProtocol("Character config descriptor kind is unsupported");
  }
  if (value.configFileIndex !== null) {
    assertSafeInteger(value.configFileIndex, "Character config file index");
  }
  assertDigest(value.sha256, "Character config hash");
  const characterFiles = files.filter(
    (file) => file.component === "character-config",
  );
  const file =
    value.configFileIndex === null ? null : files[value.configFileIndex];
  if (
    characterFiles.length !== (file ? 1 : 0) ||
    (file && file.component !== "character-config") ||
    characterConfigSha256(file ?? null) !== value.sha256
  ) {
    throw invalidProtocol(
      "Character config file index or hash is inconsistent",
    );
  }
}

function validateFileDescriptor(
  value: unknown,
  expectedIndex: number,
): asserts value is AgentSnapshotStreamFileDescriptor {
  if (!isRecord(value)) {
    throw invalidProtocol("Snapshot file descriptor is malformed");
  }
  assertExactKeys(
    value,
    ["component", "index", "mode", "mtimeMs", "path", "sha256", "size"],
    "Snapshot file descriptor",
  );
  if (
    typeof value.component !== "string" ||
    !FILE_COMPONENT_ORDER.includes(
      value.component as AgentSnapshotStreamFileComponent,
    )
  ) {
    throw invalidProtocol("Snapshot file component is unsupported");
  }
  assertSafeInteger(value.index, "Snapshot file index");
  if (value.index !== expectedIndex) {
    throw invalidProtocol("Snapshot file indices are duplicated or reordered");
  }
  assertSafeInteger(value.mode, "Snapshot file mode", 0, 0o777);
  if (
    typeof value.mtimeMs !== "number" ||
    !Number.isFinite(value.mtimeMs) ||
    value.mtimeMs < 0 ||
    value.mtimeMs > MAX_ECMASCRIPT_TIMESTAMP_MS
  ) {
    throw invalidProtocol("Snapshot file mtime is malformed");
  }
  if (typeof value.path !== "string") {
    throw invalidProtocol("Snapshot file path is malformed");
  }
  normalizeWirePath(value.path);
  assertDigest(value.sha256, "Snapshot file hash");
  assertSafeInteger(
    value.size,
    "Snapshot file size",
    0,
    AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES,
  );
}

export function validateSnapshotStreamDescriptor(
  value: unknown,
): AgentSnapshotStreamDescriptor {
  if (!isRecord(value)) {
    throw invalidProtocol("Snapshot stream descriptor is malformed");
  }
  assertExactKeys(
    value,
    [
      "agentId",
      "chunkSize",
      "components",
      "createdAt",
      "files",
      "format",
      "schemaVersion",
      "transfer",
      "type",
    ],
    "Snapshot stream descriptor",
  );
  if (
    value.type !== "descriptor" ||
    value.format !== AGENT_SNAPSHOT_STREAM_FORMAT ||
    value.schemaVersion !== 2 ||
    value.transfer !== AGENT_SNAPSHOT_STREAM_TRANSFER ||
    value.chunkSize !== AGENT_SNAPSHOT_STREAM_CHUNK_BYTES
  ) {
    throw invalidProtocol("Snapshot stream descriptor version is unsupported");
  }
  if (typeof value.agentId !== "string" || !value.agentId.trim()) {
    throw invalidProtocol("Snapshot stream agent id is missing");
  }
  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw invalidProtocol("Snapshot stream creation timestamp is malformed");
  }
  if (
    !Array.isArray(value.files) ||
    value.files.length > AGENT_SNAPSHOT_STREAM_MAX_FILES
  ) {
    throw invalidProtocol("Snapshot stream file count exceeds its budget");
  }
  const files = value.files;
  let totalBytes = 0;
  let totalPathBytes = 0;
  const seenPaths = new Set<string>();
  let previousComponentRank = -1;
  let previousPath = "";
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    validateFileDescriptor(file, index);
    totalBytes += file.size;
    totalPathBytes += Buffer.byteLength(file.path);
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES
    ) {
      throw invalidProtocol("Snapshot stream byte total exceeds its budget");
    }
    if (
      !Number.isSafeInteger(totalPathBytes) ||
      totalPathBytes > AGENT_SNAPSHOT_STREAM_MAX_DESCRIPTOR_PATH_BYTES
    ) {
      throw invalidProtocol(
        "Snapshot stream descriptor paths exceed their byte budget",
      );
    }
    const componentRank = FILE_COMPONENT_ORDER.indexOf(file.component);
    if (
      componentRank < previousComponentRank ||
      (componentRank === previousComponentRank &&
        compareSnapshotWirePaths(file.path, previousPath) <= 0)
    ) {
      throw invalidProtocol("Snapshot files are not in canonical order");
    }
    if (
      componentRank === previousComponentRank &&
      file.path.startsWith(`${previousPath}/`)
    ) {
      throw invalidProtocol("Snapshot file paths conflict with a parent file");
    }
    previousComponentRank = componentRank;
    previousPath = file.path;
    const pathKey = `${file.component}:${file.path}`;
    if (seenPaths.has(pathKey)) {
      throw invalidProtocol("Snapshot file paths are duplicated");
    }
    seenPaths.add(pathKey);
  }
  if (!isRecord(value.components)) {
    throw invalidProtocol("Snapshot component index is malformed");
  }
  assertExactKeys(
    value.components,
    ["character", "database", "media", "stateFiles", "vault"],
    "Snapshot component index",
  );
  validateDatabaseDescriptor(value.components.database, files);
  validateFileSetDescriptor(value.components.media, "Media", "media", files);
  validateFileSetDescriptor(value.components.vault, "Vault", "vault", files);
  validateFileSetDescriptor(
    value.components.stateFiles,
    "State",
    "state",
    files,
  );
  validateCharacterDescriptor(value.components.character, files);
  return value as unknown as AgentSnapshotStreamDescriptor;
}

export function parseCanonicalSnapshotStreamFrame(line: Buffer): unknown {
  if (
    line.length === 0 ||
    line.length > AGENT_SNAPSHOT_STREAM_MAX_LINE_BYTES ||
    line.includes(0x0d)
  ) {
    throw invalidProtocol("Snapshot stream line exceeds its canonical budget");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch (cause) {
    // error-policy:J3 Untrusted NDJSON becomes an explicit invalid-protocol error.
    throw new ElizaError("Snapshot stream line is not valid JSON", {
      code: "AGENT_SNAPSHOT_STREAM_INVALID",
      cause,
      severity: "fatal",
    });
  }
  if (stableJson(parsed) !== line.toString("utf8")) {
    throw invalidProtocol("Snapshot stream line is not canonical JSON");
  }
  return parsed;
}

export function validateSnapshotStreamChunkFrame(
  value: unknown,
): AgentSnapshotStreamChunkFrame {
  if (!isRecord(value)) {
    throw invalidProtocol("Snapshot chunk frame is malformed");
  }
  assertExactKeys(
    value,
    [
      "bytesBase64",
      "chunkIndex",
      "fileIndex",
      "offset",
      "sha256",
      "size",
      "type",
    ],
    "Snapshot chunk frame",
  );
  if (value.type !== "chunk") {
    throw invalidProtocol("Snapshot chunk frame type is unsupported");
  }
  assertSafeInteger(value.chunkIndex, "Snapshot chunk index");
  assertSafeInteger(value.fileIndex, "Snapshot chunk file index");
  assertSafeInteger(value.offset, "Snapshot chunk offset");
  assertSafeInteger(
    value.size,
    "Snapshot chunk size",
    1,
    AGENT_SNAPSHOT_STREAM_CHUNK_BYTES,
  );
  assertDigest(value.sha256, "Snapshot chunk hash");
  if (
    typeof value.bytesBase64 !== "string" ||
    !BASE64_PATTERN.test(value.bytesBase64)
  ) {
    throw invalidProtocol("Snapshot chunk bytes are not canonical base64");
  }
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (
    bytes.length !== value.size ||
    bytes.toString("base64") !== value.bytesBase64
  ) {
    throw invalidProtocol("Snapshot chunk byte size is inconsistent");
  }
  return value as unknown as AgentSnapshotStreamChunkFrame;
}

export function validateSnapshotStreamTrailer(
  value: unknown,
): AgentSnapshotStreamTrailer {
  if (!isRecord(value)) {
    throw invalidProtocol("Snapshot stream trailer is malformed");
  }
  assertExactKeys(
    value,
    [
      "aggregateSha256",
      "chunkCount",
      "descriptorSha256",
      "fileCount",
      "totalBytes",
      "type",
    ],
    "Snapshot stream trailer",
  );
  if (value.type !== "trailer") {
    throw invalidProtocol("Snapshot stream trailer type is unsupported");
  }
  assertDigest(value.aggregateSha256, "Snapshot aggregate hash");
  assertDigest(value.descriptorSha256, "Snapshot descriptor hash");
  assertSafeInteger(value.chunkCount, "Snapshot chunk count");
  assertSafeInteger(
    value.fileCount,
    "Snapshot file count",
    0,
    AGENT_SNAPSHOT_STREAM_MAX_FILES,
  );
  assertSafeInteger(
    value.totalBytes,
    "Snapshot byte total",
    0,
    AGENT_SNAPSHOT_STREAM_MAX_TOTAL_BYTES,
  );
  return value as unknown as AgentSnapshotStreamTrailer;
}

export function encodeSnapshotStreamFrame(
  frame: AgentSnapshotStreamFrame,
): Buffer {
  const line = Buffer.from(`${stableJson(frame)}\n`);
  if (line.length - 1 > AGENT_SNAPSHOT_STREAM_MAX_LINE_BYTES) {
    throw invalidProtocol("Snapshot stream line exceeds its canonical budget");
  }
  return line;
}
