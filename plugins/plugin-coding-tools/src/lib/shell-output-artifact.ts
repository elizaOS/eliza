/**
 * Persists owner-scoped foreground shell streams as restart-safe immutable
 * segments and resolves bounded pages without exposing state-root paths.
 */
import {
  createHash,
  createHmac,
  type Hash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, resolveStateDir, toWellFormedUnicode } from "@elizaos/core";
import { resolveShellJobTtlMs } from "../shell/utils/config.js";

const ARTIFACT_ROOT_SEGMENTS = ["coding-tools", "shell-output"] as const;
const ARTIFACT_PREFIX = "shell_";
const ARTIFACT_KEY_FILE = ".artifact-key";
const SEGMENT_MAX_BYTES = 16 * 1024;
const ARTIFACT_PAGE_DEFAULT_CHARS = 12_000;
const ARTIFACT_PAGE_MAX_CHARS = 20_000;
const ARTIFACT_HANDLE_PATTERN =
  /^shell_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PENDING_DIRECTORY_PATTERN =
  /^\.pending-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEGMENT_FILE_PATTERN = /^(stdout|stderr)-\d{6}\.seg$/;

export interface ShellStreamMetrics {
  characters: number;
  bytes: number;
  lines: number;
}

export interface ShellOutputArtifact {
  handle: string;
  createdAt: string;
  expiresAt: string;
  retentionMs: number;
  contentRevision: string;
  stdout: ShellStreamMetrics;
  stderr: ShellStreamMetrics;
  source: {
    stdout: ShellStreamMetrics;
    stderr: ShellStreamMetrics;
    loss: false;
  };
}

export interface PersistShellOutputArtifactOptions {
  /** @deprecated Excluded from the private artifact manifest. */
  command?: string;
  /** @deprecated Excluded from the private artifact manifest. */
  cwd?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  modelCharacterLimit: number;
  modelCharacters: number;
  ownerAgentId: string;
  ownerConversationId: string;
  sourceStdout?: ShellStreamMetrics;
  sourceStderr?: ShellStreamMetrics;
}

export type BeginShellOutputArtifactOptions = Omit<
  PersistShellOutputArtifactOptions,
  "stdout" | "stderr" | "modelCharacters"
>;

export type ShellOutputArtifactStream = "stdout" | "stderr";

export interface ShellOutputArtifactPage {
  handle: string;
  stream: ShellOutputArtifactStream;
  text: string;
  startOffset: number;
  endOffset: number;
  nextOffset: number;
  totalCharacters: number;
  complete: boolean;
  createdAt: string;
  expiresAt: string;
  contentRevision?: string;
  sourceBytesRead?: number;
  sourceSegmentsRead?: number;
}

export interface ShellOutputArtifactBytePage {
  handle: string;
  stream: ShellOutputArtifactStream;
  bytes: Buffer;
  startOffset: number;
  endOffset: number;
  nextOffset: number;
  totalBytes: number;
  complete: boolean;
  createdAt: string;
  expiresAt: string;
  contentRevision: string;
  sourceBytesRead: number;
  sourceSegmentsRead: number;
}

export type ShellOutputArtifactReadResult =
  | { ok: true; value: ShellOutputArtifactPage }
  | {
      ok: false;
      reason: "invalid_handle" | "unavailable" | "expired" | "corrupt";
      message: string;
    };

export type ShellOutputArtifactByteReadResult =
  | { ok: true; value: ShellOutputArtifactBytePage }
  | {
      ok: false;
      reason: "invalid_handle" | "unavailable" | "expired" | "corrupt";
      message: string;
    };

interface PersistedShellOutputManifestV1 {
  version: 1;
  handle: string;
  createdAt: string;
  expiresAt: string;
  owner: { agentId: string; conversationId: string };
}

interface ShellOutputSegmentDescriptor {
  file: string;
  startCharacter: number;
  endCharacter: number;
  bytes: number;
  sha256: string;
}

interface ShellOutputStreamDescriptor extends ShellStreamMetrics {
  sha256: string;
  segments: ShellOutputSegmentDescriptor[];
}

interface UnsignedShellOutputManifestV2 {
  version: 2;
  handle: string;
  createdAt: string;
  expiresAt: string;
  leaseRevision: number;
  owner: { agentId: string; conversationId: string };
  contentRevision: string;
  stdout: ShellOutputStreamDescriptor;
  stderr: ShellOutputStreamDescriptor;
  outcome: {
    exitCode: number;
    timedOut: boolean;
    signal: NodeJS.Signals | null;
  };
  projection: { modelCharacterLimit: number; modelCharacters: number };
  source: {
    stdout: ShellStreamMetrics;
    stderr: ShellStreamMetrics;
    loss: false;
  };
}

interface PersistedShellOutputManifestV2 extends UnsignedShellOutputManifestV2 {
  mac: string;
}

interface ShellOutputByteSegmentDescriptor {
  file: string;
  startByte: number;
  endByte: number;
  bytes: number;
  sha256: string;
}

interface UnsignedShellOutputManifestV3 {
  version: 3;
  encoding: "native-bytes";
  handle: string;
  createdAt: string;
  expiresAt: string;
  leaseRevision: number;
  owner: { agentId: string; conversationId: string };
  contentRevision: string;
  stream: ShellOutputArtifactStream;
  byteLength: number;
  segments: ShellOutputByteSegmentDescriptor[];
  outcome: {
    exitCode: number;
    timedOut: boolean;
    signal: NodeJS.Signals | null;
  };
}

interface PersistedShellOutputManifestV3 extends UnsignedShellOutputManifestV3 {
  mac: string;
}

export interface PersistShellOutputByteArtifactOptions {
  chunks: AsyncIterable<Uint8Array>;
  stream?: ShellOutputArtifactStream;
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  ownerAgentId: string;
  ownerConversationId: string;
}

export interface RenewShellOutputArtifactLeaseOptions {
  handle: string;
  requesterAgentId: string;
  requesterConversationId: string;
}

export interface RenewedShellOutputArtifactLease {
  handle: string;
  expiresAt: string;
  leaseRevision: number;
}

export interface ShellOutputByteArtifact {
  handle: string;
  stream: ShellOutputArtifactStream;
  byteLength: number;
  createdAt: string;
  expiresAt: string;
  retentionMs: number;
  contentRevision: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function ensureArtifactRoot(): Promise<string> {
  const root = path.join(resolveStateDir(), ...ARTIFACT_ROOT_SEGMENTS);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("shell-output artifact root is not a private directory");
  }
  await fs.chmod(root, 0o700);
  return root;
}

async function artifactMacKey(root: string): Promise<Buffer> {
  const keyPath = path.join(root, ARTIFACT_KEY_FILE);
  try {
    return await readRegularFile(keyPath, 32);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const candidate = randomBytes(32);
  try {
    await fs.writeFile(keyPath, candidate, { flag: "wx", mode: 0o600 });
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readRegularFile(keyPath, 32);
  }
}

function manifestMac(
  manifest: UnsignedShellOutputManifestV2 | UnsignedShellOutputManifestV3,
  key: Uint8Array,
): string {
  return createHmac("sha256", key)
    .update(JSON.stringify(manifest))
    .digest("hex");
}

function utf8SegmentEnd(bytes: Buffer): number {
  let end = Math.min(bytes.byteLength, SEGMENT_MAX_BYTES);
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  return end === 0 ? Math.min(bytes.byteLength, SEGMENT_MAX_BYTES) : end;
}

class ShellOutputStreamWriter {
  private readonly descriptors: ShellOutputSegmentDescriptor[] = [];
  private readonly hasher: Hash = createHash("sha256");
  private pending = Buffer.alloc(0);
  private metrics: ShellStreamMetrics = { characters: 0, bytes: 0, lines: 0 };
  private endedWithNewline = false;
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly stream: ShellOutputArtifactStream,
  ) {}

  async write(text: string): Promise<void> {
    if (this.closed) throw new Error("shell-output stream is already closed");
    if (toWellFormedUnicode(text) !== text)
      throw new Error("shell-output artifact contains malformed Unicode");
    if (text.length === 0) return;
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    if (this.pending.byteLength > 0) {
      const previousBytes = this.pending.byteLength;
      const take = Math.min(
        bytes.byteLength,
        SEGMENT_MAX_BYTES - previousBytes + 3,
      );
      const combined = Buffer.concat(
        [this.pending, bytes.subarray(0, take)],
        previousBytes + take,
      );
      if (combined.byteLength >= SEGMENT_MAX_BYTES) {
        const end = utf8SegmentEnd(combined);
        await this.flush(combined.subarray(0, end));
        offset = end - previousBytes;
        this.pending = Buffer.alloc(0);
      } else {
        this.pending = combined;
        return;
      }
    }
    while (bytes.byteLength - offset >= SEGMENT_MAX_BYTES) {
      const candidate = bytes.subarray(
        offset,
        Math.min(bytes.byteLength, offset + SEGMENT_MAX_BYTES + 3),
      );
      const end = utf8SegmentEnd(candidate);
      await this.flush(candidate.subarray(0, end));
      offset += end;
    }
    if (offset < bytes.byteLength) {
      this.pending = Buffer.from(bytes.subarray(offset));
    }
  }

  async finish(): Promise<ShellOutputStreamDescriptor> {
    if (this.closed) throw new Error("shell-output stream is already closed");
    this.closed = true;
    if (this.pending.byteLength > 0) await this.flush(this.pending);
    this.pending = Buffer.alloc(0);
    return {
      ...this.metrics,
      sha256: this.hasher.digest("hex"),
      segments: this.descriptors,
    };
  }

  private async flush(bytes: Buffer): Promise<void> {
    const text = bytes.toString("utf8");
    if (toWellFormedUnicode(text) !== text)
      throw new Error("shell-output segment contains malformed Unicode");
    const index = this.descriptors.length;
    const file = `${this.stream}-${String(index).padStart(6, "0")}.seg`;
    await fs.writeFile(path.join(this.directory, file), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    const startCharacter = this.metrics.characters;
    const newlines = text.match(/\n/g)?.length ?? 0;
    this.metrics.characters += text.length;
    this.metrics.bytes += bytes.byteLength;
    if (startCharacter === 0) {
      this.metrics.lines = newlines + (text.endsWith("\n") ? 0 : 1);
    } else {
      this.metrics.lines += newlines;
      if (this.endedWithNewline && !text.endsWith("\n"))
        this.metrics.lines += 1;
    }
    this.endedWithNewline = text.endsWith("\n");
    this.hasher.update(bytes);
    this.descriptors.push({
      file,
      startCharacter,
      endCharacter: this.metrics.characters,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
}

function parseManifestV2(value: unknown): PersistedShellOutputManifestV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact manifest is not an object");
  }
  const manifest = value as PersistedShellOutputManifestV2;
  if (
    manifest.version !== 2 ||
    typeof manifest.handle !== "string" ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.expiresAt !== "string" ||
    !Number.isSafeInteger(manifest.leaseRevision) ||
    manifest.leaseRevision < 1 ||
    !manifest.owner ||
    typeof manifest.owner.agentId !== "string" ||
    typeof manifest.owner.conversationId !== "string" ||
    typeof manifest.contentRevision !== "string" ||
    typeof manifest.mac !== "string" ||
    !manifest.stdout ||
    !manifest.stderr
  ) {
    throw new Error("artifact manifest fields are invalid");
  }
  return manifest;
}

function unsignedManifest(
  manifest: PersistedShellOutputManifestV2,
): UnsignedShellOutputManifestV2 {
  const { mac: _mac, ...unsigned } = manifest;
  return unsigned;
}

function verifyManifestMac(
  manifest: PersistedShellOutputManifestV2,
  key: Uint8Array,
): void {
  const expected = Buffer.from(
    manifestMac(unsignedManifest(manifest), key),
    "hex",
  );
  const actual = Buffer.from(manifest.mac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("artifact manifest authentication failed");
  }
}

function parseManifestV3(value: unknown): PersistedShellOutputManifestV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact manifest is not an object");
  }
  const manifest = value as PersistedShellOutputManifestV3;
  if (
    manifest.version !== 3 ||
    manifest.encoding !== "native-bytes" ||
    typeof manifest.handle !== "string" ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.expiresAt !== "string" ||
    !Number.isSafeInteger(manifest.leaseRevision) ||
    manifest.leaseRevision < 1 ||
    !manifest.owner ||
    typeof manifest.owner.agentId !== "string" ||
    typeof manifest.owner.conversationId !== "string" ||
    typeof manifest.contentRevision !== "string" ||
    typeof manifest.mac !== "string" ||
    (manifest.stream !== "stdout" && manifest.stream !== "stderr") ||
    !Number.isSafeInteger(manifest.byteLength) ||
    manifest.byteLength < 0 ||
    !Array.isArray(manifest.segments) ||
    !manifest.outcome ||
    !Number.isSafeInteger(manifest.outcome.exitCode) ||
    typeof manifest.outcome.timedOut !== "boolean"
  ) {
    throw new Error("byte artifact manifest fields are invalid");
  }
  let offset = 0;
  for (const segment of manifest.segments) {
    if (
      !SEGMENT_FILE_PATTERN.test(segment.file) ||
      segment.startByte !== offset ||
      !Number.isSafeInteger(segment.endByte) ||
      segment.endByte <= segment.startByte ||
      segment.bytes !== segment.endByte - segment.startByte ||
      segment.bytes > SEGMENT_MAX_BYTES ||
      !/^[0-9a-f]{64}$/.test(segment.sha256)
    ) {
      throw new Error("byte artifact segment descriptor is invalid");
    }
    offset = segment.endByte;
  }
  if (offset !== manifest.byteLength) {
    throw new Error("byte artifact stream descriptor is incomplete");
  }
  return manifest;
}

function unsignedManifestV3(
  manifest: PersistedShellOutputManifestV3,
): UnsignedShellOutputManifestV3 {
  const { mac: _mac, ...unsigned } = manifest;
  return unsigned;
}

function verifyManifestV3Mac(
  manifest: PersistedShellOutputManifestV3,
  key: Uint8Array,
): void {
  const expected = Buffer.from(
    manifestMac(unsignedManifestV3(manifest), key),
    "hex",
  );
  const actual = Buffer.from(manifest.mac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("artifact manifest authentication failed");
  }
}

function validateSegments(descriptor: ShellOutputStreamDescriptor): void {
  if (
    !Number.isSafeInteger(descriptor.characters) ||
    descriptor.characters < 0 ||
    !Number.isSafeInteger(descriptor.bytes) ||
    descriptor.bytes < 0 ||
    !Array.isArray(descriptor.segments)
  )
    throw new Error("artifact stream descriptor is invalid");
  let characterOffset = 0;
  let byteCount = 0;
  for (const segment of descriptor.segments) {
    if (
      !SEGMENT_FILE_PATTERN.test(segment.file) ||
      segment.startCharacter !== characterOffset ||
      !Number.isSafeInteger(segment.endCharacter) ||
      segment.endCharacter <= segment.startCharacter ||
      !Number.isSafeInteger(segment.bytes) ||
      segment.bytes <= 0 ||
      segment.bytes > SEGMENT_MAX_BYTES ||
      !/^[0-9a-f]{64}$/.test(segment.sha256)
    )
      throw new Error("artifact segment descriptor is invalid");
    characterOffset = segment.endCharacter;
    byteCount += segment.bytes;
  }
  if (
    characterOffset !== descriptor.characters ||
    byteCount !== descriptor.bytes
  ) {
    throw new Error("artifact stream descriptor is incomplete");
  }
}

async function readRegularFile(
  filePath: string,
  expectedBytes?: number,
): Promise<Buffer> {
  const file = await fs.open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("artifact entry is not a private regular file");
    if (expectedBytes !== undefined && stat.size !== expectedBytes)
      throw new Error("artifact segment size changed");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function readLegacyUtf8(filePath: string): Promise<string> {
  return (await readRegularFile(filePath)).toString("utf8");
}

function normalizePageStart(text: string, requested: number): number {
  let start = Math.max(0, Math.min(text.length, Math.floor(requested)));
  if (
    start > 0 &&
    start < text.length &&
    text.charCodeAt(start) >= 0xdc00 &&
    text.charCodeAt(start) <= 0xdfff &&
    text.charCodeAt(start - 1) >= 0xd800 &&
    text.charCodeAt(start - 1) <= 0xdbff
  )
    start -= 1;
  return start;
}

function normalizePageEnd(text: string, start: number, limit: number): number {
  let end = Math.min(text.length, start + limit);
  if (
    end > start &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    end -= 1;
  if (end === start && start < text.length)
    end = Math.min(text.length, start + 2);
  return end;
}

async function readV2Page(
  directory: string,
  manifest: PersistedShellOutputManifestV2,
  stream: ShellOutputArtifactStream,
  requestedOffset: number,
  limit: number,
): Promise<ShellOutputArtifactPage> {
  const descriptor = manifest[stream];
  validateSegments(descriptor);
  const clampedOffset = Math.max(
    0,
    Math.min(descriptor.characters, Math.floor(requestedOffset)),
  );
  if (clampedOffset === descriptor.characters) {
    return {
      handle: manifest.handle,
      stream,
      text: "",
      startOffset: clampedOffset,
      endOffset: clampedOffset,
      nextOffset: clampedOffset,
      totalCharacters: descriptor.characters,
      complete: true,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
      contentRevision: manifest.contentRevision,
      sourceBytesRead: 0,
      sourceSegmentsRead: 0,
    };
  }
  const startIndex = descriptor.segments.findIndex(
    (segment) => segment.endCharacter > clampedOffset,
  );
  if (startIndex < 0) throw new Error("artifact offset has no segment");
  const first = descriptor.segments[startIndex];
  if (!first) throw new Error("artifact segment is missing");
  const relativeRequested = clampedOffset - first.startCharacter;
  const selected: string[] = [];
  let bytesRead = 0;
  let segmentCount = 0;
  let availableCharacters = 0;
  for (let index = startIndex; index < descriptor.segments.length; index += 1) {
    const segment = descriptor.segments[index];
    if (!segment) break;
    const bytes = await readRegularFile(
      path.join(directory, segment.file),
      segment.bytes,
    );
    if (sha256(bytes) !== segment.sha256)
      throw new Error("artifact segment hash mismatch");
    const decoded = bytes.toString("utf8");
    if (toWellFormedUnicode(decoded) !== decoded)
      throw new Error("artifact segment contains malformed Unicode");
    selected.push(decoded);
    bytesRead += bytes.byteLength;
    segmentCount += 1;
    availableCharacters += decoded.length;
    if (availableCharacters - relativeRequested >= limit + 1) break;
  }
  const joined = selected.join("");
  const relativeStart = normalizePageStart(joined, relativeRequested);
  const relativeEnd = normalizePageEnd(joined, relativeStart, limit);
  const startOffset = first.startCharacter + relativeStart;
  const endOffset = first.startCharacter + relativeEnd;
  return {
    handle: manifest.handle,
    stream,
    text: joined.slice(relativeStart, relativeEnd),
    startOffset,
    endOffset,
    nextOffset: endOffset,
    totalCharacters: descriptor.characters,
    complete: endOffset >= descriptor.characters,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    contentRevision: manifest.contentRevision,
    sourceBytesRead: bytesRead,
    sourceSegmentsRead: segmentCount,
  };
}

async function sweepExpiredArtifacts(
  root: string,
  nowMs: number,
  key: Uint8Array,
): Promise<void> {
  try {
    const entries = await fs.readdir(root, {
      encoding: "utf8",
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(root, entry.name);
      try {
        if (PENDING_DIRECTORY_PATTERN.test(entry.name) && entry.isDirectory()) {
          const stat = await fs.lstat(entryPath);
          if (stat.mtimeMs < nowMs - resolveShellJobTtlMs())
            await fs.rm(entryPath, { recursive: true });
          continue;
        }
        if (!ARTIFACT_HANDLE_PATTERN.test(entry.name) || !entry.isDirectory())
          continue;
        const parsed: unknown = JSON.parse(
          await readLegacyUtf8(path.join(entryPath, "manifest.json")),
        );
        if ((parsed as { version?: unknown }).version === 2) {
          verifyManifestMac(parseManifestV2(parsed), key);
        } else if ((parsed as { version?: unknown }).version === 3) {
          verifyManifestV3Mac(parseManifestV3(parsed), key);
        }
        const expiry = parsed as { expiresAt?: unknown };
        if (
          typeof expiry.expiresAt === "string" &&
          Number.isFinite(Date.parse(expiry.expiresAt)) &&
          Date.parse(expiry.expiresAt) <= nowMs
        )
          await fs.rm(entryPath, { recursive: true });
      } catch (error) {
        // error-policy:J6 cleanup is restricted to one validated artifact directory.
        logger.warn(
          { artifactHandle: entry.name, error },
          "[CodingTools] Failed to expire shell-output artifact",
        );
      }
    }
  } catch (error) {
    // error-policy:J6 best-effort expiry does not invalidate new publication.
    logger.warn(
      { error },
      "[CodingTools] Failed to inspect shell-output artifacts",
    );
  }
}

/** Incrementally publishes already-redacted streams behind one atomic handle. */
export class ShellOutputArtifactWriter {
  private constructor(
    private readonly options: BeginShellOutputArtifactOptions,
    private readonly retentionMs: number,
    private readonly createdAtMs: number,
    private readonly key: Buffer,
    private readonly handle: string,
    private readonly pendingDirectory: string,
    private readonly artifactDirectory: string,
    private readonly streams: Record<
      ShellOutputArtifactStream,
      ShellOutputStreamWriter
    >,
  ) {}

  static async create(
    options: BeginShellOutputArtifactOptions,
  ): Promise<ShellOutputArtifactWriter> {
    const retentionMs = resolveShellJobTtlMs();
    const createdAtMs = Date.now();
    const root = await ensureArtifactRoot();
    const key = await artifactMacKey(root);
    await sweepExpiredArtifacts(root, createdAtMs, key);
    const handle = `${ARTIFACT_PREFIX}${randomUUID()}`;
    const pendingDirectory = path.join(root, `.pending-${randomUUID()}`);
    const artifactDirectory = path.join(root, handle);
    await fs.mkdir(pendingDirectory, { mode: 0o700 });
    return new ShellOutputArtifactWriter(
      options,
      retentionMs,
      createdAtMs,
      key,
      handle,
      pendingDirectory,
      artifactDirectory,
      {
        stdout: new ShellOutputStreamWriter(pendingDirectory, "stdout"),
        stderr: new ShellOutputStreamWriter(pendingDirectory, "stderr"),
      },
    );
  }

  write(stream: ShellOutputArtifactStream, text: string): Promise<void> {
    return this.streams[stream].write(text);
  }

  async finalize(modelCharacters: number): Promise<ShellOutputArtifact> {
    try {
      const [stdout, stderr] = await Promise.all([
        this.streams.stdout.finish(),
        this.streams.stderr.finish(),
      ]);
      const createdAt = new Date(this.createdAtMs).toISOString();
      const expiresAt = new Date(
        this.createdAtMs + this.retentionMs,
      ).toISOString();
      const contentRevision = `sha256:${sha256(`${stdout.sha256}:${stderr.sha256}`)}`;
      const unsigned: UnsignedShellOutputManifestV2 = {
        version: 2,
        handle: this.handle,
        createdAt,
        expiresAt,
        leaseRevision: 1,
        owner: {
          agentId: this.options.ownerAgentId,
          conversationId: this.options.ownerConversationId,
        },
        contentRevision,
        stdout,
        stderr,
        outcome: {
          exitCode: this.options.exitCode,
          timedOut: this.options.timedOut,
          signal: this.options.signal,
        },
        projection: {
          modelCharacterLimit: this.options.modelCharacterLimit,
          modelCharacters,
        },
        source: {
          stdout: this.options.sourceStdout ?? stdout,
          stderr: this.options.sourceStderr ?? stderr,
          loss: false,
        },
      };
      const manifest: PersistedShellOutputManifestV2 = {
        ...unsigned,
        mac: manifestMac(unsigned, this.key),
      };
      await fs.writeFile(
        path.join(this.pendingDirectory, "manifest.json"),
        `${JSON.stringify(manifest)}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
      await fs.rename(this.pendingDirectory, this.artifactDirectory);
      return {
        handle: this.handle,
        createdAt,
        expiresAt,
        retentionMs: this.retentionMs,
        contentRevision,
        stdout,
        stderr,
        source: manifest.source,
      };
    } catch (error) {
      // error-policy:J6 the unpublished opaque handle was never returned.
      await this.abort();
      throw error;
    }
  }

  async abort(): Promise<void> {
    await fs.rm(this.pendingDirectory, { recursive: true, force: true });
  }
}

/** Persist one complete, already-redacted foreground shell result. */
export async function persistShellOutputArtifact(
  options: PersistShellOutputArtifactOptions,
): Promise<ShellOutputArtifact> {
  const writer = await ShellOutputArtifactWriter.create(options);
  try {
    await Promise.all([
      writer.write("stdout", options.stdout),
      writer.write("stderr", options.stderr),
    ]);
    return await writer.finalize(options.modelCharacters);
  } catch (error) {
    // error-policy:J6 the unpublished opaque handle was never returned.
    await writer.abort();
    throw error;
  }
}

/**
 * Publish one native-byte tool stream in the canonical private shell-artifact
 * store. This format is intentionally not exposed through the text page API;
 * callers must use the byte-coordinate reader below.
 */
export async function persistShellOutputByteArtifact(
  options: PersistShellOutputByteArtifactOptions,
): Promise<ShellOutputByteArtifact> {
  const retentionMs = resolveShellJobTtlMs();
  const createdAtMs = Date.now();
  const root = await ensureArtifactRoot();
  const key = await artifactMacKey(root);
  await sweepExpiredArtifacts(root, createdAtMs, key);
  const handle = `${ARTIFACT_PREFIX}${randomUUID()}`;
  const pendingDirectory = path.join(root, `.pending-${randomUUID()}`);
  const artifactDirectory = path.join(root, handle);
  const stream = options.stream ?? "stdout";
  const digest = createHash("sha256");
  const segments: ShellOutputByteSegmentDescriptor[] = [];
  let byteLength = 0;
  await fs.mkdir(pendingDirectory, { mode: 0o700 });
  try {
    for await (const value of options.chunks) {
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(
          "shell-output byte chunks must be Uint8Array values",
        );
      }
      const chunk = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      for (let offset = 0; offset < chunk.byteLength; ) {
        const bytes = chunk.subarray(
          offset,
          Math.min(offset + SEGMENT_MAX_BYTES, chunk.byteLength),
        );
        const index = segments.length;
        const file = `${stream}-${String(index).padStart(6, "0")}.seg`;
        await fs.writeFile(path.join(pendingDirectory, file), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        const startByte = byteLength;
        byteLength += bytes.byteLength;
        digest.update(bytes);
        segments.push({
          file,
          startByte,
          endByte: byteLength,
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        });
        offset += bytes.byteLength;
      }
    }
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + retentionMs).toISOString();
    const contentRevision = `sha256:${digest.digest("hex")}`;
    const unsigned: UnsignedShellOutputManifestV3 = {
      version: 3,
      encoding: "native-bytes",
      handle,
      createdAt,
      expiresAt,
      leaseRevision: 1,
      owner: {
        agentId: options.ownerAgentId,
        conversationId: options.ownerConversationId,
      },
      contentRevision,
      stream,
      byteLength,
      segments,
      outcome: {
        exitCode: options.exitCode,
        timedOut: options.timedOut,
        signal: options.signal,
      },
    };
    const manifest: PersistedShellOutputManifestV3 = {
      ...unsigned,
      mac: manifestMac(unsigned, key),
    };
    await fs.writeFile(
      path.join(pendingDirectory, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await fs.rename(pendingDirectory, artifactDirectory);
    return {
      handle,
      stream,
      byteLength,
      createdAt,
      expiresAt,
      retentionMs,
      contentRevision,
    };
  } catch (error) {
    // error-policy:J6 the unpublished opaque handle was never returned.
    await fs.rm(pendingDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Extend an owner-authorized native-byte artifact lease without changing its content. */
export async function renewShellOutputArtifactLease(
  options: RenewShellOutputArtifactLeaseOptions,
): Promise<
  | { ok: true; value: RenewedShellOutputArtifactLease }
  | {
      ok: false;
      reason: "unavailable" | "expired" | "corrupt";
      message: string;
    }
> {
  const root = path.join(resolveStateDir(), ...ARTIFACT_ROOT_SEGMENTS);
  const artifactDirectory = path.join(root, options.handle);
  try {
    const [realRoot, realArtifactDirectory] = await Promise.all([
      fs.realpath(root),
      fs.realpath(artifactDirectory),
    ]);
    if (path.dirname(realArtifactDirectory) !== realRoot)
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    const manifestPath = path.join(realArtifactDirectory, "manifest.json");
    const parsed = JSON.parse(
      (await readRegularFile(manifestPath)).toString("utf8"),
    );
    if (parsed?.version !== 3) {
      return {
        ok: false,
        reason: "unavailable",
        message:
          "only native-byte shell-output artifacts support lease renewal",
      };
    }
    const manifest = parseManifestV3(parsed);
    verifyManifestV3Mac(manifest, await artifactMacKey(root));
    if (
      manifest.handle !== options.handle ||
      manifest.owner.agentId !== options.requesterAgentId ||
      manifest.owner.conversationId !== options.requesterConversationId
    )
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    if (Date.parse(manifest.expiresAt) <= Date.now())
      return {
        ok: false,
        reason: "expired",
        message: "shell-output artifact has expired",
      };
    const renewed = {
      ...manifest,
      expiresAt: new Date(Date.now() + resolveShellJobTtlMs()).toISOString(),
      leaseRevision: manifest.leaseRevision + 1,
    };
    const { mac: _mac, ...unsigned } = renewed;
    const next = {
      ...renewed,
      mac: manifestMac(unsigned, await artifactMacKey(root)),
    };
    const temporary = path.join(
      realArtifactDirectory,
      `.manifest-renew-${process.pid}-${randomUUID()}.tmp`,
    );
    await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, manifestPath);
    return {
      ok: true,
      value: {
        handle: next.handle,
        expiresAt: next.expiresAt,
        leaseRevision: next.leaseRevision,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    logger.warn(
      { handle: options.handle, error },
      "[CodingTools] Failed to renew shell-output artifact lease",
    );
    return {
      ok: false,
      reason: "corrupt",
      message: "shell-output artifact lease could not be renewed safely",
    };
  }
}

async function readByteSegments(input: {
  directory: string;
  segments: readonly ShellOutputByteSegmentDescriptor[];
  totalBytes: number;
  offset: number;
  limit: number;
}): Promise<{
  bytes: Buffer;
  startOffset: number;
  endOffset: number;
  sourceBytesRead: number;
  sourceSegmentsRead: number;
}> {
  const startOffset = Math.min(input.offset, input.totalBytes);
  if (startOffset === input.totalBytes) {
    return {
      bytes: Buffer.alloc(0),
      startOffset,
      endOffset: startOffset,
      sourceBytesRead: 0,
      sourceSegmentsRead: 0,
    };
  }
  const selected: Buffer[] = [];
  let selectedBytes = 0;
  let sourceBytesRead = 0;
  let sourceSegmentsRead = 0;
  const desiredEnd = Math.min(input.totalBytes, startOffset + input.limit);
  for (const segment of input.segments) {
    if (segment.endByte <= startOffset) continue;
    if (segment.startByte >= desiredEnd) break;
    const bytes = await readRegularFile(
      path.join(input.directory, segment.file),
      segment.bytes,
    );
    if (sha256(bytes) !== segment.sha256) {
      throw new Error("artifact segment hash mismatch");
    }
    const relativeStart = Math.max(0, startOffset - segment.startByte);
    const relativeEnd = Math.min(
      bytes.byteLength,
      desiredEnd - segment.startByte,
    );
    const slice = bytes.subarray(relativeStart, relativeEnd);
    selected.push(slice);
    selectedBytes += slice.byteLength;
    sourceBytesRead += bytes.byteLength;
    sourceSegmentsRead += 1;
  }
  return {
    bytes: Buffer.concat(selected, selectedBytes),
    startOffset,
    endOffset: startOffset + selectedBytes,
    sourceBytesRead,
    sourceSegmentsRead,
  };
}

/** Read at most 64 KiB from one owner-scoped shell artifact in byte coordinates. */
export async function readShellOutputArtifactBytePage(options: {
  handle: string;
  stream: ShellOutputArtifactStream;
  offset: number;
  limit: number;
  requesterAgentId: string;
  requesterConversationId: string;
}): Promise<ShellOutputArtifactByteReadResult> {
  if (!ARTIFACT_HANDLE_PATTERN.test(options.handle)) {
    return {
      ok: false,
      reason: "invalid_handle",
      message: "invalid shell-output artifact handle",
    };
  }
  if (
    !Number.isSafeInteger(options.offset) ||
    options.offset < 0 ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 64 * 1024
  ) {
    throw new TypeError("shell-output byte range is invalid");
  }
  const root = path.join(resolveStateDir(), ...ARTIFACT_ROOT_SEGMENTS);
  const artifactDirectory = path.join(root, options.handle);
  try {
    const [realRoot, realArtifactDirectory] = await Promise.all([
      fs.realpath(root),
      fs.realpath(artifactDirectory),
    ]);
    if (path.dirname(realArtifactDirectory) !== realRoot) {
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    }
    const parsed: unknown = JSON.parse(
      (
        await readRegularFile(path.join(realArtifactDirectory, "manifest.json"))
      ).toString("utf8"),
    );
    const version = (parsed as { version?: unknown }).version;
    let createdAt: string;
    let expiresAt: string;
    let contentRevision: string;
    let totalBytes: number;
    let segments: ShellOutputByteSegmentDescriptor[];
    if (version === 3) {
      const manifest = parseManifestV3(parsed);
      verifyManifestV3Mac(manifest, await artifactMacKey(root));
      if (
        manifest.handle !== options.handle ||
        manifest.stream !== options.stream ||
        manifest.owner.agentId !== options.requesterAgentId ||
        manifest.owner.conversationId !== options.requesterConversationId
      ) {
        return {
          ok: false,
          reason: "unavailable",
          message: "shell-output artifact is unavailable for this conversation",
        };
      }
      createdAt = manifest.createdAt;
      expiresAt = manifest.expiresAt;
      contentRevision = manifest.contentRevision;
      totalBytes = manifest.byteLength;
      segments = manifest.segments;
    } else if (version === 2) {
      const manifest = parseManifestV2(parsed);
      verifyManifestMac(manifest, await artifactMacKey(root));
      if (
        manifest.handle !== options.handle ||
        manifest.owner.agentId !== options.requesterAgentId ||
        manifest.owner.conversationId !== options.requesterConversationId
      ) {
        return {
          ok: false,
          reason: "unavailable",
          message: "shell-output artifact is unavailable for this conversation",
        };
      }
      const descriptor = manifest[options.stream];
      validateSegments(descriptor);
      let byteOffset = 0;
      segments = descriptor.segments.map((segment) => {
        const mapped = {
          file: segment.file,
          startByte: byteOffset,
          endByte: byteOffset + segment.bytes,
          bytes: segment.bytes,
          sha256: segment.sha256,
        };
        byteOffset = mapped.endByte;
        return mapped;
      });
      createdAt = manifest.createdAt;
      expiresAt = manifest.expiresAt;
      contentRevision = manifest.contentRevision;
      totalBytes = descriptor.bytes;
    } else {
      throw new Error("legacy artifact has no bounded byte ledger");
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error("artifact expiry is invalid");
    }
    if (expiresAtMs <= Date.now()) {
      return {
        ok: false,
        reason: "expired",
        message: "shell-output artifact has expired",
      };
    }
    const page = await readByteSegments({
      directory: realArtifactDirectory,
      segments,
      totalBytes,
      offset: options.offset,
      limit: options.limit,
    });
    return {
      ok: true,
      value: {
        handle: options.handle,
        stream: options.stream,
        ...page,
        nextOffset: page.endOffset,
        totalBytes,
        complete: page.endOffset >= totalBytes,
        createdAt,
        expiresAt,
        contentRevision,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    }
    logger.warn(
      { handle: options.handle, error },
      "[CodingTools] Failed to read shell-output artifact bytes",
    );
    return {
      ok: false,
      reason: "corrupt",
      message: "shell-output artifact bytes could not be read safely",
    };
  }
}

/** Delete one exact artifact only after validating its persisted owner binding. */
export async function deleteShellOutputArtifact(options: {
  handle: string;
  requesterAgentId: string;
  requesterConversationId: string;
}): Promise<boolean> {
  if (!ARTIFACT_HANDLE_PATTERN.test(options.handle)) return false;
  const root = path.join(resolveStateDir(), ...ARTIFACT_ROOT_SEGMENTS);
  const artifactDirectory = path.join(root, options.handle);
  try {
    const [realRoot, realArtifactDirectory] = await Promise.all([
      fs.realpath(root),
      fs.realpath(artifactDirectory),
    ]);
    const stat = await fs.lstat(artifactDirectory);
    if (
      path.dirname(realArtifactDirectory) !== realRoot ||
      !stat.isDirectory() ||
      stat.isSymbolicLink()
    ) {
      return false;
    }
    const parsed: unknown = JSON.parse(
      (
        await readRegularFile(path.join(realArtifactDirectory, "manifest.json"))
      ).toString("utf8"),
    );
    const version = (parsed as { version?: unknown }).version;
    let owner: { agentId: string; conversationId: string };
    if (version === 3) {
      const manifest = parseManifestV3(parsed);
      verifyManifestV3Mac(manifest, await artifactMacKey(root));
      owner = manifest.owner;
    } else if (version === 2) {
      const manifest = parseManifestV2(parsed);
      verifyManifestMac(manifest, await artifactMacKey(root));
      owner = manifest.owner;
    } else if (version === 1) {
      owner = (parsed as PersistedShellOutputManifestV1).owner;
    } else {
      return false;
    }
    if (
      owner.agentId !== options.requesterAgentId ||
      owner.conversationId !== options.requesterConversationId
    ) {
      return false;
    }
    await fs.rm(realArtifactDirectory, { recursive: true });
    return true;
  } catch (error) {
    // error-policy:J3 absence is the explicit already-deleted result.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Resolve one bounded artifact page after owner authorization and integrity checks. */
export async function readShellOutputArtifactPage(options: {
  handle: string;
  stream: ShellOutputArtifactStream;
  offset?: number;
  limit?: number;
  requesterAgentId: string;
  requesterConversationId: string;
}): Promise<ShellOutputArtifactReadResult> {
  if (!ARTIFACT_HANDLE_PATTERN.test(options.handle)) {
    return {
      ok: false,
      reason: "invalid_handle",
      message: "invalid shell-output artifact handle",
    };
  }
  const root = path.join(resolveStateDir(), ...ARTIFACT_ROOT_SEGMENTS);
  const artifactDirectory = path.join(root, options.handle);
  try {
    const [realRoot, realArtifactDirectory] = await Promise.all([
      fs.realpath(root),
      fs.realpath(artifactDirectory),
    ]);
    if (path.dirname(realArtifactDirectory) !== realRoot) {
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    }
    const parsed: unknown = JSON.parse(
      (
        await readRegularFile(path.join(realArtifactDirectory, "manifest.json"))
      ).toString("utf8"),
    );
    const requestedOffset =
      options.offset !== undefined && Number.isFinite(options.offset)
        ? options.offset
        : 0;
    const requestedLimit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? options.limit
        : ARTIFACT_PAGE_DEFAULT_CHARS;
    const limit = Math.max(
      2,
      Math.min(ARTIFACT_PAGE_MAX_CHARS, Math.floor(requestedLimit)),
    );
    if ((parsed as { version?: unknown }).version === 1) {
      const manifest = parsed as PersistedShellOutputManifestV1;
      if (
        manifest.handle !== options.handle ||
        manifest.owner?.agentId !== options.requesterAgentId ||
        manifest.owner?.conversationId !== options.requesterConversationId
      )
        return {
          ok: false,
          reason: "unavailable",
          message: "shell-output artifact is unavailable for this conversation",
        };
      const expiresAtMs = Date.parse(manifest.expiresAt);
      if (!Number.isFinite(expiresAtMs))
        throw new Error("artifact expiry is invalid");
      if (expiresAtMs <= Date.now())
        return {
          ok: false,
          reason: "expired",
          message: "shell-output artifact has expired",
        };
      const text = toWellFormedUnicode(
        await readLegacyUtf8(
          path.join(realArtifactDirectory, `${options.stream}.txt`),
        ),
      );
      const startOffset = normalizePageStart(text, requestedOffset);
      const endOffset = normalizePageEnd(text, startOffset, limit);
      return {
        ok: true,
        value: {
          handle: options.handle,
          stream: options.stream,
          text: text.slice(startOffset, endOffset),
          startOffset,
          endOffset,
          nextOffset: endOffset,
          totalCharacters: text.length,
          complete: endOffset >= text.length,
          createdAt: manifest.createdAt,
          expiresAt: manifest.expiresAt,
        },
      };
    }
    if ((parsed as { version?: unknown }).version === 3) {
      const manifest = parseManifestV3(parsed);
      verifyManifestV3Mac(manifest, await artifactMacKey(root));
      if (
        manifest.handle !== options.handle ||
        manifest.owner.agentId !== options.requesterAgentId ||
        manifest.owner.conversationId !== options.requesterConversationId
      ) {
        return {
          ok: false,
          reason: "unavailable",
          message: "shell-output artifact is unavailable for this conversation",
        };
      }
      return {
        ok: false,
        reason: "unavailable",
        message: "native-byte shell-output artifacts require byte paging",
      };
    }
    const manifest = parseManifestV2(parsed);
    verifyManifestMac(manifest, await artifactMacKey(root));
    if (
      manifest.handle !== options.handle ||
      manifest.owner.agentId !== options.requesterAgentId ||
      manifest.owner.conversationId !== options.requesterConversationId
    )
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    const expiresAtMs = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(expiresAtMs))
      throw new Error("artifact expiry is invalid");
    if (expiresAtMs <= Date.now())
      return {
        ok: false,
        reason: "expired",
        message: "shell-output artifact has expired",
      };
    return {
      ok: true,
      value: await readV2Page(
        realArtifactDirectory,
        manifest,
        options.stream,
        requestedOffset,
        limit,
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        ok: false,
        reason: "unavailable",
        message: "shell-output artifact is unavailable for this conversation",
      };
    }
    logger.warn(
      { handle: options.handle, error },
      "[CodingTools] Failed to read shell-output artifact",
    );
    return {
      ok: false,
      reason: "corrupt",
      message: "shell-output artifact could not be read safely",
    };
  }
}
