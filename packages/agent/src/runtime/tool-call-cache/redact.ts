/**
 * Default privacy redactor for the tool-call cache.
 *
 * This focused redactor covers the credential and location data that may enter
 * cached tool results and is applied to every disk write.
 *
 * The redactor walks the value tree and replaces:
 *   - common API key shapes (`sk-…`, `Bearer …`, `ghp_…`, `AKIA…`)
 *   - environment-variable values whose key name looks like a secret
 *   - geographic coordinates (matching the Location-plugin patterns)
 *
 * The walk is the shared descriptor-safe bounded traversal in
 * `bounded-walk.ts`: path-scoped cycle detection (so shared acyclic subtrees /
 * DAGs are fully redacted), width reserved before any per-entry work, data
 * descriptors only (accessors and reflection failures never run user code),
 * and a node/key/string/byte budget shared across the whole walk.
 *
 * True cycles emit [Circular]; containers past the depth cap emit [MaxDepth];
 * anything rejected by the work budget or by hostile reflection emits
 * [Bounded]. DiskStore refuses to persist a degraded value so a sentinel can
 * never be served as a successful cross-process hit. Legitimate tool output
 * that already equals a sentinel string is treated as degraded and is
 * deliberately uncacheable (safe, re-executed every time).
 */

import { type BoundedWalkRejection, boundedWalk } from "./bounded-walk.ts";
import type { PrivacyRedactor } from "./types.ts";

const CREDENTIAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // The generic sk- shape also accepts hyphens, so the provider-specific
  // prefix must be classified first.
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g },
  { label: "github-token", pattern: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { label: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

const GEO_PATTERNS: RegExp[] = [
  /"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?/g,
  /\b(?:current\s+location|location|coords|coordinates)\s*[:=]\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/gi,
  /\b(?:lat|latitude)\s*[:=]\s*-?\d+(?:\.\d+)?\s*[,;]\s*(?:lng|lon|long|longitude)\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
  /\b-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}\b/g,
];

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|API|CREDENTIAL/i;
const COORDS_MARKER = '"coords"';
const LATITUDE_MARKER = '"latitude"';
const LONGITUDE_MARKER = '"longitude"';

function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length) {
    const code = input.charCodeAt(cursor);
    const whitespace =
      (code >= 9 && code <= 13) ||
      code === 32 ||
      code === 160 ||
      code === 5760 ||
      (code >= 8192 && code <= 8202) ||
      code === 8232 ||
      code === 8233 ||
      code === 8239 ||
      code === 8287 ||
      code === 12288 ||
      code === 65279;
    if (!whitespace) break;
    cursor += 1;
  }
  return cursor;
}

function scanNumber(input: string, start: number): number | null {
  let cursor = start;
  if (input[cursor] === "-") cursor += 1;
  const integerStart = cursor;
  while (
    cursor < input.length &&
    input.charCodeAt(cursor) >= 48 &&
    input.charCodeAt(cursor) <= 57
  ) {
    cursor += 1;
  }
  if (cursor === integerStart) return null;
  if (input[cursor] !== ".") return cursor;
  cursor += 1;
  const fractionStart = cursor;
  while (
    cursor < input.length &&
    input.charCodeAt(cursor) >= 48 &&
    input.charCodeAt(cursor) <= 57
  ) {
    cursor += 1;
  }
  return cursor === fractionStart ? null : cursor;
}

function scanIdentifierKey(input: string, start: number): number | null {
  if (input[start] !== '"') return null;
  let cursor = start + 1;
  const first = input.charCodeAt(cursor);
  const firstValid =
    (first >= 65 && first <= 90) ||
    (first >= 97 && first <= 122) ||
    first === 95;
  if (!firstValid) return null;
  cursor += 1;
  while (cursor < input.length) {
    const code = input.charCodeAt(cursor);
    if (code === 34) return cursor + 1;
    const valid =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95;
    if (!valid) return null;
    cursor += 1;
  }
  return null;
}

type CoordsScan =
  | { matched: true; end: number }
  | { matched: false; resumeAt: number };

// On failure the scan reports how far it walked so the caller never rescans a
// rejected span. Skipping it is provably safe: the sub-scans (whitespace,
// number, identifier key) can never contain `"` or `}`, and value scans stop
// at — never consume — `}`, so any complete coords block inside the span would
// have terminated this scan successfully instead of letting it fail.
function scanCoordsBlock(input: string, start: number): CoordsScan {
  let cursor = skipWhitespace(input, start + COORDS_MARKER.length);
  const fail = (): CoordsScan => ({ matched: false, resumeAt: cursor });
  if (input[cursor] !== ":") return fail();
  cursor = skipWhitespace(input, cursor + 1);
  if (input[cursor] !== "{") return fail();
  cursor = skipWhitespace(input, cursor + 1);
  if (!input.startsWith(LATITUDE_MARKER, cursor)) return fail();
  cursor = skipWhitespace(input, cursor + LATITUDE_MARKER.length);
  if (input[cursor] !== ":") return fail();
  cursor = skipWhitespace(input, cursor + 1);
  const latitudeEnd = scanNumber(input, cursor);
  if (latitudeEnd === null) return fail();
  cursor = skipWhitespace(input, latitudeEnd);
  if (input[cursor] !== ",") return fail();
  cursor = skipWhitespace(input, cursor + 1);
  if (!input.startsWith(LONGITUDE_MARKER, cursor)) return fail();
  cursor = skipWhitespace(input, cursor + LONGITUDE_MARKER.length);
  if (input[cursor] !== ":") return fail();
  cursor = skipWhitespace(input, cursor + 1);
  const longitudeEnd = scanNumber(input, cursor);
  if (longitudeEnd === null) return fail();
  cursor = skipWhitespace(input, longitudeEnd);

  while (input[cursor] === ",") {
    cursor = skipWhitespace(input, cursor + 1);
    const keyEnd = scanIdentifierKey(input, cursor);
    if (keyEnd === null) return fail();
    cursor = skipWhitespace(input, keyEnd);
    if (input[cursor] !== ":") return fail();
    cursor = skipWhitespace(input, cursor + 1);
    const valueStart = cursor;
    while (
      cursor < input.length &&
      input[cursor] !== "," &&
      input[cursor] !== "}"
    ) {
      cursor += 1;
    }
    if (cursor === valueStart) return fail();
    cursor = skipWhitespace(input, cursor);
  }

  return input[cursor] === "}" ? { matched: true, end: cursor + 1 } : fail();
}

function redactCoordsBlocks(input: string): string {
  let searchFrom = 0;
  let copiedThrough = 0;
  let output = "";
  let matchedAny = false;
  while (searchFrom < input.length) {
    const start = input.indexOf(COORDS_MARKER, searchFrom);
    if (start === -1) break;
    const scan = scanCoordsBlock(input, start);
    if (!scan.matched) {
      // Monotonic cursor: never re-walk a failed candidate span, so total
      // work stays linear even with many overlapping malformed candidates.
      searchFrom = Math.max(start + COORDS_MARKER.length, scan.resumeAt);
      continue;
    }
    matchedAny = true;
    output += `${input.slice(copiedThrough, start)}[REDACTED_GEO]`;
    copiedThrough = scan.end;
    searchFrom = scan.end;
  }
  return matchedAny ? output + input.slice(copiedThrough) : input;
}

/** Depth cap bounds containers, not string leaves (a string at depth 9 is kept). */
export const MAX_REDACT_DEPTH = 8;
export const REDACT_CYCLE_SENTINEL = "[Circular]";
export const REDACT_DEPTH_SENTINEL = "[MaxDepth]";
/** Emitted when the work/size budget or hostile reflection stopped the walk. */
export const REDACT_BUDGET_SENTINEL = "[Bounded]";
/** Prior-head sentinel; still treated as degraded so old disk rows are not served. */
export const REDACT_BOUNDED_SENTINEL = "[REDACTED_BOUNDED]";

const DEGRADED_SENTINELS: ReadonlySet<string> = new Set([
  REDACT_CYCLE_SENTINEL,
  REDACT_DEPTH_SENTINEL,
  REDACT_BUDGET_SENTINEL,
  REDACT_BOUNDED_SENTINEL,
]);

function sentinelFor(reason: BoundedWalkRejection): string {
  if (reason === "cycle") return REDACT_CYCLE_SENTINEL;
  if (reason === "depth") return REDACT_DEPTH_SENTINEL;
  return REDACT_BUDGET_SENTINEL;
}

function snapshotEnvCredentials(): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_NAME.test(key)) continue;
    if (typeof value !== "string" || value.length < 8) continue;
    out.push(value);
  }
  return out;
}

function redactString(input: string, envValues: string[]): string {
  let out = redactCoordsBlocks(input);
  for (const pattern of GEO_PATTERNS) {
    out = out.replace(pattern, "[REDACTED_GEO]");
  }
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, `<REDACTED:${label}>`);
  }
  for (const credValue of envValues) {
    if (!credValue) continue;
    const escaped = credValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "<REDACTED:env-secret>");
  }
  return out;
}

/**
 * True when a value carries a degradation sentinel, or when the bounded walk
 * itself refuses it (cycle, budget exhaustion, accessor, hostile reflection).
 * Such a value must never be persisted or served as a successful hit.
 */
export function isRedactionDegraded(value: unknown): boolean {
  let degraded = false;
  const result = boundedWalk(value, {
    strictPrimitives: false,
    transformString: (input) => {
      if (DEGRADED_SENTINELS.has(input)) degraded = true;
      return input;
    },
  });
  return degraded || !result.ok;
}

export const defaultPrivacyRedactor: PrivacyRedactor = (value) => {
  const envValues = snapshotEnvCredentials();
  const result = boundedWalk(value, {
    limits: { maxDepth: MAX_REDACT_DEPTH },
    strictPrimitives: false,
    transformString: (input) => redactString(input, envValues),
    substitute: sentinelFor,
  });
  // `substitute` is set, so the walk always succeeds.
  return result.ok ? result.value : REDACT_BUDGET_SENTINEL;
};
