/**
 * Exact native R2 reads for the durable organization storage catalog.
 *
 * This module is deliberately transport-only: it performs no routing,
 * billing, receipt persistence, logging, or provider mutation.
 */

import { ElizaError } from "@elizaos/core";
import type {
  RuntimeR2Bucket,
  RuntimeR2ConditionalGetOptions,
  RuntimeR2Object,
  RuntimeR2ObjectMetadata,
  RuntimeR2Range,
} from "../../storage/r2-runtime-binding";

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_RANGE_HEADER_LENGTH = 128;
const MAX_CONDITIONAL_HEADER_LENGTH = 8_192;
const MAX_CONDITIONAL_LIST_MEMBERS = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STRONG_ETAG_OPAQUE_PATTERN = /^[\x21\x23-\x7e]+$/;

const SAFE_INLINE_CONTENT_TYPES = new Set([
  "application/json",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "video/mp4",
  "video/ogg",
  "video/webm",
]);

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const LONG_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Catalog evidence required to authorize one exact immutable provider read. */
export interface NativeStorageReadSnapshot {
  readonly organizationId: string;
  readonly objectId: string;
  readonly objectKey: string;
  readonly committedGeneration: bigint;
  readonly sizeBytes: bigint;
  readonly providerKey: string;
  readonly providerVersion: string;
  readonly providerEtag: string;
  readonly contentType: string;
  readonly checksumSha256: string | null;
  readonly providerUploadedAt: Date;
}

export type NativeStorageReadErrorCode =
  | "NATIVE_STORAGE_INVALID_SNAPSHOT"
  | "NATIVE_STORAGE_INVALID_RANGE"
  | "NATIVE_STORAGE_BINDING_CONTRACT_UNAVAILABLE"
  | "NATIVE_STORAGE_PROVIDER_READ_FAILED"
  | "NATIVE_STORAGE_PROVIDER_OBJECT_MISSING"
  | "NATIVE_STORAGE_PROVIDER_CONDITION_FAILED"
  | "NATIVE_STORAGE_PROVIDER_EVIDENCE_MISMATCH"
  | "NATIVE_STORAGE_PROVIDER_STREAM_UNUSABLE";

const ERROR_MESSAGES: Readonly<Record<NativeStorageReadErrorCode, string>> = {
  NATIVE_STORAGE_INVALID_SNAPSHOT: "Native storage read snapshot is invalid.",
  NATIVE_STORAGE_INVALID_RANGE: "Native storage byte range is invalid.",
  NATIVE_STORAGE_BINDING_CONTRACT_UNAVAILABLE: "Native storage read binding is unavailable.",
  NATIVE_STORAGE_PROVIDER_READ_FAILED: "Native storage provider read failed.",
  NATIVE_STORAGE_PROVIDER_OBJECT_MISSING: "Native storage object is unavailable.",
  NATIVE_STORAGE_PROVIDER_CONDITION_FAILED:
    "Native storage object changed before it could be read.",
  NATIVE_STORAGE_PROVIDER_EVIDENCE_MISMATCH:
    "Native storage object evidence does not match the read snapshot.",
  NATIVE_STORAGE_PROVIDER_STREAM_UNUSABLE:
    "Native storage object body is not a fresh readable stream.",
};

/** Privacy-safe transport failure. Messages and fields never retain provider evidence. */
export class NativeStorageReadError extends ElizaError {
  override readonly name = "NativeStorageReadError";
  override readonly code: NativeStorageReadErrorCode;

  constructor(code: NativeStorageReadErrorCode, cause?: unknown) {
    super(ERROR_MESSAGES[code], {
      code,
      ...(cause === undefined ? {} : { cause }),
      severity:
        code === "NATIVE_STORAGE_PROVIDER_READ_FAILED" ||
        code === "NATIVE_STORAGE_BINDING_CONTRACT_UNAVAILABLE"
          ? "ephemeral"
          : "fatal",
    });
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type NativeStorageRangeSpec =
  | { readonly kind: "bounded"; readonly start: number; readonly end: number }
  | { readonly kind: "open"; readonly start: number }
  | { readonly kind: "suffix"; readonly length: number };

export type NativeStorageRangeInvalidReason =
  | "malformed"
  | "multiple_ranges"
  | "overflow"
  | "reversed"
  | "zero_suffix";

export type NativeStorageRangeParseResult =
  | { readonly outcome: "absent" }
  | { readonly outcome: "parsed"; readonly range: NativeStorageRangeSpec }
  | {
      readonly outcome: "invalid";
      readonly reason: NativeStorageRangeInvalidReason;
    };

export interface NativeStorageResolvedRange {
  readonly offset: number;
  readonly length: number;
  readonly end: number;
  readonly contentRange: string;
}

export type NativeStorageRangeResolution =
  | { readonly outcome: "satisfiable"; readonly range: NativeStorageResolvedRange }
  | { readonly outcome: "unsatisfiable" };

export interface NativeStorageClientConditionalDecision {
  readonly outcome: "proceed" | "not_modified" | "precondition_failed";
  /** Whether a syntactically valid Range request may remain a partial read. */
  readonly useRange: boolean;
}

export interface NativeStorageOpenedRead {
  readonly body: ReadableStream<Uint8Array>;
  readonly range: NativeStorageResolvedRange | null;
  readonly headers: Headers;
}

interface ParsedEntityTag {
  readonly weak: boolean;
  readonly opaque: string;
}

interface ParsedEntityTagList {
  readonly wildcard: boolean;
  readonly tags: readonly ParsedEntityTag[];
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Validates an NFC, bucket-relative R2 key without disclosing it on failure. */
export function isCanonicalNativeStorageRelativeKey(value: string): boolean {
  if (typeof value !== "string") return false;
  const segments = value.split("/");
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    isWellFormedUnicode(value) &&
    value === value.normalize("NFC") &&
    new TextEncoder().encode(value).byteLength <= 1_024 &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    !/\p{Cc}/u.test(value)
  );
}

function snapshotIsValid(snapshot: NativeStorageReadSnapshot): boolean {
  try {
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      typeof snapshot.organizationId !== "string" ||
      typeof snapshot.objectId !== "string" ||
      typeof snapshot.objectKey !== "string" ||
      typeof snapshot.committedGeneration !== "bigint" ||
      typeof snapshot.sizeBytes !== "bigint" ||
      typeof snapshot.providerKey !== "string" ||
      typeof snapshot.providerVersion !== "string" ||
      typeof snapshot.providerEtag !== "string" ||
      typeof snapshot.contentType !== "string" ||
      (snapshot.checksumSha256 !== null && typeof snapshot.checksumSha256 !== "string") ||
      !UUID_PATTERN.test(snapshot.organizationId) ||
      !UUID_PATTERN.test(snapshot.objectId) ||
      snapshot.committedGeneration < 1n ||
      snapshot.committedGeneration > MAX_SIGNED_BIGINT ||
      snapshot.sizeBytes < 0n ||
      snapshot.sizeBytes > MAX_SAFE_INTEGER_BIGINT ||
      !isCanonicalNativeStorageRelativeKey(snapshot.objectKey) ||
      !snapshot.objectKey.startsWith(`org/${snapshot.organizationId}/`) ||
      !isCanonicalNativeStorageRelativeKey(snapshot.providerKey) ||
      snapshot.providerVersion.length < 1 ||
      snapshot.providerVersion.length > 1_024 ||
      snapshot.providerEtag.length > 512 ||
      !STRONG_ETAG_OPAQUE_PATTERN.test(snapshot.providerEtag) ||
      snapshot.contentType.length < 1 ||
      snapshot.contentType.length > 255 ||
      snapshot.contentType.trim() !== snapshot.contentType ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(snapshot.contentType) ||
      (snapshot.checksumSha256 !== null && !SHA256_PATTERN.test(snapshot.checksumSha256)) ||
      !(snapshot.providerUploadedAt instanceof Date) ||
      !Number.isFinite(snapshot.providerUploadedAt.getTime())
    ) {
      return false;
    }

    const immutableProviderKey = `__eliza_storage_authority/v1/org/${snapshot.organizationId}/${snapshot.objectId}/${snapshot.committedGeneration.toString(10)}`;
    return (
      snapshot.providerKey === immutableProviderKey ||
      (snapshot.committedGeneration === 1n && snapshot.providerKey === snapshot.objectKey)
    );
  } catch {
    // error-policy:J3 malformed runtime values collapse to the static invalid-snapshot result.
    return false;
  }
}

function assertValidSnapshot(snapshot: NativeStorageReadSnapshot): void {
  if (!snapshotIsValid(snapshot)) {
    throw new NativeStorageReadError("NATIVE_STORAGE_INVALID_SNAPSHOT");
  }
}

function canonicalSnapshot(snapshot: NativeStorageReadSnapshot): NativeStorageReadSnapshot {
  assertValidSnapshot(snapshot);
  return Object.freeze({
    organizationId: snapshot.organizationId,
    objectId: snapshot.objectId,
    objectKey: snapshot.objectKey,
    committedGeneration: snapshot.committedGeneration,
    sizeBytes: snapshot.sizeBytes,
    providerKey: snapshot.providerKey,
    providerVersion: snapshot.providerVersion,
    providerEtag: snapshot.providerEtag,
    contentType: snapshot.contentType,
    checksumSha256: snapshot.checksumSha256,
    providerUploadedAt: new Date(snapshot.providerUploadedAt.getTime()),
  });
}

function parseSafeInteger(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed > MAX_SAFE_INTEGER_BIGINT) return null;
    return Number(parsed);
  } catch {
    // error-policy:J3 malformed attacker-controlled decimal input is an explicit invalid parse.
    return null;
  }
}

/** Parses one bounded HTTP byte range without allocating from attacker input. */
export function parseNativeStorageRange(
  headerValue: string | null | undefined,
): NativeStorageRangeParseResult {
  if (headerValue === null || headerValue === undefined) return { outcome: "absent" };
  if (typeof headerValue !== "string") return { outcome: "invalid", reason: "malformed" };
  const value = headerValue.trim();
  if (value.length === 0) return { outcome: "invalid", reason: "malformed" };
  if (value.length > MAX_RANGE_HEADER_LENGTH) return { outcome: "invalid", reason: "overflow" };
  if (value.includes(",")) return { outcome: "invalid", reason: "multiple_ranges" };

  const match = /^bytes=([0-9]*)-([0-9]*)$/i.exec(value);
  if (!match) return { outcome: "invalid", reason: "malformed" };
  const first = match[1] ?? "";
  const last = match[2] ?? "";
  if (first.length === 0 && last.length === 0) {
    return { outcome: "invalid", reason: "malformed" };
  }

  if (first.length === 0) {
    const length = parseSafeInteger(last);
    if (length === null) return { outcome: "invalid", reason: "overflow" };
    if (length === 0) return { outcome: "invalid", reason: "zero_suffix" };
    return { outcome: "parsed", range: { kind: "suffix", length } };
  }

  const start = parseSafeInteger(first);
  if (start === null) return { outcome: "invalid", reason: "overflow" };
  if (last.length === 0) return { outcome: "parsed", range: { kind: "open", start } };

  const end = parseSafeInteger(last);
  if (end === null) return { outcome: "invalid", reason: "overflow" };
  if (end < start) return { outcome: "invalid", reason: "reversed" };
  return { outcome: "parsed", range: { kind: "bounded", start, end } };
}

/** Resolves a parsed range against the exact catalog size. */
export function resolveNativeStorageRange(
  range: NativeStorageRangeSpec,
  sizeBytes: bigint,
): NativeStorageRangeResolution {
  if (!isCanonicalRangeSpec(range)) {
    throw new NativeStorageReadError("NATIVE_STORAGE_INVALID_RANGE");
  }
  if (typeof sizeBytes !== "bigint" || sizeBytes < 0n || sizeBytes > MAX_SAFE_INTEGER_BIGINT) {
    throw new NativeStorageReadError("NATIVE_STORAGE_INVALID_RANGE");
  }
  if (sizeBytes === 0n) return { outcome: "unsatisfiable" };

  const size = Number(sizeBytes);
  let offset: number;
  let end: number;
  if (range.kind === "suffix") {
    const length = Math.min(range.length, size);
    offset = size - length;
    end = size - 1;
  } else {
    if (range.start >= size) return { outcome: "unsatisfiable" };
    offset = range.start;
    end = range.kind === "bounded" ? Math.min(range.end, size - 1) : size - 1;
  }

  const length = end - offset + 1;
  return {
    outcome: "satisfiable",
    range: Object.freeze({
      offset,
      length,
      end,
      contentRange: `bytes ${offset}-${end}/${sizeBytes.toString(10)}`,
    }),
  };
}

function isCanonicalRangeSpec(range: NativeStorageRangeSpec): boolean {
  try {
    if (typeof range !== "object" || range === null) return false;
    if (range.kind === "suffix") {
      return Number.isSafeInteger(range.length) && range.length > 0;
    }
    if (!Number.isSafeInteger(range.start) || range.start < 0) return false;
    return (
      range.kind === "open" ||
      (range.kind === "bounded" && Number.isSafeInteger(range.end) && range.end >= range.start)
    );
  } catch {
    // error-policy:J3 malformed runtime range objects fail canonical validation.
    return false;
  }
}

function canonicalResolvedRange(
  range: NativeStorageResolvedRange | null,
  sizeBytes: bigint,
): NativeStorageResolvedRange | null {
  if (range === null) return null;
  try {
    if (
      typeof range !== "object" ||
      sizeBytes <= 0n ||
      sizeBytes > MAX_SAFE_INTEGER_BIGINT ||
      !Number.isSafeInteger(range.offset) ||
      range.offset < 0 ||
      !Number.isSafeInteger(range.length) ||
      range.length < 1 ||
      !Number.isSafeInteger(range.end) ||
      range.end !== range.offset + range.length - 1 ||
      BigInt(range.end) >= sizeBytes
    ) {
      throw new NativeStorageReadError("NATIVE_STORAGE_INVALID_RANGE");
    }
    const contentRange = `bytes ${range.offset}-${range.end}/${sizeBytes.toString(10)}`;
    if (range.contentRange !== contentRange) {
      throw new NativeStorageReadError("NATIVE_STORAGE_INVALID_RANGE");
    }
    return Object.freeze({
      offset: range.offset,
      length: range.length,
      end: range.end,
      contentRange,
    });
  } catch (error) {
    // error-policy:J3 malformed runtime range objects collapse to one static typed failure.
    if (error instanceof NativeStorageReadError) throw error;
    throw new NativeStorageReadError("NATIVE_STORAGE_INVALID_RANGE");
  }
}

function skipOptionalWhitespace(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t") index += 1;
  return index;
}

function parseEntityTagList(value: string): ParsedEntityTagList | null {
  if (value.length > MAX_CONDITIONAL_HEADER_LENGTH) return null;
  let index = skipOptionalWhitespace(value, 0);
  if (value[index] === "*") {
    index = skipOptionalWhitespace(value, index + 1);
    return index === value.length ? { wildcard: true, tags: [] } : null;
  }

  const tags: ParsedEntityTag[] = [];
  let members = 0;
  while (index < value.length) {
    if (value[index] === ",") {
      members += 1;
      if (members > MAX_CONDITIONAL_LIST_MEMBERS) return null;
      index = skipOptionalWhitespace(value, index + 1);
      continue;
    }
    members += 1;
    if (members > MAX_CONDITIONAL_LIST_MEMBERS) return null;
    let weak = false;
    if (value.startsWith("W/", index)) {
      weak = true;
      index += 2;
    }
    if (value[index] !== '"') return null;
    index += 1;
    const opaqueStart = index;
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index);
      if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || code >= 0x80)) return null;
      index += 1;
    }
    if (value[index] !== '"') return null;
    tags.push({ weak, opaque: value.slice(opaqueStart, index) });
    index = skipOptionalWhitespace(value, index + 1);
    if (index === value.length) break;
    if (value[index] !== ",") return null;
    index = skipOptionalWhitespace(value, index + 1);
  }
  return tags.length > 0 ? { wildcard: false, tags } : null;
}

function parseSingleEntityTag(value: string): ParsedEntityTag | null {
  if (value.length > MAX_CONDITIONAL_HEADER_LENGTH) return null;
  const match = /^(W\/)?"([\x21\x23-\x7e\u0080-\uffff]*)"$/.exec(value.trim());
  if (!match) return null;
  return { weak: match[1] !== undefined, opaque: match[2] ?? "" };
}

function parsedDate(
  weekday: string,
  day: number,
  monthName: string,
  year: number,
  hour: number,
  minute: number,
  second: number,
  longWeekday: boolean,
): number | null {
  const month = MONTHS.indexOf(monthName as (typeof MONTHS)[number]);
  if (month < 0 || year < 1_900 || day < 1 || hour > 23 || minute > 59 || second > 60) {
    return null;
  }
  const validatedSecond = Math.min(second, 59);
  const milliseconds = Date.UTC(year, month, day, hour, minute, validatedSecond);
  const date = new Date(milliseconds);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== validatedSecond
  ) {
    return null;
  }
  const expectedWeekday = longWeekday
    ? LONG_WEEKDAYS[date.getUTCDay()]
    : SHORT_WEEKDAYS[date.getUTCDay()];
  return weekday === expectedWeekday ? milliseconds + (second === 60 ? 1_000 : 0) : null;
}

/** Parses the three RFC HTTP-date forms without accepting Date.parse extensions. */
function parseHttpDate(value: string): number | null {
  const normalized = value.trim();
  let match =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
      normalized,
    );
  if (match) {
    return parsedDate(
      match[1] ?? "",
      Number(match[2]),
      match[3] ?? "",
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7]),
      false,
    );
  }

  match =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
      normalized,
    );
  if (match) {
    const currentYear = new Date().getUTCFullYear();
    const currentCentury = Math.floor(currentYear / 100) * 100;
    let year = currentCentury + Number(match[4]);
    if (year > currentYear + 50) year -= 100;
    return parsedDate(
      match[1] ?? "",
      Number(match[2]),
      match[3] ?? "",
      year,
      Number(match[5]),
      Number(match[6]),
      Number(match[7]),
      true,
    );
  }

  match =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 0-9][0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(
      normalized,
    );
  if (!match) return null;
  return parsedDate(
    match[1] ?? "",
    Number((match[3] ?? "").trim()),
    match[2] ?? "",
    Number(match[7]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    false,
  );
}

function lastModifiedMilliseconds(snapshot: NativeStorageReadSnapshot): number {
  return Math.floor(snapshot.providerUploadedAt.getTime() / 1_000) * 1_000;
}

/** Evaluates GET/HEAD validators in RFC precedence order, including If-Range. */
export function evaluateNativeStorageClientConditionals(
  headers: Headers,
  snapshot: NativeStorageReadSnapshot,
  rangeRequested: boolean,
): NativeStorageClientConditionalDecision {
  const verifiedSnapshot = canonicalSnapshot(snapshot);
  const currentEtag = verifiedSnapshot.providerEtag;
  const modifiedAt = lastModifiedMilliseconds(verifiedSnapshot);

  const ifMatchValue = headers.get("if-match");
  if (ifMatchValue !== null) {
    const parsed = parseEntityTagList(ifMatchValue);
    const matched =
      parsed !== null &&
      (parsed.wildcard || parsed.tags.some((tag) => !tag.weak && tag.opaque === currentEtag));
    if (!matched) return { outcome: "precondition_failed", useRange: false };
  } else {
    const ifUnmodifiedSince = headers.get("if-unmodified-since");
    if (ifUnmodifiedSince !== null) {
      const timestamp = parseHttpDate(ifUnmodifiedSince);
      if (timestamp !== null && modifiedAt > timestamp) {
        return { outcome: "precondition_failed", useRange: false };
      }
    }
  }

  const ifNoneMatchValue = headers.get("if-none-match");
  if (ifNoneMatchValue !== null) {
    const parsed = parseEntityTagList(ifNoneMatchValue);
    if (
      parsed !== null &&
      (parsed.wildcard || parsed.tags.some((tag) => tag.opaque === currentEtag))
    ) {
      return { outcome: "not_modified", useRange: false };
    }
  } else {
    const ifModifiedSince = headers.get("if-modified-since");
    if (ifModifiedSince !== null) {
      const timestamp = parseHttpDate(ifModifiedSince);
      if (timestamp !== null && modifiedAt <= timestamp) {
        return { outcome: "not_modified", useRange: false };
      }
    }
  }

  if (!rangeRequested) return { outcome: "proceed", useRange: false };
  const ifRangeValue = headers.get("if-range");
  if (ifRangeValue === null) return { outcome: "proceed", useRange: true };

  const ifRangeTag = parseSingleEntityTag(ifRangeValue);
  if (ifRangeTag !== null) {
    return {
      outcome: "proceed",
      useRange: !ifRangeTag.weak && ifRangeTag.opaque === currentEtag,
    };
  }
  // A Last-Modified value has only one-second precision. Without an explicit
  // strong-validator proof, two committed generations could share that value.
  return { outcome: "proceed", useRange: false };
}

function isSafeInlineContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SAFE_INLINE_CONTENT_TYPES.has(mediaType);
}

/** Builds response headers from a fixed allowlist and catalog evidence only. */
export function buildNativeStoragePrivateHeaders(
  snapshot: NativeStorageReadSnapshot,
  range: NativeStorageResolvedRange | null = null,
): Headers {
  const verifiedSnapshot = canonicalSnapshot(snapshot);
  const verifiedRange = canonicalResolvedRange(range, verifiedSnapshot.sizeBytes);
  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store, max-age=0, no-transform");
  headers.set(
    "Content-Length",
    String(verifiedRange?.length ?? Number(verifiedSnapshot.sizeBytes)),
  );
  if (verifiedRange) headers.set("Content-Range", verifiedRange.contentRange);
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'");
  headers.set("Content-Type", verifiedSnapshot.contentType);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("ETag", `"${verifiedSnapshot.providerEtag}"`);
  headers.set("Last-Modified", verifiedSnapshot.providerUploadedAt.toUTCString());
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  if (!isSafeInlineContentType(verifiedSnapshot.contentType)) {
    headers.set("Content-Disposition", "attachment");
  }
  return headers;
}

function arrayBufferToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checksumMatches(observed: ArrayBuffer | undefined, expected: string | null): boolean {
  if (expected === null) return true;
  try {
    return (
      observed instanceof ArrayBuffer &&
      observed.byteLength === 32 &&
      arrayBufferToHex(observed) === expected
    );
  } catch {
    // error-policy:J3 malformed bounded checksum metadata is an explicit evidence mismatch.
    return false;
  }
}

function rangeMatches(
  observed: RuntimeR2Range | undefined,
  expected: NativeStorageResolvedRange | null,
): boolean {
  if (expected === null) return observed === undefined;
  return (
    observed !== undefined &&
    "offset" in observed &&
    "length" in observed &&
    observed.offset === expected.offset &&
    observed.length === expected.length
  );
}

function evidenceMatches(
  observed: RuntimeR2Object | RuntimeR2ObjectMetadata,
  snapshot: NativeStorageReadSnapshot,
  expectedRange: NativeStorageResolvedRange | null,
): boolean {
  try {
    return (
      observed.key === snapshot.providerKey &&
      observed.version === snapshot.providerVersion &&
      observed.etag === snapshot.providerEtag &&
      observed.httpEtag === `"${snapshot.providerEtag}"` &&
      Number.isSafeInteger(observed.size) &&
      BigInt(observed.size ?? -1) === snapshot.sizeBytes &&
      observed.httpMetadata?.contentType === snapshot.contentType &&
      observed.uploaded instanceof Date &&
      observed.uploaded.getTime() === snapshot.providerUploadedAt.getTime() &&
      checksumMatches(observed.checksums?.sha256, snapshot.checksumSha256) &&
      rangeMatches(observed.range, expectedRange)
    );
  } catch {
    // error-policy:J3 malformed provider metadata is an explicit evidence mismatch.
    return false;
  }
}

function potentialBody(value: RuntimeR2Object | RuntimeR2ObjectMetadata): unknown {
  try {
    return Reflect.get(value, "body");
  } catch {
    // error-policy:J3 an unreadable provider body property is treated as absent evidence.
    return undefined;
  }
}

function inspectReadableStream(
  value: unknown,
): { readonly stream: ReadableStream<Uint8Array>; readonly locked: boolean } | null {
  if (!(value instanceof ReadableStream)) return null;
  try {
    const getReader = Reflect.get(value, "getReader");
    const cancel = Reflect.get(value, "cancel");
    const locked = Reflect.get(value, "locked");
    if (
      typeof getReader !== "function" ||
      typeof cancel !== "function" ||
      typeof locked !== "boolean"
    ) {
      return null;
    }
    return { stream: value, locked };
  } catch {
    // error-policy:J3 malformed provider stream properties fail the freshness gate.
    return null;
  }
}

function redactedProviderCause(code: string, message: string): ElizaError {
  return new ElizaError(message, { code, severity: "ephemeral" });
}

async function cancelPotentialBody(value: unknown): Promise<ElizaError | null> {
  if (typeof value !== "object" || value === null) return null;
  try {
    const cancel = Reflect.get(value, "cancel");
    if (typeof cancel === "function") await Reflect.apply(cancel, value, []);
  } catch {
    // error-policy:J1 the privacy boundary translates an awaited cancellation
    // rejection to a typed redacted cause; provider messages never cross it.
    return redactedProviderCause(
      "NATIVE_STORAGE_PROVIDER_CANCEL_FAILED",
      "Native storage provider body cancellation failed.",
    );
  }
  return null;
}

/** HEADs and verifies every catalogued provider field without returning metadata. */
export async function verifyNativeStorageHead(
  bucket: RuntimeR2Bucket,
  snapshot: NativeStorageReadSnapshot,
): Promise<void> {
  const verifiedSnapshot = canonicalSnapshot(snapshot);
  if (typeof bucket.head !== "function") {
    throw new NativeStorageReadError("NATIVE_STORAGE_BINDING_CONTRACT_UNAVAILABLE");
  }

  let observed: RuntimeR2ObjectMetadata | null;
  try {
    observed = await bucket.head(verifiedSnapshot.providerKey);
  } catch {
    // error-policy:J1 translate the provider boundary to a typed static failure;
    // the cause is deliberately redacted because object evidence is secret.
    throw new NativeStorageReadError(
      "NATIVE_STORAGE_PROVIDER_READ_FAILED",
      redactedProviderCause(
        "NATIVE_STORAGE_PROVIDER_HEAD_REJECTED",
        "Native storage provider HEAD was rejected.",
      ),
    );
  }
  if (observed === null) {
    throw new NativeStorageReadError("NATIVE_STORAGE_PROVIDER_OBJECT_MISSING");
  }
  if (!evidenceMatches(observed, verifiedSnapshot, null)) {
    throw new NativeStorageReadError("NATIVE_STORAGE_PROVIDER_EVIDENCE_MISMATCH");
  }
}

/** Opens an exact conditional native R2 GET and transfers its untouched stream. */
export async function openNativeStorageGet(
  bucket: RuntimeR2Bucket,
  snapshot: NativeStorageReadSnapshot,
  range: NativeStorageResolvedRange | null = null,
): Promise<NativeStorageOpenedRead> {
  const verifiedSnapshot = canonicalSnapshot(snapshot);
  const verifiedRange = canonicalResolvedRange(range, verifiedSnapshot.sizeBytes);
  const options: RuntimeR2ConditionalGetOptions = {
    onlyIf: { etagMatches: verifiedSnapshot.providerEtag },
    ...(verifiedRange
      ? { range: { offset: verifiedRange.offset, length: verifiedRange.length } }
      : {}),
  };

  let observed: RuntimeR2Object | RuntimeR2ObjectMetadata | null;
  try {
    observed = await bucket.get(verifiedSnapshot.providerKey, options);
  } catch {
    // error-policy:J1 translate the provider boundary to a typed static failure;
    // the cause is deliberately redacted because object evidence is secret.
    throw new NativeStorageReadError(
      "NATIVE_STORAGE_PROVIDER_READ_FAILED",
      redactedProviderCause(
        "NATIVE_STORAGE_PROVIDER_GET_REJECTED",
        "Native storage provider GET was rejected.",
      ),
    );
  }
  if (observed === null) {
    throw new NativeStorageReadError("NATIVE_STORAGE_PROVIDER_OBJECT_MISSING");
  }

  const body = potentialBody(observed);
  if (body === undefined || body === null) {
    throw new NativeStorageReadError("NATIVE_STORAGE_PROVIDER_CONDITION_FAILED");
  }
  if (!evidenceMatches(observed, verifiedSnapshot, verifiedRange)) {
    const cancelCause = await cancelPotentialBody(body);
    throw new NativeStorageReadError(
      "NATIVE_STORAGE_PROVIDER_EVIDENCE_MISMATCH",
      cancelCause ?? undefined,
    );
  }

  let bodyUsed: unknown;
  try {
    bodyUsed = Reflect.get(observed, "bodyUsed");
  } catch {
    // error-policy:J3 an unreadable bodyUsed property fails the stream freshness gate.
    const cancelCause = await cancelPotentialBody(body);
    throw new NativeStorageReadError(
      "NATIVE_STORAGE_PROVIDER_STREAM_UNUSABLE",
      cancelCause ?? undefined,
    );
  }
  const streamState = inspectReadableStream(body);
  if (streamState === null || bodyUsed !== false || streamState.locked) {
    const cancelCause = await cancelPotentialBody(body);
    throw new NativeStorageReadError(
      "NATIVE_STORAGE_PROVIDER_STREAM_UNUSABLE",
      cancelCause ?? undefined,
    );
  }

  let headers: Headers;
  try {
    headers = buildNativeStoragePrivateHeaders(verifiedSnapshot, verifiedRange);
  } catch {
    // error-policy:J3 a failed fixed-allowlist header build invalidates the snapshot.
    const cancelCause = await cancelPotentialBody(body);
    throw new NativeStorageReadError("NATIVE_STORAGE_INVALID_SNAPSHOT", cancelCause ?? undefined);
  }
  return Object.freeze({ body: streamState.stream, range: verifiedRange, headers });
}
