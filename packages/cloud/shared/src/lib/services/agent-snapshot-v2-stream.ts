/**
 * Strict bounded-memory validation for the agent snapshot v2 NDJSON transport.
 *
 * Cloud storage observes the canonical descriptor, ordered file chunks, and
 * committing trailer while forwarding the original wire bytes to encrypted
 * chunk storage. Validation retains at most one protocol line plus the bounded
 * descriptor, never the complete snapshot payload.
 */
import { createHash, type Hash } from "node:crypto";
import path from "node:path";
import { ElizaError } from "@elizaos/core";

export const AGENT_SNAPSHOT_V2_CONTENT_TYPE = "application/x-elizaos-agent-snapshot-v2+ndjson";
export const AGENT_SNAPSHOT_V2_FORMAT = "elizaos.agent-snapshot-stream";
export const AGENT_SNAPSHOT_V2_TRANSFER = "chunked-v1";
export const AGENT_SNAPSHOT_V2_CHUNK_BYTES = 256 * 1024;
export const AGENT_SNAPSHOT_V2_MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
export const AGENT_SNAPSHOT_V2_MAX_FILES = 100_000;
export const AGENT_SNAPSHOT_V2_MAX_LINE_BYTES = 16 * 1024 * 1024;
export const AGENT_SNAPSHOT_V2_MAX_PATH_BYTES = 4 * 1024;
export const AGENT_SNAPSHOT_V2_REPACK_VIEW_BYTES = 4 * 1024 * 1024;

export type AgentSnapshotV2FileComponent =
  | "database"
  | "media"
  | "vault"
  | "character-config"
  | "state";

export interface AgentSnapshotV2FileDescriptor {
  component: AgentSnapshotV2FileComponent;
  index: number;
  mode: number;
  mtimeMs: number;
  path: string;
  sha256: string;
  size: number;
}

export interface AgentSnapshotV2FileSetDescriptor {
  fileIndices: number[];
  kind: "file-set";
  sha256: string;
}

export interface AgentSnapshotV2ExternalPostgresReference {
  algorithm: "sha256";
  identitySha256: string;
  identityVersion: 1;
  kind: "external-postgres-reference";
  sha256: string;
}

export type AgentSnapshotV2DatabaseDescriptor =
  | {
      externalPostgres: AgentSnapshotV2ExternalPostgresReference;
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

export interface AgentSnapshotV2Descriptor {
  agentId: string;
  chunkSize: number;
  components: {
    character: {
      configFileIndex: number | null;
      kind: "character-config";
      sha256: string;
    };
    database: AgentSnapshotV2DatabaseDescriptor;
    media: AgentSnapshotV2FileSetDescriptor;
    stateFiles: AgentSnapshotV2FileSetDescriptor;
    vault: AgentSnapshotV2FileSetDescriptor;
  };
  createdAt: string;
  files: AgentSnapshotV2FileDescriptor[];
  format: typeof AGENT_SNAPSHOT_V2_FORMAT;
  schemaVersion: 2;
  transfer: typeof AGENT_SNAPSHOT_V2_TRANSFER;
  type: "descriptor";
}

export interface AgentSnapshotV2ChunkFrame {
  bytesBase64: string;
  chunkIndex: number;
  fileIndex: number;
  offset: number;
  sha256: string;
  size: number;
  type: "chunk";
}

export interface AgentSnapshotV2Trailer {
  aggregateSha256: string;
  chunkCount: number;
  descriptorSha256: string;
  fileCount: number;
  totalBytes: number;
  type: "trailer";
}

export type AgentSnapshotV2Frame =
  | AgentSnapshotV2Descriptor
  | AgentSnapshotV2ChunkFrame
  | AgentSnapshotV2Trailer;

export interface AgentSnapshotV2ValidationSummary {
  descriptor: AgentSnapshotV2Descriptor;
  peakBufferedLineBytes: number;
  trailer: AgentSnapshotV2Trailer;
  wireBytes: number;
}

export interface AgentSnapshotV2ValidatorOptions {
  contentType: string;
  expectedAgentId?: string;
}

const FILE_COMPONENT_ORDER: readonly AgentSnapshotV2FileComponent[] = [
  "database",
  "media",
  "vault",
  "character-config",
  "state",
];
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidSnapshot(
  message: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_SNAPSHOT_V2_STREAM_INVALID",
    context,
    cause,
    severity: "fatal",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileComponent(value: string): value is AgentSnapshotV2FileComponent {
  return FILE_COMPONENT_ORDER.some((component) => component === value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw invalidSnapshot(`${label} has unsupported or missing fields`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw invalidSnapshot(`${label} is not a SHA-256 digest`);
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
    throw invalidSnapshot(`${label} is outside its integer budget`);
  }
}

function assertIndexArray(value: unknown, label: string): asserts value is number[] {
  if (!Array.isArray(value)) {
    throw invalidSnapshot(`${label} must be an index array`);
  }
  let previous = -1;
  for (const item of value) {
    assertSafeInteger(item, `${label} index`);
    if (item <= previous) {
      throw invalidSnapshot(`${label} indices are duplicated or reordered`);
    }
    previous = item;
  }
}

function normalizeWirePath(input: string): string {
  if (
    input.length === 0 ||
    input.includes("\\") ||
    input.includes("\0") ||
    Buffer.byteLength(input) > AGENT_SNAPSHOT_V2_MAX_PATH_BYTES
  ) {
    throw invalidSnapshot("Snapshot file path is malformed");
  }
  const normalized = path.posix.normalize(input);
  if (
    normalized !== input ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw invalidSnapshot(`Snapshot file path escapes its root: ${input}`);
  }
  return normalized;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

export function agentSnapshotV2StableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function agentSnapshotV2Sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function agentSnapshotV2Sha256Json(value: unknown): string {
  return agentSnapshotV2Sha256(agentSnapshotV2StableJson(value));
}

function fileSetSha256(files: readonly AgentSnapshotV2FileDescriptor[]): string {
  return agentSnapshotV2Sha256Json(
    files.map(({ path: filePath, sha256, size }) => ({
      path: filePath,
      sha256,
      size,
    })),
  );
}

function characterConfigSha256(file: AgentSnapshotV2FileDescriptor | null): string {
  return agentSnapshotV2Sha256Json({
    configFile: file
      ? {
          path: file.path,
          sha256: file.sha256,
          size: file.size,
        }
      : null,
  });
}

function pgliteDumpSha256(file: AgentSnapshotV2FileDescriptor): string {
  return agentSnapshotV2Sha256Json({
    compression: "gzip",
    file: { path: file.path, sha256: file.sha256, size: file.size },
    kind: "pglite-dump",
  });
}

function validateExternalPostgresDescriptor(
  value: unknown,
): asserts value is Extract<
  AgentSnapshotV2DatabaseDescriptor,
  { kind: "external-postgres-reference" }
> {
  if (!isRecord(value)) {
    throw invalidSnapshot("Snapshot database descriptor is malformed");
  }
  assertExactKeys(
    value,
    ["externalPostgres", "kind", "sha256"],
    "External Postgres database descriptor",
  );
  if (value.kind !== "external-postgres-reference") {
    throw invalidSnapshot("Snapshot database kind is inconsistent");
  }
  assertDigest(value.sha256, "Snapshot database hash");
  if (!isRecord(value.externalPostgres)) {
    throw invalidSnapshot("External Postgres identity is malformed");
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
    throw invalidSnapshot("External Postgres identity is malformed");
  }
  assertDigest(value.externalPostgres.identitySha256, "External Postgres identity hash");
  assertDigest(value.externalPostgres.sha256, "External Postgres hash");
  const expected = agentSnapshotV2Sha256Json({
    algorithm: "sha256",
    identitySha256: value.externalPostgres.identitySha256,
    identityVersion: 1,
    kind: "external-postgres-reference",
  });
  if (expected !== value.externalPostgres.sha256 || expected !== value.sha256) {
    throw invalidSnapshot("External Postgres identity hash is inconsistent");
  }
}

function validateDatabaseDescriptor(
  value: unknown,
  files: readonly AgentSnapshotV2FileDescriptor[],
): asserts value is AgentSnapshotV2DatabaseDescriptor {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw invalidSnapshot("Snapshot database descriptor is malformed");
  }
  if (value.kind === "external-postgres-reference") {
    validateExternalPostgresDescriptor(value);
    if (files.some((file) => file.component === "database")) {
      throw invalidSnapshot("External Postgres descriptor contains database bytes");
    }
    return;
  }
  if (value.kind === "pglite-dump") {
    assertExactKeys(
      value,
      ["compression", "fileIndex", "kind", "sha256"],
      "PGlite dump descriptor",
    );
    if (value.compression !== "gzip") {
      throw invalidSnapshot("PGlite dump compression is unsupported");
    }
    assertSafeInteger(value.fileIndex, "PGlite dump file index");
    assertDigest(value.sha256, "PGlite dump hash");
    const file = files[value.fileIndex];
    if (!file || file.component !== "database") {
      throw invalidSnapshot("PGlite dump file index is inconsistent");
    }
    if (pgliteDumpSha256(file) !== value.sha256) {
      throw invalidSnapshot("PGlite dump hash is inconsistent");
    }
    return;
  }
  if (value.kind === "pglite-files") {
    assertExactKeys(value, ["fileIndices", "kind", "sha256"], "PGlite file-set descriptor");
    assertIndexArray(value.fileIndices, "PGlite file-set");
    assertDigest(value.sha256, "PGlite file-set hash");
    const databaseFiles = files.filter((file) => file.component === "database");
    if (
      value.fileIndices.length !== databaseFiles.length ||
      value.fileIndices.some((fileIndex, index) => fileIndex !== databaseFiles[index]?.index) ||
      fileSetSha256(databaseFiles) !== value.sha256
    ) {
      throw invalidSnapshot("PGlite file-set index or hash is inconsistent");
    }
    return;
  }
  throw invalidSnapshot("Snapshot database kind is unsupported");
}

function validateFileSetDescriptor(
  value: unknown,
  label: string,
  component: AgentSnapshotV2FileComponent,
  files: readonly AgentSnapshotV2FileDescriptor[],
): asserts value is AgentSnapshotV2FileSetDescriptor {
  if (!isRecord(value)) {
    throw invalidSnapshot(`${label} descriptor is malformed`);
  }
  assertExactKeys(value, ["fileIndices", "kind", "sha256"], `${label} descriptor`);
  if (value.kind !== "file-set") {
    throw invalidSnapshot(`${label} descriptor kind is unsupported`);
  }
  assertIndexArray(value.fileIndices, label);
  assertDigest(value.sha256, `${label} hash`);
  const componentFiles = files.filter((file) => file.component === component);
  if (
    value.fileIndices.length !== componentFiles.length ||
    value.fileIndices.some((fileIndex, index) => fileIndex !== componentFiles[index]?.index) ||
    fileSetSha256(componentFiles) !== value.sha256
  ) {
    throw invalidSnapshot(`${label} file index or hash is inconsistent`);
  }
}

function validateCharacterDescriptor(
  value: unknown,
  files: readonly AgentSnapshotV2FileDescriptor[],
): asserts value is AgentSnapshotV2Descriptor["components"]["character"] {
  if (!isRecord(value)) {
    throw invalidSnapshot("Character config descriptor is malformed");
  }
  assertExactKeys(value, ["configFileIndex", "kind", "sha256"], "Character config descriptor");
  if (value.kind !== "character-config") {
    throw invalidSnapshot("Character config descriptor kind is unsupported");
  }
  if (value.configFileIndex !== null) {
    assertSafeInteger(value.configFileIndex, "Character config file index");
  }
  assertDigest(value.sha256, "Character config hash");
  const characterFiles = files.filter((file) => file.component === "character-config");
  const file = value.configFileIndex === null ? null : files[value.configFileIndex];
  if (
    characterFiles.length !== (file ? 1 : 0) ||
    (file && file.component !== "character-config") ||
    characterConfigSha256(file ?? null) !== value.sha256
  ) {
    throw invalidSnapshot("Character config file index or hash is inconsistent");
  }
}

function validateFileDescriptor(
  value: unknown,
  expectedIndex: number,
): asserts value is AgentSnapshotV2FileDescriptor {
  if (!isRecord(value)) {
    throw invalidSnapshot("Snapshot file descriptor is malformed");
  }
  assertExactKeys(
    value,
    ["component", "index", "mode", "mtimeMs", "path", "sha256", "size"],
    "Snapshot file descriptor",
  );
  if (typeof value.component !== "string" || !isFileComponent(value.component)) {
    throw invalidSnapshot("Snapshot file component is unsupported");
  }
  assertSafeInteger(value.index, "Snapshot file index");
  if (value.index !== expectedIndex) {
    throw invalidSnapshot("Snapshot file indices are duplicated or reordered");
  }
  assertSafeInteger(value.mode, "Snapshot file mode", 0, 0o777);
  if (typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs) || value.mtimeMs < 0) {
    throw invalidSnapshot("Snapshot file mtime is malformed");
  }
  if (typeof value.path !== "string") {
    throw invalidSnapshot("Snapshot file path is malformed");
  }
  normalizeWirePath(value.path);
  assertDigest(value.sha256, "Snapshot file hash");
  assertSafeInteger(value.size, "Snapshot file size", 0, AGENT_SNAPSHOT_V2_MAX_TOTAL_BYTES);
}

function validateDescriptor(value: unknown): asserts value is AgentSnapshotV2Descriptor {
  if (!isRecord(value)) {
    throw invalidSnapshot("Snapshot stream descriptor is malformed");
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
    value.format !== AGENT_SNAPSHOT_V2_FORMAT ||
    value.schemaVersion !== 2 ||
    value.transfer !== AGENT_SNAPSHOT_V2_TRANSFER ||
    value.chunkSize !== AGENT_SNAPSHOT_V2_CHUNK_BYTES
  ) {
    throw invalidSnapshot("Snapshot stream descriptor version is unsupported");
  }
  if (typeof value.agentId !== "string" || value.agentId.trim().length === 0) {
    throw invalidSnapshot("Snapshot stream agent id is missing");
  }
  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw invalidSnapshot("Snapshot stream creation timestamp is malformed");
  }
  if (!Array.isArray(value.files) || value.files.length > AGENT_SNAPSHOT_V2_MAX_FILES) {
    throw invalidSnapshot("Snapshot stream file count exceeds its budget");
  }

  const files = value.files;
  let totalBytes = 0;
  let previousComponentRank = -1;
  let previousPath = "";
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    validateFileDescriptor(file, index);
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > AGENT_SNAPSHOT_V2_MAX_TOTAL_BYTES) {
      throw invalidSnapshot("Snapshot stream byte total exceeds its budget");
    }
    const componentRank = FILE_COMPONENT_ORDER.indexOf(file.component);
    if (
      componentRank < previousComponentRank ||
      (componentRank === previousComponentRank && file.path.localeCompare(previousPath) <= 0)
    ) {
      throw invalidSnapshot("Snapshot files are not in canonical order");
    }
    previousComponentRank = componentRank;
    previousPath = file.path;
  }

  if (!isRecord(value.components)) {
    throw invalidSnapshot("Snapshot component index is malformed");
  }
  assertExactKeys(
    value.components,
    ["character", "database", "media", "stateFiles", "vault"],
    "Snapshot component index",
  );
  validateDatabaseDescriptor(value.components.database, files);
  validateFileSetDescriptor(value.components.media, "Media", "media", files);
  validateFileSetDescriptor(value.components.vault, "Vault", "vault", files);
  validateFileSetDescriptor(value.components.stateFiles, "State", "state", files);
  validateCharacterDescriptor(value.components.character, files);
}

function validateChunkFrame(value: unknown): asserts value is AgentSnapshotV2ChunkFrame {
  if (!isRecord(value)) {
    throw invalidSnapshot("Snapshot chunk frame is malformed");
  }
  assertExactKeys(
    value,
    ["bytesBase64", "chunkIndex", "fileIndex", "offset", "sha256", "size", "type"],
    "Snapshot chunk frame",
  );
  if (value.type !== "chunk") {
    throw invalidSnapshot("Snapshot chunk frame type is unsupported");
  }
  assertSafeInteger(value.chunkIndex, "Snapshot chunk index");
  assertSafeInteger(value.fileIndex, "Snapshot chunk file index");
  assertSafeInteger(value.offset, "Snapshot chunk offset");
  assertSafeInteger(value.size, "Snapshot chunk size", 1, AGENT_SNAPSHOT_V2_CHUNK_BYTES);
  assertDigest(value.sha256, "Snapshot chunk hash");
  if (typeof value.bytesBase64 !== "string" || !BASE64_PATTERN.test(value.bytesBase64)) {
    throw invalidSnapshot("Snapshot chunk bytes are not canonical base64");
  }
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (bytes.length !== value.size || bytes.toString("base64") !== value.bytesBase64) {
    throw invalidSnapshot("Snapshot chunk byte size is inconsistent");
  }
}

function validateTrailer(value: unknown): asserts value is AgentSnapshotV2Trailer {
  if (!isRecord(value)) {
    throw invalidSnapshot("Snapshot stream trailer is malformed");
  }
  assertExactKeys(
    value,
    ["aggregateSha256", "chunkCount", "descriptorSha256", "fileCount", "totalBytes", "type"],
    "Snapshot stream trailer",
  );
  if (value.type !== "trailer") {
    throw invalidSnapshot("Snapshot stream trailer type is unsupported");
  }
  assertDigest(value.aggregateSha256, "Snapshot aggregate hash");
  assertDigest(value.descriptorSha256, "Snapshot descriptor hash");
  assertSafeInteger(value.chunkCount, "Snapshot chunk count");
  assertSafeInteger(value.fileCount, "Snapshot file count", 0, AGENT_SNAPSHOT_V2_MAX_FILES);
  assertSafeInteger(value.totalBytes, "Snapshot byte total", 0, AGENT_SNAPSHOT_V2_MAX_TOTAL_BYTES);
}

function parseJsonLine(line: Buffer): unknown {
  if (line.length === 0 || line.includes(0x0d)) {
    throw invalidSnapshot("Snapshot stream line is not canonical");
  }
  const text = line.toString("utf8");
  try {
    return JSON.parse(text);
  } catch (cause) {
    // error-policy:J2 protocol parse errors retain the JSON failure as cause.
    throw invalidSnapshot("Snapshot stream line is not valid JSON", undefined, cause);
  }
}

function assertCanonicalLine(value: unknown, line: Buffer): void {
  if (agentSnapshotV2StableJson(value) !== line.toString("utf8")) {
    throw invalidSnapshot("Snapshot stream line is not canonical JSON");
  }
}

function assertContentType(contentType: string): void {
  if (contentType !== AGENT_SNAPSHOT_V2_CONTENT_TYPE) {
    throw invalidSnapshot("Snapshot stream content type is unsupported", {
      contentType,
    });
  }
}

/**
 * Observes arbitrary byte views and validates complete NDJSON frames as their
 * line delimiters arrive. Callers must invoke `finish` after the source ends;
 * it rejects unterminated lines, missing descriptors, and missing trailers.
 */
export class AgentSnapshotV2StreamValidator {
  readonly #expectedAgentId: string | undefined;
  readonly #lineBuffer = Buffer.allocUnsafe(AGENT_SNAPSHOT_V2_MAX_LINE_BYTES);
  #lineBytes = 0;
  #peakBufferedLineBytes = 0;
  #wireBytes = 0;
  #descriptor: AgentSnapshotV2Descriptor | null = null;
  #trailer: AgentSnapshotV2Trailer | null = null;
  #currentFileIndex = 0;
  #currentFileOffset = 0;
  #currentChunkIndex = 0;
  #currentFileHash: Hash = createHash("sha256");
  readonly #aggregateHash: Hash = createHash("sha256");
  #chunkCount = 0;
  #totalBytes = 0;
  #summary: AgentSnapshotV2ValidationSummary | null = null;

  constructor(options: AgentSnapshotV2ValidatorOptions) {
    assertContentType(options.contentType);
    if (options.expectedAgentId !== undefined && options.expectedAgentId.trim().length === 0) {
      throw invalidSnapshot("Expected snapshot agent id is empty");
    }
    this.#expectedAgentId = options.expectedAgentId;
  }

  get bufferedLineBytes(): number {
    return this.#lineBytes;
  }

  get peakBufferedLineBytes(): number {
    return this.#peakBufferedLineBytes;
  }

  get summary(): AgentSnapshotV2ValidationSummary | null {
    return this.#summary;
  }

  push(input: Uint8Array): void {
    if (!(input instanceof Uint8Array)) {
      throw invalidSnapshot("Snapshot stream emitted a non-Uint8Array value");
    }
    if (this.#summary) {
      throw invalidSnapshot("Snapshot validator is already complete");
    }
    this.#wireBytes += input.byteLength;
    if (!Number.isSafeInteger(this.#wireBytes)) {
      throw invalidSnapshot("Snapshot wire byte count exceeds safe bounds");
    }

    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    let cursor = 0;
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(0x0a, cursor);
      const end = newline === -1 ? bytes.length : newline;
      const segmentBytes = end - cursor;
      if (this.#lineBytes + segmentBytes > AGENT_SNAPSHOT_V2_MAX_LINE_BYTES) {
        throw invalidSnapshot("Snapshot stream line exceeds its byte budget");
      }
      bytes.copy(this.#lineBuffer, this.#lineBytes, cursor, end);
      this.#lineBytes += segmentBytes;
      this.#peakBufferedLineBytes = Math.max(this.#peakBufferedLineBytes, this.#lineBytes);
      if (newline === -1) {
        return;
      }
      this.#processLine(this.#lineBuffer.subarray(0, this.#lineBytes));
      this.#lineBytes = 0;
      cursor = newline + 1;
    }
  }

  finish(): AgentSnapshotV2ValidationSummary {
    if (this.#summary) {
      return this.#summary;
    }
    if (this.#lineBytes !== 0 || !this.#descriptor || !this.#trailer) {
      throw invalidSnapshot("Snapshot stream is truncated");
    }
    this.#summary = {
      descriptor: this.#descriptor,
      peakBufferedLineBytes: this.#peakBufferedLineBytes,
      trailer: this.#trailer,
      wireBytes: this.#wireBytes,
    };
    return this.#summary;
  }

  #advanceEmptyFiles(): void {
    if (!this.#descriptor) {
      return;
    }
    while (
      this.#currentFileIndex < this.#descriptor.files.length &&
      this.#descriptor.files[this.#currentFileIndex]?.size === 0
    ) {
      this.#finalizeCurrentFile();
    }
  }

  #finalizeCurrentFile(): void {
    if (!this.#descriptor) {
      throw invalidSnapshot("Snapshot descriptor is missing");
    }
    const file = this.#descriptor.files[this.#currentFileIndex];
    if (!file) {
      return;
    }
    if (this.#currentFileOffset !== file.size) {
      throw invalidSnapshot(`Snapshot file ${file.path} is truncated`);
    }
    if (this.#currentFileHash.digest("hex") !== file.sha256) {
      throw invalidSnapshot(`Snapshot file ${file.path} hash is inconsistent`);
    }
    this.#currentFileIndex += 1;
    this.#currentFileOffset = 0;
    this.#currentChunkIndex = 0;
    this.#currentFileHash = createHash("sha256");
  }

  #processLine(line: Buffer): void {
    if (this.#trailer) {
      throw invalidSnapshot("Snapshot stream contains frames after its trailer");
    }
    const parsed = parseJsonLine(line);
    if (!this.#descriptor) {
      validateDescriptor(parsed);
      const descriptor = parsed;
      assertCanonicalLine(descriptor, line);
      if (this.#expectedAgentId !== undefined && descriptor.agentId !== this.#expectedAgentId) {
        throw invalidSnapshot("Snapshot descriptor does not match the expected agent", {
          actualAgentId: descriptor.agentId,
          expectedAgentId: this.#expectedAgentId,
        });
      }
      this.#descriptor = descriptor;
      this.#advanceEmptyFiles();
      return;
    }

    if (isRecord(parsed) && parsed.type === "chunk") {
      validateChunkFrame(parsed);
      const chunk = parsed;
      assertCanonicalLine(chunk, line);
      this.#advanceEmptyFiles();
      const file = this.#descriptor.files[this.#currentFileIndex];
      if (!file) {
        throw invalidSnapshot("Snapshot stream contains an extra chunk");
      }
      const expectedSize = Math.min(
        this.#descriptor.chunkSize,
        file.size - this.#currentFileOffset,
      );
      if (
        chunk.fileIndex !== file.index ||
        chunk.chunkIndex !== this.#currentChunkIndex ||
        chunk.offset !== this.#currentFileOffset ||
        chunk.size !== expectedSize
      ) {
        throw invalidSnapshot("Snapshot chunks are duplicated, reordered, or non-canonical");
      }
      const decoded = Buffer.from(chunk.bytesBase64, "base64");
      if (agentSnapshotV2Sha256(decoded) !== chunk.sha256) {
        throw invalidSnapshot("Snapshot chunk hash mismatch");
      }
      this.#currentFileHash.update(decoded);
      this.#aggregateHash.update(decoded);
      this.#currentFileOffset += decoded.length;
      this.#currentChunkIndex += 1;
      this.#chunkCount += 1;
      this.#totalBytes += decoded.length;
      if (
        !Number.isSafeInteger(this.#totalBytes) ||
        this.#totalBytes > AGENT_SNAPSHOT_V2_MAX_TOTAL_BYTES
      ) {
        throw invalidSnapshot("Snapshot stream exceeds its byte budget");
      }
      if (this.#currentFileOffset === file.size) {
        this.#finalizeCurrentFile();
        this.#advanceEmptyFiles();
      }
      return;
    }

    validateTrailer(parsed);
    const trailer = parsed;
    assertCanonicalLine(trailer, line);
    this.#advanceEmptyFiles();
    if (this.#currentFileIndex !== this.#descriptor.files.length) {
      throw invalidSnapshot("Snapshot stream is truncated before its trailer");
    }
    const aggregateSha256 = this.#aggregateHash.digest("hex");
    const descriptorSha256 = agentSnapshotV2Sha256(agentSnapshotV2StableJson(this.#descriptor));
    if (
      trailer.aggregateSha256 !== aggregateSha256 ||
      trailer.descriptorSha256 !== descriptorSha256 ||
      trailer.chunkCount !== this.#chunkCount ||
      trailer.fileCount !== this.#descriptor.files.length ||
      trailer.totalBytes !== this.#totalBytes
    ) {
      throw invalidSnapshot("Snapshot stream trailer is inconsistent");
    }
    this.#trailer = trailer;
  }
}

/**
 * Validates and forwards the exact source bytes in views compatible with the
 * encrypted backup chunk writer. A validation failure is thrown through the
 * iterator so the writer's staging cleanup boundary removes partial objects.
 */
export async function* observeAgentSnapshotV2Stream(params: {
  source: AsyncIterable<Uint8Array>;
  validator: AgentSnapshotV2StreamValidator;
}): AsyncGenerator<Uint8Array, AgentSnapshotV2ValidationSummary> {
  for await (const input of params.source) {
    if (!(input instanceof Uint8Array)) {
      throw invalidSnapshot("Snapshot stream emitted a non-Uint8Array value");
    }
    for (let offset = 0; offset < input.byteLength; offset += AGENT_SNAPSHOT_V2_REPACK_VIEW_BYTES) {
      const view = input.subarray(
        offset,
        Math.min(input.byteLength, offset + AGENT_SNAPSHOT_V2_REPACK_VIEW_BYTES),
      );
      params.validator.push(view);
      yield view;
    }
  }
  return params.validator.finish();
}

export async function validateAgentSnapshotV2Stream(params: {
  source: AsyncIterable<Uint8Array>;
  options: AgentSnapshotV2ValidatorOptions;
}): Promise<AgentSnapshotV2ValidationSummary> {
  const validator = new AgentSnapshotV2StreamValidator(params.options);
  for await (const input of params.source) {
    validator.push(input);
  }
  return validator.finish();
}
