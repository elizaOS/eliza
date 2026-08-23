/**
 * Persists owner-scoped foreground shell streams as restart-safe immutable
 * segments and resolves bounded pages without exposing state-root paths.
 */
import {
  createHash,
  createHmac,
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
const SEGMENT_MAX_BYTES = 64 * 1024;
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
}

interface PersistShellOutputArtifactOptions {
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
}

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

export type ShellOutputArtifactReadResult =
  | { ok: true; value: ShellOutputArtifactPage }
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
  leaseRevision: 1;
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
}

interface PersistedShellOutputManifestV2 extends UnsignedShellOutputManifestV2 {
  mac: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function streamMetrics(text: string): ShellStreamMetrics {
  const newlineCount = text.match(/\n/g)?.length ?? 0;
  return {
    characters: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: text.length === 0 ? 0 : newlineCount + (text.endsWith("\n") ? 0 : 1),
  };
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
  manifest: UnsignedShellOutputManifestV2,
  key: Uint8Array,
): string {
  return createHmac("sha256", key)
    .update(JSON.stringify(manifest))
    .digest("hex");
}

function splitUtf8Segments(text: string): string[] {
  if (text.length === 0) return [];
  const segments: string[] = [];
  let pieces: string[] = [];
  let bytes = 0;
  for (const codePoint of text) {
    const width = Buffer.byteLength(codePoint, "utf8");
    if (bytes > 0 && bytes + width > SEGMENT_MAX_BYTES) {
      segments.push(pieces.join(""));
      pieces = [];
      bytes = 0;
    }
    pieces.push(codePoint);
    bytes += width;
  }
  if (pieces.length > 0) segments.push(pieces.join(""));
  return segments;
}

async function writeStreamSegments(
  directory: string,
  stream: ShellOutputArtifactStream,
  text: string,
): Promise<ShellOutputStreamDescriptor> {
  const descriptors: ShellOutputSegmentDescriptor[] = [];
  let characterOffset = 0;
  const hasher = createHash("sha256");
  const pieces = splitUtf8Segments(text);
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] ?? "";
    const bytes = Buffer.from(piece, "utf8");
    const file = `${stream}-${String(index).padStart(6, "0")}.seg`;
    await fs.writeFile(path.join(directory, file), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    hasher.update(bytes);
    descriptors.push({
      file,
      startCharacter: characterOffset,
      endCharacter: characterOffset + piece.length,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
    characterOffset += piece.length;
  }
  return {
    ...streamMetrics(text),
    sha256: hasher.digest("hex"),
    segments: descriptors,
  };
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
    manifest.leaseRevision !== 1 ||
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

/** Persist one complete, already-redacted foreground shell result. */
export async function persistShellOutputArtifact(
  options: PersistShellOutputArtifactOptions,
): Promise<ShellOutputArtifact> {
  if (
    toWellFormedUnicode(options.stdout) !== options.stdout ||
    toWellFormedUnicode(options.stderr) !== options.stderr
  )
    throw new Error("shell-output artifact contains malformed Unicode");
  const retentionMs = resolveShellJobTtlMs();
  const createdAtMs = Date.now();
  const root = await ensureArtifactRoot();
  const key = await artifactMacKey(root);
  await sweepExpiredArtifacts(root, createdAtMs, key);
  const handle = `${ARTIFACT_PREFIX}${randomUUID()}`;
  const pendingDirectory = path.join(root, `.pending-${randomUUID()}`);
  const artifactDirectory = path.join(root, handle);
  await fs.mkdir(pendingDirectory, { mode: 0o700 });
  try {
    const [stdout, stderr] = await Promise.all([
      writeStreamSegments(pendingDirectory, "stdout", options.stdout),
      writeStreamSegments(pendingDirectory, "stderr", options.stderr),
    ]);
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + retentionMs).toISOString();
    const contentRevision = `sha256:${sha256(`${stdout.sha256}:${stderr.sha256}`)}`;
    const unsigned: UnsignedShellOutputManifestV2 = {
      version: 2,
      handle,
      createdAt,
      expiresAt,
      leaseRevision: 1,
      owner: {
        agentId: options.ownerAgentId,
        conversationId: options.ownerConversationId,
      },
      contentRevision,
      stdout,
      stderr,
      outcome: {
        exitCode: options.exitCode,
        timedOut: options.timedOut,
        signal: options.signal,
      },
      projection: {
        modelCharacterLimit: options.modelCharacterLimit,
        modelCharacters: options.modelCharacters,
      },
    };
    const manifest: PersistedShellOutputManifestV2 = {
      ...unsigned,
      mac: manifestMac(unsigned, key),
    };
    await fs.writeFile(
      path.join(pendingDirectory, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    await fs.rename(pendingDirectory, artifactDirectory);
    return {
      handle,
      createdAt,
      expiresAt,
      retentionMs,
      contentRevision,
      stdout,
      stderr,
    };
  } catch (error) {
    // error-policy:J6 the unpublished opaque handle was never returned.
    await fs.rm(pendingDirectory, { recursive: true, force: true });
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
