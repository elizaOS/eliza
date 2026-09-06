/**
 * Persists Gmail bodies as immutable UTF-8 memory segments behind an atomic,
 * owner/account/message/room-bound manifest. Continuations resolve directly
 * from the opaque manifest id after restart and load only the source rows that
 * can contribute to one bounded page.
 */
import { createHash } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  type Memory,
  MemoryType,
  stringToUuid,
  type UUID,
} from "@elizaos/core/node";

export const GMAIL_CONTENT_HEAD_TABLE = "gmail_content_heads";
export const GMAIL_CONTENT_SEGMENT_TABLE = "gmail_content_segments";
export const GMAIL_CONTENT_SEGMENT_MAX_BYTES = 64 * 1024;
export const GMAIL_CONTENT_PAGE_MAX_SEGMENTS = 4;
export const GMAIL_CONTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const GMAIL_CONTENT_REFERENCE_PREFIX = "gmail-email-v2.";

interface UnitRange {
  start: number;
  end: number;
}

interface GmailSegmentDescriptor {
  id: UUID;
  position: number;
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
  lineStartBoundary: boolean;
  lineEndBoundary: boolean;
  fragmentStart: number;
  fragmentEnd: number;
  fragmentStartBoundary: boolean;
  fragmentEndBoundary: boolean;
  sha256: string;
}

export interface GmailContentManifest {
  schemaVersion: 1;
  ownerEntityId: UUID;
  roomId: UUID;
  accountId: string;
  messageId: string;
  providerRevision: string;
  publicRevision: string;
  sourceSha256: string;
  byteLength: number;
  lineCount: number;
  fragmentCount: number;
  publishedAt: number;
  expiresAt: number;
  segments: GmailSegmentDescriptor[];
}

export interface GmailContentAuthorization {
  ownerEntityId: UUID;
  roomId: UUID;
  accountId?: string;
}

export interface GmailContentPage {
  text: string;
  start: number;
  end: number;
  total: number;
  manifest: GmailContentManifest;
  reference: string;
  sourceWork: { headReads: number; segmentRows: number };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA_PATTERN = /^[0-9a-f]{64}$/u;

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactLines(text: string): string[] {
  if (!text) return [];
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
    result.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}

function exactFragments(text: string): string[] {
  const fragments: string[] = [];
  let current = "";
  for (const line of exactLines(text)) {
    current += line;
    if (line.replace(/[\r\n]/gu, "").trim().length === 0) {
      fragments.push(current);
      current = "";
    }
  }
  if (current) fragments.push(current);
  return fragments;
}

function unitRanges(text: string, unit: "line" | "fragment"): UnitRange[] {
  let offset = 0;
  const values = unit === "line" ? exactLines(text) : exactFragments(text);
  return values.map((value) => {
    const start = offset;
    offset += encoder.encode(value).length;
    return { start, end: offset };
  });
}

function intersectingRange(ranges: UnitRange[], start: number, end: number): UnitRange {
  let first = ranges.findIndex((range) => range.end > start);
  if (first < 0) first = ranges.length;
  let last = first;
  while (last < ranges.length && ranges[last].start < end) last += 1;
  return { start: first, end: last };
}

function safeUtf8End(source: Uint8Array, start: number): number {
  let end = Math.min(start + GMAIL_CONTENT_SEGMENT_MAX_BYTES, source.length);
  while (end > start && end < source.length && (source[end] & 0xc0) === 0x80) end -= 1;
  if (end === start) {
    throw new ElizaError("Gmail source has no valid UTF-8 segment boundary", {
      code: "GMAIL_READ_CACHE_CORRUPT",
    });
  }
  return end;
}

function requireUuid(value: string | undefined, field: string): UUID {
  if (!value || !UUID_PATTERN.test(value)) {
    throw new ElizaError(`Gmail read requires verified ${field}`, {
      code: "GMAIL_READ_AUTH_CONTEXT_REQUIRED",
    });
  }
  return value as UUID;
}

function referenceId(reference: string): UUID {
  const raw = reference.startsWith(GMAIL_CONTENT_REFERENCE_PREFIX)
    ? reference.slice(GMAIL_CONTENT_REFERENCE_PREFIX.length)
    : "";
  if (!UUID_PATTERN.test(raw)) {
    throw new ElizaError("Gmail read reference is invalid", {
      code: "GMAIL_READ_REFERENCE_UNRESOLVED",
    });
  }
  return raw as UUID;
}

export function gmailContentReference(id: UUID): string {
  return `${GMAIL_CONTENT_REFERENCE_PREFIX}${id}`;
}

export function gmailContentHeadId(args: {
  agentId: UUID;
  ownerEntityId: UUID;
  roomId: UUID;
  accountId: string;
  messageId: string;
}): UUID {
  return stringToUuid(
    `gmail-content:v1:${args.agentId}:${args.ownerEntityId}:${args.roomId}:${args.accountId}:${args.messageId}`
  );
}

export function gmailPublicRevision(args: {
  agentId: UUID;
  ownerEntityId: UUID;
  roomId: UUID;
  accountId: string;
  messageId: string;
  providerRevision: string;
  sourceSha256: string;
}): string {
  return `gmail:${digest(
    [
      "elizaos:gmail-content-revision:v2",
      args.agentId,
      args.ownerEntityId,
      args.roomId,
      args.accountId,
      args.messageId,
      args.providerRevision,
      args.sourceSha256,
    ].join("\0")
  )}`;
}

function parseManifest(memory: Memory): GmailContentManifest {
  let value: unknown;
  try {
    value = JSON.parse(memory.content.text ?? "");
  } catch (cause) {
    throw new ElizaError("Gmail content manifest is not valid JSON", {
      code: "GMAIL_READ_CACHE_CORRUPT",
      cause,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ElizaError("Gmail content manifest is invalid", { code: "GMAIL_READ_CACHE_CORRUPT" });
  }
  const manifest = value as GmailContentManifest;
  const numeric = [
    manifest.byteLength,
    manifest.lineCount,
    manifest.fragmentCount,
    manifest.publishedAt,
    manifest.expiresAt,
  ];
  if (
    manifest.schemaVersion !== 1 ||
    !UUID_PATTERN.test(manifest.ownerEntityId) ||
    !UUID_PATTERN.test(manifest.roomId) ||
    typeof manifest.accountId !== "string" ||
    !manifest.accountId ||
    typeof manifest.messageId !== "string" ||
    !manifest.messageId ||
    typeof manifest.providerRevision !== "string" ||
    !manifest.providerRevision ||
    !/^gmail:[a-f0-9]{64}$/u.test(manifest.publicRevision) ||
    !SHA_PATTERN.test(manifest.sourceSha256) ||
    numeric.some((entry) => !Number.isSafeInteger(entry) || entry < 0) ||
    !Array.isArray(manifest.segments) ||
    (manifest.byteLength > 0 && manifest.segments.length === 0)
  ) {
    throw new ElizaError("Gmail content manifest fields are invalid", {
      code: "GMAIL_READ_CACHE_CORRUPT",
    });
  }
  let previousEnd = 0;
  manifest.segments.forEach((segment, position) => {
    if (
      !UUID_PATTERN.test(segment.id) ||
      segment.position !== position ||
      segment.byteStart !== previousEnd ||
      !Number.isSafeInteger(segment.byteEnd) ||
      segment.byteEnd <= segment.byteStart ||
      segment.byteEnd - segment.byteStart > GMAIL_CONTENT_SEGMENT_MAX_BYTES ||
      !SHA_PATTERN.test(segment.sha256)
    ) {
      throw new ElizaError("Gmail content segment manifest is invalid", {
        code: "GMAIL_READ_CACHE_CORRUPT",
        context: { position },
      });
    }
    previousEnd = segment.byteEnd;
  });
  if (previousEnd !== manifest.byteLength) {
    throw new ElizaError("Gmail content manifest byte coverage is incomplete", {
      code: "GMAIL_READ_CACHE_CORRUPT",
    });
  }
  const storedRevision = (memory.metadata as Record<string, unknown> | undefined)?.revision;
  if (storedRevision !== digest(JSON.stringify(manifest))) {
    throw new ElizaError("Gmail content manifest revision is corrupt", {
      code: "GMAIL_READ_CACHE_CORRUPT",
    });
  }
  return manifest;
}

function authorize(
  memory: Memory,
  manifest: GmailContentManifest,
  auth: GmailContentAuthorization
) {
  if (
    memory.entityId !== auth.ownerEntityId ||
    memory.roomId !== auth.roomId ||
    manifest.ownerEntityId !== auth.ownerEntityId ||
    manifest.roomId !== auth.roomId
  ) {
    throw new ElizaError("Gmail cached content is not authorized for this owner and room", {
      code: "GMAIL_READ_FORBIDDEN",
    });
  }
  if (auth.accountId && auth.accountId !== manifest.accountId) {
    throw new ElizaError("Gmail cached content belongs to a different account", {
      code: "GMAIL_READ_FORBIDDEN",
    });
  }
}

export async function loadGmailContentManifest(args: {
  runtime: IAgentRuntime;
  reference: string;
  authorization: GmailContentAuthorization;
}): Promise<{ memory: Memory; manifest: GmailContentManifest }> {
  const id = referenceId(args.reference);
  const rows = await args.runtime.adapter.getMemoriesByIds([id], GMAIL_CONTENT_HEAD_TABLE);
  const memory = rows[0];
  if (!memory || memory.id !== id || memory.agentId !== args.runtime.agentId) {
    throw new ElizaError("Gmail read reference is unknown or expired", {
      code: "GMAIL_READ_REFERENCE_UNRESOLVED",
    });
  }
  const manifest = parseManifest(memory);
  authorize(memory, manifest, args.authorization);
  return { memory, manifest };
}

export function buildGmailContentPublication(args: {
  runtime: IAgentRuntime;
  ownerEntityId: UUID;
  roomId: UUID;
  accountId: string;
  messageId: string;
  providerRevision: string;
  text: string;
  now?: number;
}): { head: Memory; segments: Memory[]; manifest: GmailContentManifest } {
  const source = encoder.encode(args.text);
  const sourceSha256 = digest(source);
  const lineRanges = unitRanges(args.text, "line");
  const fragmentRanges = unitRanges(args.text, "fragment");
  const headId = gmailContentHeadId({
    agentId: args.runtime.agentId,
    ownerEntityId: args.ownerEntityId,
    roomId: args.roomId,
    accountId: args.accountId,
    messageId: args.messageId,
  });
  const now = args.now ?? Date.now();
  const expiresAt = now + GMAIL_CONTENT_RETENTION_MS;
  const descriptors: GmailSegmentDescriptor[] = [];
  const segments: Memory[] = [];
  for (let start = 0, position = 0; start < source.length; position += 1) {
    const end = safeUtf8End(source, start);
    const line = intersectingRange(lineRanges, start, end);
    const fragment = intersectingRange(fragmentRanges, start, end);
    const bytes = source.subarray(start, end);
    const sha256 = digest(bytes);
    const id = stringToUuid(
      `gmail-content-segment:v1:${headId}:${args.providerRevision}:${position}:${sha256}`
    );
    const descriptor: GmailSegmentDescriptor = {
      id,
      position,
      byteStart: start,
      byteEnd: end,
      lineStart: line.start,
      lineEnd: line.end,
      lineStartBoundary: lineRanges[line.start]?.start === start,
      lineEndBoundary: lineRanges[line.end - 1]?.end === end,
      fragmentStart: fragment.start,
      fragmentEnd: fragment.end,
      fragmentStartBoundary: fragmentRanges[fragment.start]?.start === start,
      fragmentEndBoundary: fragmentRanges[fragment.end - 1]?.end === end,
      sha256,
    };
    descriptors.push(descriptor);
    segments.push({
      id,
      agentId: args.runtime.agentId,
      entityId: args.ownerEntityId,
      roomId: args.roomId,
      content: { text: decoder.decode(bytes) },
      metadata: {
        type: MemoryType.CUSTOM,
        fragmentRole: "gmail-content-segment",
        headId,
        providerRevision: args.providerRevision,
        expiresAt,
        ...descriptor,
      } as unknown as Memory["metadata"],
    });
    start = end;
  }
  const manifest: GmailContentManifest = {
    schemaVersion: 1,
    ownerEntityId: args.ownerEntityId,
    roomId: args.roomId,
    accountId: args.accountId,
    messageId: args.messageId,
    providerRevision: args.providerRevision,
    publicRevision: gmailPublicRevision({
      agentId: args.runtime.agentId,
      ownerEntityId: args.ownerEntityId,
      roomId: args.roomId,
      accountId: args.accountId,
      messageId: args.messageId,
      providerRevision: args.providerRevision,
      sourceSha256,
    }),
    sourceSha256,
    byteLength: source.length,
    lineCount: lineRanges.length,
    fragmentCount: fragmentRanges.length,
    publishedAt: now,
    expiresAt,
    segments: descriptors,
  };
  const manifestRevision = digest(JSON.stringify(manifest));
  const head: Memory = {
    id: headId,
    agentId: args.runtime.agentId,
    entityId: args.ownerEntityId,
    roomId: args.roomId,
    content: { text: JSON.stringify(manifest) },
    metadata: {
      type: MemoryType.CUSTOM,
      cacheKind: "gmail-content-manifest",
      accountId: args.accountId,
      messageId: args.messageId,
      expiresAt: manifest.expiresAt,
      revision: manifestRevision,
    } as Memory["metadata"],
  };
  return { head, segments, manifest };
}

export async function publishGmailContent(args: {
  runtime: IAgentRuntime;
  projection: ReturnType<typeof buildGmailContentPublication>;
  expectedRevision: string | null;
}): Promise<"published" | "conflict"> {
  const publish = args.runtime.adapter.compareAndSwapMemoryPublication;
  if (!publish) {
    throw new ElizaError("Gmail segmented cache requires atomic memory publication", {
      code: "GMAIL_READ_CACHE_UNSUPPORTED",
    });
  }
  const result = await publish.call(args.runtime.adapter, {
    head: { memory: args.projection.head, tableName: GMAIL_CONTENT_HEAD_TABLE },
    dependencies: args.projection.segments.map((memory) => ({
      memory,
      tableName: GMAIL_CONTENT_SEGMENT_TABLE,
    })),
    expectedRevision: args.expectedRevision,
  });
  return result.status;
}

function selectedDescriptors(
  manifest: GmailContentManifest,
  unit: "byte" | "line" | "fragment",
  start: number,
  end: number
): GmailSegmentDescriptor[] {
  if (start === end) return [];
  if (unit === "byte") {
    return manifest.segments.filter(
      (segment) => segment.byteEnd > start && segment.byteStart < end
    );
  }
  const prefix = unit === "line" ? "line" : "fragment";
  const matches = manifest.segments.filter(
    (segment) => segment[`${prefix}End`] > start && segment[`${prefix}Start`] < end
  );
  if (matches.length > 0) {
    const first = matches[0];
    const last = matches[matches.length - 1];
    if (!first[`${prefix}StartBoundary`] && first.position > 0) {
      matches.unshift(manifest.segments[first.position - 1]);
    }
    if (!last[`${prefix}EndBoundary`] && last.position + 1 < manifest.segments.length) {
      matches.push(manifest.segments[last.position + 1]);
    }
  }
  return [...new Map(matches.map((entry) => [entry.id, entry])).values()].sort(
    (left, right) => left.position - right.position
  );
}

export async function readGmailContentPage(args: {
  runtime: IAgentRuntime;
  loaded: { memory: Memory; manifest: GmailContentManifest };
  authorization: GmailContentAuthorization;
  unit: "byte" | "line" | "fragment";
  offset: number;
  limit: number;
  /** Exact manifest queries already performed by the caller for this page. */
  headReads?: number;
}): Promise<GmailContentPage> {
  authorize(args.loaded.memory, args.loaded.manifest, args.authorization);
  const manifest = args.loaded.manifest;
  const total =
    args.unit === "byte"
      ? manifest.byteLength
      : args.unit === "line"
        ? manifest.lineCount
        : manifest.fragmentCount;
  if (args.offset > total) {
    throw new ElizaError("Gmail read offset is past the end of the message", {
      code: "GMAIL_READ_OFFSET_OUT_OF_RANGE",
      context: { offset: args.offset, total, unit: args.unit },
    });
  }
  const requestedEnd = Math.min(args.offset + args.limit, total);
  const descriptors = selectedDescriptors(manifest, args.unit, args.offset, requestedEnd);
  if (descriptors.length > GMAIL_CONTENT_PAGE_MAX_SEGMENTS) {
    throw new ElizaError("Gmail unit page exceeds bounded source work; retry with byte units", {
      code: "GMAIL_READ_UNIT_TOO_LARGE",
      context: { unit: args.unit, segmentRows: descriptors.length },
    });
  }
  const rows = descriptors.length
    ? await args.runtime.adapter.getMemoriesByIds(
        descriptors.map((entry) => entry.id),
        GMAIL_CONTENT_SEGMENT_TABLE
      )
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = descriptors.map((descriptor) => {
    const row = byId.get(descriptor.id);
    const text = row?.content.text;
    if (
      !row ||
      row.agentId !== args.runtime.agentId ||
      row.entityId !== manifest.ownerEntityId ||
      row.roomId !== manifest.roomId ||
      typeof text !== "string" ||
      encoder.encode(text).length !== descriptor.byteEnd - descriptor.byteStart ||
      digest(text) !== descriptor.sha256
    ) {
      throw new ElizaError("Gmail cached content segment is missing or corrupt", {
        code: "GMAIL_READ_CACHE_CORRUPT",
        context: { position: descriptor.position },
      });
    }
    return { descriptor, text };
  });
  let text = "";
  let pageEnd = requestedEnd;
  if (args.unit === "byte") {
    const joined = encoder.encode(ordered.map((entry) => entry.text).join(""));
    const base = descriptors[0]?.byteStart ?? args.offset;
    const localStart = args.offset - base;
    let localEnd = localStart + (requestedEnd - args.offset);
    if (localStart < joined.length && (joined[localStart] & 0xc0) === 0x80) {
      throw new ElizaError("Gmail byte range splits a UTF-8 code point", {
        code: "GMAIL_READ_INVALID_UTF8_BOUNDARY",
      });
    }
    while (
      localEnd > localStart &&
      localEnd < joined.length &&
      (joined[localEnd] & 0xc0) === 0x80
    ) {
      localEnd -= 1;
    }
    if (localEnd === localStart && args.offset < manifest.byteLength) {
      throw new ElizaError("Gmail byte limit is too small for the next UTF-8 code point", {
        code: "GMAIL_READ_LIMIT_SPLITS_CODE_POINT",
      });
    }
    pageEnd = base + localEnd;
    text = decoder.decode(joined.subarray(localStart, localEnd));
  } else {
    const joined = ordered.map((entry) => entry.text).join("");
    const values = args.unit === "line" ? exactLines(joined) : exactFragments(joined);
    const base = descriptors[0]?.[`${args.unit}Start`] ?? args.offset;
    text = values.slice(args.offset - base, requestedEnd - base).join("");
  }
  if (encoder.encode(text).length > GMAIL_CONTENT_SEGMENT_MAX_BYTES) {
    throw new ElizaError("Gmail unit page exceeds the 64 KiB result bound", {
      code: "GMAIL_READ_UNIT_TOO_LARGE",
      context: { unit: args.unit },
    });
  }
  return {
    text,
    start: args.offset,
    end: pageEnd,
    total,
    manifest,
    reference: gmailContentReference(args.loaded.memory.id as UUID),
    sourceWork: { headReads: args.headReads ?? 1, segmentRows: rows.length },
  };
}

/** Explicit retention cleanup; callers may schedule it without affecting reads. */
export async function cleanupExpiredGmailContent(args: {
  runtime: IAgentRuntime;
  roomId: UUID;
  now?: number;
  limit?: number;
}): Promise<{ heads: number; segments: number }> {
  const rows = await args.runtime.adapter.getMemories({
    tableName: GMAIL_CONTENT_HEAD_TABLE,
    agentId: args.runtime.agentId,
    roomId: args.roomId,
    limit: args.limit ?? 1000,
    orderDirection: "asc",
  });
  const now = args.now ?? Date.now();
  const expired: Array<{ head: Memory; manifest: GmailContentManifest }> = [];
  for (const head of rows) {
    const manifest = parseManifest(head);
    if (manifest.expiresAt <= now) expired.push({ head, manifest });
  }
  const expiredSegmentRows = await args.runtime.adapter.getMemories({
    tableName: GMAIL_CONTENT_SEGMENT_TABLE,
    agentId: args.runtime.agentId,
    roomId: args.roomId,
    limit: args.limit ?? 1000,
    orderDirection: "asc",
  });
  const segmentIds = [
    ...new Set([
      ...expired.flatMap(({ manifest }) => manifest.segments.map(({ id }) => id)),
      ...expiredSegmentRows.flatMap((segment) => {
        const expiresAt = (segment.metadata as Record<string, unknown> | undefined)?.expiresAt;
        return typeof expiresAt === "number" && expiresAt <= now && segment.id ? [segment.id] : [];
      }),
    ]),
  ];
  if (segmentIds.length > 0) await args.runtime.adapter.deleteMemories(segmentIds);
  const headIds = expired.flatMap(({ head }) => (head.id ? [head.id] : []));
  if (headIds.length > 0) await args.runtime.adapter.deleteMemories(headIds);
  return { heads: headIds.length, segments: segmentIds.length };
}

export function requireGmailContentAuthorization(request: {
  requesterEntityId?: string;
  requesterRoomId?: string;
  worldId?: string;
}): GmailContentAuthorization {
  return {
    ownerEntityId: requireUuid(request.requesterEntityId, "requester identity"),
    roomId: requireUuid(request.requesterRoomId, "requester room"),
    ...(request.worldId ? { accountId: request.worldId } : {}),
  };
}
