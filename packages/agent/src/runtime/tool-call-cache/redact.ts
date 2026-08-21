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
 */

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

function scanCoordsBlock(input: string, start: number): number | null {
  let cursor = skipWhitespace(input, start + COORDS_MARKER.length);
  if (input[cursor] !== ":") return null;
  cursor = skipWhitespace(input, cursor + 1);
  if (input[cursor] !== "{") return null;
  cursor = skipWhitespace(input, cursor + 1);
  if (!input.startsWith(LATITUDE_MARKER, cursor)) return null;
  cursor = skipWhitespace(input, cursor + LATITUDE_MARKER.length);
  if (input[cursor] !== ":") return null;
  cursor = skipWhitespace(input, cursor + 1);
  const latitudeEnd = scanNumber(input, cursor);
  if (latitudeEnd === null) return null;
  cursor = skipWhitespace(input, latitudeEnd);
  if (input[cursor] !== ",") return null;
  cursor = skipWhitespace(input, cursor + 1);
  if (!input.startsWith(LONGITUDE_MARKER, cursor)) return null;
  cursor = skipWhitespace(input, cursor + LONGITUDE_MARKER.length);
  if (input[cursor] !== ":") return null;
  cursor = skipWhitespace(input, cursor + 1);
  const longitudeEnd = scanNumber(input, cursor);
  if (longitudeEnd === null) return null;
  cursor = skipWhitespace(input, longitudeEnd);

  while (input[cursor] === ",") {
    cursor = skipWhitespace(input, cursor + 1);
    const keyEnd = scanIdentifierKey(input, cursor);
    if (keyEnd === null) return null;
    cursor = skipWhitespace(input, keyEnd);
    if (input[cursor] !== ":") return null;
    cursor = skipWhitespace(input, cursor + 1);
    const valueStart = cursor;
    while (
      cursor < input.length &&
      input[cursor] !== "," &&
      input[cursor] !== "}"
    ) {
      cursor += 1;
    }
    if (cursor === valueStart) return null;
    cursor = skipWhitespace(input, cursor);
  }

  return input[cursor] === "}" ? cursor + 1 : null;
}

function redactCoordsBlocks(input: string): string {
  let searchFrom = 0;
  let copiedThrough = 0;
  let output = "";
  while (searchFrom < input.length) {
    const start = input.indexOf(COORDS_MARKER, searchFrom);
    if (start === -1) break;
    const end = scanCoordsBlock(input, start);
    if (end === null) {
      searchFrom = start + COORDS_MARKER.length;
      continue;
    }
    output += `${input.slice(copiedThrough, start)}[REDACTED_GEO]`;
    copiedThrough = end;
    searchFrom = end;
  }
  return copiedThrough === 0 ? input : output + input.slice(copiedThrough);
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

function walk(value: unknown, envValues: string[]): unknown {
  if (typeof value === "string") {
    return redactString(value, envValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, envValues));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = walk(obj[key], envValues);
    }
    return out;
  }
  return value;
}

export const defaultPrivacyRedactor: PrivacyRedactor = (value) => {
  const envValues = snapshotEnvCredentials();
  return walk(value, envValues);
};
