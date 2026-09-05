/**
 * provider-action.ts — the `github.provider-action.v1` canonicalization profile.
 *
 * This module owns the governed-provider canonicalization contract:
 *   - a strict, in-house RFC 8785 (JCS) serializer (Conflict 13, RATIFIED: no new
 *     runtime dependency, reject non-JSON runtime values, never coerce);
 *   - the canonical action object + digest (`actionDigest`);
 *   - the request envelope + digest (`requestHash`);
 *   - strict parsers for method, origin, path, query, headers, JSON body and
 *     numbers that FAIL CLOSED on every ambiguity (~70 deny classes);
 *   - stable error codes (`CanonError`) that map to deny, never to a thrown 500.
 *
 * SECURITY POSTURE. Every function here is on the attack surface. The single
 * invariant that matters: an input that is not provably, unambiguously safe is
 * REJECTED with a stable code. We never normalize an unsafe input into a safe
 * one, never coerce a runtime value, never silently collapse a duplicate. The
 * EVM `canonicalJsonStringify` helper in execution-payload.ts is deliberately
 * NOT reused here (it coerces bigint/Date and drops undefined — see Conflict 13).
 *
 * Callers MUST treat a thrown {@link CanonError} as a deny with its `.code`.
 * Any OTHER thrown value from this module is a bug; the service maps it to a
 * generic evaluator-error deny before persistence.
 */

import { createHash } from "node:crypto";
import { containsAsciiControl } from "./text-boundaries";

// ─────────────────────────────────────────────────────────────────────────────
// Error model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete, stable set of canonicalization / request-shape deny codes.
 * These strings are a wire contract: they appear in decision rows, audit
 * events, and (collapsed where existence-sensitive) public responses. Never
 * rename an existing code; only add.
 */
export const CANON_ERROR_CODES = [
  // request envelope / transport
  "CANON_REQUEST_CONTENT_TYPE_UNSUPPORTED",
  "CANON_REQUEST_TOO_LARGE",
  "CANON_INVALID_UTF8",
  "CANON_JSON_SYNTAX_INVALID",
  "CANON_JSON_DUPLICATE_KEY",
  "CANON_JSON_FORBIDDEN_KEY",
  "CANON_JSON_SHAPE_INVALID",
  "CANON_UNKNOWN_FIELD",
  "CANON_REQUIRED_FIELD_MISSING",
  "CANON_FIELD_TYPE_INVALID",
  "CANON_UNICODE_INVALID",
  "CANON_PROFILE_UNSUPPORTED",
  // method
  "CANON_METHOD_INVALID",
  "CANON_METHOD_UNSUPPORTED",
  // origin
  "CANON_ORIGIN_INVALID",
  "CANON_ORIGIN_SCHEME_UNSUPPORTED",
  "CANON_ORIGIN_HOST_INVALID",
  "CANON_ORIGIN_NOT_ALLOWED",
  "CANON_ORIGIN_PORT_UNSUPPORTED",
  // path
  "CANON_PATH_INVALID",
  "CANON_PATH_FORBIDDEN_BYTE",
  "CANON_PATH_EMPTY_SEGMENT",
  "CANON_PATH_TRAVERSAL",
  "CANON_PATH_PERCENT_INVALID",
  "CANON_PATH_ENCODED_AMBIGUITY",
  "CANON_PATH_SEGMENT_INVALID",
  // query
  "CANON_QUERY_SHAPE_INVALID",
  "CANON_QUERY_NAME_EMPTY",
  "CANON_QUERY_VALUE_INVALID",
  "CANON_QUERY_SYNTAX_AMBIGUOUS",
  "CANON_QUERY_PERCENT_INVALID",
  "CANON_QUERY_DUPLICATE_KEY",
  "CANON_QUERY_KEY_UNSUPPORTED",
  "CANON_QUERY_VALUE_OUT_OF_RANGE",
  // headers
  "CANON_HEADER_INVALID",
  "CANON_HEADER_DUPLICATE",
  "CANON_HEADER_UNSUPPORTED",
  "CANON_HEADER_CREDENTIAL_FORBIDDEN",
  "CANON_ACCEPT_INVALID",
  "CANON_CONDITIONAL_HEADER_INVALID",
  "CANON_GITHUB_VERSION_INVALID",
  // body / content-type
  "CANON_BODY_FORBIDDEN",
  "CANON_BODY_REQUIRED",
  "CANON_BODY_CONTENT_TYPE_REQUIRED",
  "CANON_BODY_CONTENT_TYPE_UNSUPPORTED",
  "CANON_BODY_CONTENT_TYPE_INVALID",
  "CANON_BODY_ENCODING_UNSUPPORTED",
  // numbers / decimals / runtime
  "CANON_NUMBER_FORMAT_UNSUPPORTED",
  "CANON_NUMBER_UNSAFE",
  "CANON_DECIMAL_STRING_INVALID",
  "CANON_RUNTIME_VALUE_UNSUPPORTED",
  // serializer
  "CANON_JCS_FAILED",
] as const;

export type CanonErrorCode = (typeof CANON_ERROR_CODES)[number];

/** Default public HTTP status per code. */
const CANON_ERROR_HTTP: Record<CanonErrorCode, number> = {
  CANON_REQUEST_CONTENT_TYPE_UNSUPPORTED: 415,
  CANON_REQUEST_TOO_LARGE: 413,
  CANON_INVALID_UTF8: 400,
  CANON_JSON_SYNTAX_INVALID: 400,
  CANON_JSON_DUPLICATE_KEY: 400,
  CANON_JSON_FORBIDDEN_KEY: 400,
  CANON_JSON_SHAPE_INVALID: 400,
  CANON_UNKNOWN_FIELD: 400,
  CANON_REQUIRED_FIELD_MISSING: 400,
  CANON_FIELD_TYPE_INVALID: 400,
  CANON_UNICODE_INVALID: 400,
  CANON_PROFILE_UNSUPPORTED: 400,
  CANON_METHOD_INVALID: 400,
  CANON_METHOD_UNSUPPORTED: 400,
  CANON_ORIGIN_INVALID: 400,
  CANON_ORIGIN_SCHEME_UNSUPPORTED: 400,
  CANON_ORIGIN_HOST_INVALID: 400,
  CANON_ORIGIN_NOT_ALLOWED: 403,
  CANON_ORIGIN_PORT_UNSUPPORTED: 400,
  CANON_PATH_INVALID: 400,
  CANON_PATH_FORBIDDEN_BYTE: 400,
  CANON_PATH_EMPTY_SEGMENT: 400,
  CANON_PATH_TRAVERSAL: 400,
  CANON_PATH_PERCENT_INVALID: 400,
  CANON_PATH_ENCODED_AMBIGUITY: 400,
  CANON_PATH_SEGMENT_INVALID: 400,
  CANON_QUERY_SHAPE_INVALID: 400,
  CANON_QUERY_NAME_EMPTY: 400,
  CANON_QUERY_VALUE_INVALID: 400,
  CANON_QUERY_SYNTAX_AMBIGUOUS: 400,
  CANON_QUERY_PERCENT_INVALID: 400,
  CANON_QUERY_DUPLICATE_KEY: 400,
  CANON_QUERY_KEY_UNSUPPORTED: 400,
  CANON_QUERY_VALUE_OUT_OF_RANGE: 400,
  CANON_HEADER_INVALID: 400,
  CANON_HEADER_DUPLICATE: 400,
  CANON_HEADER_UNSUPPORTED: 400,
  CANON_HEADER_CREDENTIAL_FORBIDDEN: 403,
  CANON_ACCEPT_INVALID: 400,
  CANON_CONDITIONAL_HEADER_INVALID: 400,
  CANON_GITHUB_VERSION_INVALID: 400,
  CANON_BODY_FORBIDDEN: 400,
  CANON_BODY_REQUIRED: 400,
  CANON_BODY_CONTENT_TYPE_REQUIRED: 415,
  CANON_BODY_CONTENT_TYPE_UNSUPPORTED: 415,
  CANON_BODY_CONTENT_TYPE_INVALID: 415,
  CANON_BODY_ENCODING_UNSUPPORTED: 415,
  CANON_NUMBER_FORMAT_UNSUPPORTED: 400,
  CANON_NUMBER_UNSAFE: 400,
  CANON_DECIMAL_STRING_INVALID: 400,
  CANON_RUNTIME_VALUE_UNSUPPORTED: 400,
  CANON_JCS_FAILED: 400,
};

/** A deny with a stable code. Callers convert this to a decision, never a 500. */
export class CanonError extends Error {
  readonly code: CanonErrorCode;
  readonly httpStatus: number;
  constructor(code: CanonErrorCode, message?: string) {
    super(message ?? code);
    this.name = "CanonError";
    this.code = code;
    this.httpStatus = CANON_ERROR_HTTP[code];
  }
}

function fail(code: CanonErrorCode, message?: string): never {
  throw new CanonError(code, message);
}

export function isCanonError(e: unknown): e is CanonError {
  return e instanceof CanonError;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON value model (post-parse). Only these node kinds exist after strictParseJson.
// ─────────────────────────────────────────────────────────────────────────────

export type JsonValue =
  | null
  | boolean
  | string
  | JsonInteger
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A JSON integer. The profile (section 3.8) permits only safe integers with no
 * decimal, exponent, leading zero, plus sign, or negative zero. We carry the
 * numeric value; JCS re-emits it via the integer rule below.
 */
export type JsonInteger = number;

export const MAX_SAFE_JSON_INT = 9007199254740991; // 2^53 - 1
export const MIN_SAFE_JSON_INT = -9007199254740991;

// ─────────────────────────────────────────────────────────────────────────────
// Strict JSON tokenizer / parser
//
// We CANNOT use JSON.parse as the authority parser: it silently overwrites
// duplicate keys (Conflict 10) and accepts numbers we must reject. This is a
// bespoke recursive-descent parser over a UTF-8 string that:
//   - rejects duplicate member names at EVERY depth (CANON_JSON_DUPLICATE_KEY);
//   - rejects `__proto__`/`constructor`/`prototype` member names at EVERY depth
//     (CANON_JSON_FORBIDDEN_KEY) — plain assignment would replace the result's
//     prototype or silently drop the member instead of creating an own key;
//   - rejects the profile-forbidden number lexemes (decimals/exp/leading-zero/-0);
//   - rejects trailing tokens, comments, trailing commas, BOM;
//   - rejects lone surrogates in strings (CANON_UNICODE_INVALID);
//   - produces only JsonValue nodes.
// The input is a JS string that the caller obtained by strict UTF-8 decoding of
// bounded raw bytes (so invalid UTF-8 / BOM are already rejected upstream).
// ─────────────────────────────────────────────────────────────────────────────

class JsonScanner {
  private i = 0;
  constructor(private readonly s: string) {}

  parseTopLevel(): JsonValue {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i !== this.s.length)
      fail("CANON_JSON_SYNTAX_INVALID", "trailing content after JSON");
    return v;
  }

  private ws(): void {
    // RFC 8259 whitespace only: space, tab, LF, CR. No comments.
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  private value(): JsonValue {
    if (this.i >= this.s.length)
      fail("CANON_JSON_SYNTAX_INVALID", "unexpected end of input");
    const c = this.s[this.i];
    switch (c) {
      case "{":
        return this.object();
      case "[":
        return this.array();
      case '"':
        return this.string();
      case "t":
      case "f":
        return this.bool();
      case "n":
        return this.nullLit();
      default:
        if (c === "-" || (c >= "0" && c <= "9")) return this.number();
        fail("CANON_JSON_SYNTAX_INVALID", `unexpected character '${c}'`);
    }
  }

  private object(): { [k: string]: JsonValue } {
    this.expect("{");
    const out: { [k: string]: JsonValue } = {};
    const seen = new Set<string>();
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"')
        fail("CANON_JSON_SYNTAX_INVALID", "expected object key string");
      const key = this.string();
      // Prototype-pollution guard: a member named `__proto__` never becomes an
      // own property under plain assignment (an object value REPLACES the
      // result's prototype; a primitive is silently dropped), and
      // `constructor`/`prototype` reads follow the prototype chain. These keys
      // are ambiguous across JS consumer patterns, so reject them outright
      // instead of silently collapsing them.
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        fail(
          "CANON_JSON_FORBIDDEN_KEY",
          `forbidden object key ${JSON.stringify(key)}`,
        );
      }
      if (seen.has(key))
        fail(
          "CANON_JSON_DUPLICATE_KEY",
          `duplicate key ${JSON.stringify(key)}`,
        );
      seen.add(key);
      this.ws();
      this.expect(":");
      this.ws();
      out[key] = this.value();
      this.ws();
      const ch = this.s[this.i];
      if (ch === ",") {
        this.i++;
        // trailing comma before } is rejected because next iteration expects a key string
        continue;
      }
      if (ch === "}") {
        this.i++;
        return out;
      }
      fail("CANON_JSON_SYNTAX_INVALID", "expected ',' or '}' in object");
    }
  }

  private array(): JsonValue[] {
    this.expect("[");
    const out: JsonValue[] = [];
    this.ws();
    if (this.s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value());
      this.ws();
      const ch = this.s[this.i];
      if (ch === ",") {
        this.i++;
        continue;
      }
      if (ch === "]") {
        this.i++;
        return out;
      }
      fail("CANON_JSON_SYNTAX_INVALID", "expected ',' or ']' in array");
    }
  }

  private string(): string {
    this.expect('"');
    let out = "";
    for (;;) {
      if (this.i >= this.s.length)
        fail("CANON_JSON_SYNTAX_INVALID", "unterminated string");
      const c = this.s[this.i];
      const code = this.s.charCodeAt(this.i);
      if (c === '"') {
        this.i++;
        // Validate no lone surrogates survived (they should not, since input
        // was strict-UTF-8-decoded, but escapes below can inject them).
        assertNoLoneSurrogate(out);
        return out;
      }
      if (code < 0x20)
        fail(
          "CANON_JSON_SYNTAX_INVALID",
          "unescaped control character in string",
        );
      if (c === "\\") {
        this.i++;
        out += this.escape();
        continue;
      }
      out += c;
      this.i++;
    }
  }

  private escape(): string {
    const c = this.s[this.i];
    this.i++;
    switch (c) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const cp = this.hex4();
        // surrogate handling: high surrogate must be followed by \u low surrogate
        if (cp >= 0xd800 && cp <= 0xdbff) {
          if (this.s[this.i] === "\\" && this.s[this.i + 1] === "u") {
            this.i += 2;
            const lo = this.hex4();
            if (lo < 0xdc00 || lo > 0xdfff)
              fail("CANON_UNICODE_INVALID", "invalid low surrogate");
            const combined = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
            return String.fromCodePoint(combined);
          }
          fail("CANON_UNICODE_INVALID", "lone high surrogate escape");
        }
        if (cp >= 0xdc00 && cp <= 0xdfff)
          fail("CANON_UNICODE_INVALID", "lone low surrogate escape");
        return String.fromCharCode(cp);
      }
      default:
        fail("CANON_JSON_SYNTAX_INVALID", `invalid escape \\${c}`);
    }
  }

  private hex4(): number {
    if (this.i + 4 > this.s.length)
      fail("CANON_JSON_SYNTAX_INVALID", "truncated \\u escape");
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const d = this.s.charCodeAt(this.i + k);
      let nibble: number;
      if (d >= 0x30 && d <= 0x39) nibble = d - 0x30;
      else if (d >= 0x61 && d <= 0x66) nibble = d - 0x61 + 10;
      else if (d >= 0x41 && d <= 0x46) nibble = d - 0x41 + 10;
      else fail("CANON_JSON_SYNTAX_INVALID", "invalid hex in \\u escape");
      v = (v << 4) | nibble;
    }
    this.i += 4;
    return v;
  }

  private bool(): boolean {
    if (this.s.startsWith("true", this.i)) {
      this.i += 4;
      return true;
    }
    if (this.s.startsWith("false", this.i)) {
      this.i += 5;
      return false;
    }
    fail("CANON_JSON_SYNTAX_INVALID", "invalid literal");
  }

  private nullLit(): null {
    if (this.s.startsWith("null", this.i)) {
      this.i += 4;
      return null;
    }
    fail("CANON_JSON_SYNTAX_INVALID", "invalid literal");
  }

  private number(): JsonInteger {
    const start = this.i;
    if (this.s[this.i] === "-") this.i++;
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      // Consume any lexeme character that could belong to a JSON number so we
      // can inspect and REJECT the profile-forbidden shapes with a precise code.
      if (
        (c >= 0x30 && c <= 0x39) ||
        c === 0x2e ||
        c === 0x65 ||
        c === 0x45 ||
        c === 0x2b ||
        c === 0x2d
      )
        this.i++;
      else break;
    }
    const lexeme = this.s.slice(start, this.i);
    return parseStrictInteger(lexeme);
  }

  private expect(ch: string): void {
    if (this.s[this.i] !== ch)
      fail("CANON_JSON_SYNTAX_INVALID", `expected '${ch}'`);
    this.i++;
  }
}

/**
 * Parse and validate a JSON *integer* lexeme against the profile's number rule
 * (section 3.8): `0 | -?[1-9][0-9]*`, no decimal/exponent/leading-zero/plus/-0,
 * within the safe-integer range.
 */
export function parseStrictInteger(lexeme: string): JsonInteger {
  if (lexeme.includes(".") || lexeme.includes("e") || lexeme.includes("E"))
    fail(
      "CANON_NUMBER_FORMAT_UNSUPPORTED",
      `non-integer number lexeme '${lexeme}'`,
    );
  if (lexeme.includes("+"))
    fail("CANON_NUMBER_FORMAT_UNSUPPORTED", "leading plus not allowed");
  // integer grammar: 0 | -?[1-9][0-9]*
  if (!/^(0|-?[1-9][0-9]*)$/.test(lexeme))
    fail(
      "CANON_NUMBER_FORMAT_UNSUPPORTED",
      `invalid integer lexeme '${lexeme}'`,
    );
  if (lexeme === "-0")
    fail("CANON_NUMBER_FORMAT_UNSUPPORTED", "negative zero not allowed");
  const n = Number(lexeme);
  if (!Number.isSafeInteger(n))
    fail("CANON_NUMBER_UNSAFE", `integer out of safe range '${lexeme}'`);
  return n;
}

/** Detect a lone UTF-16 surrogate in a decoded JS string. */
function assertNoLoneSurrogate(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        fail("CANON_UNICODE_INVALID", "lone high surrogate");
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      fail("CANON_UNICODE_INVALID", "lone low surrogate");
    }
  }
}

/**
 * Strict-parse a UTF-8 JSON *string* into a JsonValue tree. Rejects BOM,
 * duplicate keys at any depth, forbidden number lexemes, trailing content.
 */
export function strictParseJson(text: string): JsonValue {
  if (text.charCodeAt(0) === 0xfeff)
    fail("CANON_INVALID_UTF8", "BOM not allowed");
  return new JsonScanner(text).parseTopLevel();
}

/**
 * Strict-decode bounded raw UTF-8 bytes to a JS string. Rejects invalid UTF-8
 * and a byte-order mark. Uses a fatal TextDecoder so overlong / truncated /
 * surrogate byte sequences throw rather than producing U+FFFD.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  )
    fail("CANON_INVALID_UTF8", "UTF-8 BOM not allowed");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    fail("CANON_INVALID_UTF8", "invalid UTF-8");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC 8785 JCS serializer (strict, in-house)
//
// Accepts ONLY the JsonValue node kinds produced by strictParseJson, plus the
// canonical action/envelope objects we build ourselves. REJECTS every runtime
// value that is not a legal JSON value (undefined, NaN, Infinity, bigint,
// function, symbol, Date, Map, Set, non-plain prototype, sparse hole, getter
// side effects) with CANON_RUNTIME_VALUE_UNSUPPORTED — it never coerces.
// ─────────────────────────────────────────────────────────────────────────────

const PLAIN_OBJECT_PROTOS: ReadonlyArray<unknown> = [Object.prototype, null];

/**
 * Serialize an arbitrary value to RFC 8785 canonical JSON. Throws CanonError on
 * any non-JSON runtime value; throws CANON_JCS_FAILED for unexpected internal
 * failures so the caller still denies rather than 500s.
 */
export function jcsStringify(value: unknown): string {
  try {
    return serializeValue(value);
  } catch (e) {
    if (isCanonError(e)) throw e;
    fail("CANON_JCS_FAILED", e instanceof Error ? e.message : "jcs failure");
  }
}

function serializeValue(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") {
    assertNoLoneSurrogate(v as string);
    return serializeString(v as string);
  }
  if (t === "number") return serializeNumber(v as number);
  if (t === "bigint")
    fail("CANON_RUNTIME_VALUE_UNSUPPORTED", "bigint is not a JSON value");
  if (t === "undefined")
    fail("CANON_RUNTIME_VALUE_UNSUPPORTED", "undefined is not a JSON value");
  if (t === "function" || t === "symbol")
    fail("CANON_RUNTIME_VALUE_UNSUPPORTED", `${t} is not a JSON value`);
  if (t === "object") {
    if (Array.isArray(v)) return serializeArray(v);
    const proto = Object.getPrototypeOf(v);
    if (!PLAIN_OBJECT_PROTOS.includes(proto))
      fail(
        "CANON_RUNTIME_VALUE_UNSUPPORTED",
        "non-plain object (Date/Map/Set/class) not allowed",
      );
    return serializeObject(v as Record<string, unknown>);
  }
  fail("CANON_RUNTIME_VALUE_UNSUPPORTED", `unsupported value type ${t}`);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n))
    fail("CANON_RUNTIME_VALUE_UNSUPPORTED", "NaN/Infinity not a JSON value");
  // We only ever serialize integers in this profile (numbers arrive only via
  // strictParseInteger). Enforce that: a non-integer runtime number is a bug /
  // forbidden value, not something to render with ECMAScript number formatting.
  if (!Number.isSafeInteger(n))
    fail(
      "CANON_RUNTIME_VALUE_UNSUPPORTED",
      "only safe-integer numbers are serialized",
    );
  // Negative zero cannot occur for a safe integer other than 0, and Object.is
  // catches -0.
  if (Object.is(n, -0)) return "0";
  return String(n);
}

function serializeArray(arr: unknown[]): string {
  // Reject sparse holes: a hole reads as undefined but `in` is false.
  const parts: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (!(i in arr))
      fail("CANON_RUNTIME_VALUE_UNSUPPORTED", "sparse array hole not allowed");
    parts.push(serializeValue(arr[i]));
  }
  return `[${parts.join(",")}]`;
}

function serializeObject(obj: Record<string, unknown>): string {
  // Own enumerable string keys only. Sort by UTF-16 code units (RFC 8785).
  const keys = Object.keys(obj).sort(compareUtf16);
  const parts: string[] = [];
  for (const k of keys) {
    // Read via the property descriptor, NOT obj[k]: an accessor property
    // would run user code, and a value-changing getter could desync
    // mint-vs-verify digests. SEC-191: the header contract rejects getter
    // side effects — enforce it instead of invoking them (fail closed).
    const desc = Object.getOwnPropertyDescriptor(obj, k);
    if (!desc || desc.get !== undefined || desc.set !== undefined) {
      fail(
        "CANON_RUNTIME_VALUE_UNSUPPORTED",
        `member '${k}' is an accessor property (getter side effects are rejected)`,
      );
    }
    const val = desc.value;
    // JCS drops nothing: an explicit `undefined` member is a runtime error here
    // (it is not a JSON value). Members we intend to omit must be omitted by the
    // builder, never present-as-undefined.
    if (val === undefined)
      fail("CANON_RUNTIME_VALUE_UNSUPPORTED", `member '${k}' is undefined`);
    parts.push(`${serializeString(k)}:${serializeValue(val)}`);
  }
  return `{${parts.join(",")}}`;
}

/** RFC 8785 requires sorting object keys by their UTF-16 code units. */
function compareUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * ECMAScript / RFC 8785 JSON string escaping. Control chars use the short forms
 * where defined (\b \t \n \f \r), other C0 controls use \u00XX, everything else
 * (including all valid non-control Unicode, no normalization) is emitted as-is.
 */
function serializeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        if (c < 0x20) {
          out += `\\u${c.toString(16).padStart(4, "0")}`;
        } else {
          out += s[i];
        }
    }
  }
  return `${out}"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

/** `sha256:` + lowercase hex of the SHA-256 of the UTF-8 bytes of `text`. */
export function sha256HexPrefixed(input: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
  return `sha256:${h.digest("hex")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical action + envelope
// ─────────────────────────────────────────────────────────────────────────────

export const GITHUB_PROVIDER_ACTION_PROFILE =
  "github.provider-action.v1" as const;
export const PROVIDER_REQUEST_SCHEMA_VERSION =
  "steward.provider-request.v1" as const;
export const PROVIDER_POLICY_INPUT_SCHEMA_VERSION =
  "steward.provider-policy-input.v1" as const;
/**
 * Hash-domain prefix for policy-input replay identity. This keeps a policy-input
 * digest cryptographically distinct from action/request hashes even if a future
 * document happens to serialize to the same bytes.
 */
export const PROVIDER_POLICY_INPUT_HASH_DOMAIN =
  "steward.provider-policy-input.v1\n" as const;
export const CANONICAL_ORIGIN = "https://api.github.com" as const;

export type CanonicalMethod =
  | "GET"
  | "POST"
  | "PATCH"
  | "PUT"
  | "DELETE"
  | "HEAD";
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
  "HEAD",
]);

export interface GithubCanonicalActionV1 {
  profile: typeof GITHUB_PROVIDER_ACTION_PROFILE;
  method: CanonicalMethod;
  origin: string;
  normalizedPath: string;
  orderedQueryPairs: Array<[string, string]>;
  selectedHeaders: Array<[string, string]>;
  canonicalBody: null | JsonValue;
}

export interface ProviderRequestEnvelopeV1 {
  schemaVersion: typeof PROVIDER_REQUEST_SCHEMA_VERSION;
  tenantId: string;
  workspaceId: string;
  actorAgentId: string;
  providerAccountId: string;
  operationId: string;
  operationRevision: number;
  actionDigest: string;
  /**
   * Digest of adapter-validated policy inputs. Optional only so request hashes
   * recorded before this field existed remain reproducible; every newly-created
   * provider request includes it.
   */
  policyInputDigest?: string;
  /** Digest of an authenticated X summon provenance record. The signed record
   * is stored separately in the immutable safe summary; this digest makes it a
   * load-bearing part of requestHash without putting raw post content here. */
  xSummonAttestationDigest?: string;
  idempotencyKeyHash: string;
  requestedAt: string;
  expiresAt: string;
  nonce: string;
}

/**
 * Compute the replay identity for adapter-validated policy inputs.
 *
 * The adapter contract permits only policy-safe JSON values here (never raw
 * credentials or the X `policyText` channel). JCS rejects undefined, non-finite,
 * prototype-bearing, or otherwise unsupported runtime values rather than
 * silently weakening the identity. Only the digest is persisted.
 */
export function computeProviderPolicyInputDigest(
  policyArgs: Readonly<Record<string, unknown>>,
): string {
  const bytes = jcsStringify({
    schemaVersion: PROVIDER_POLICY_INPUT_SCHEMA_VERSION,
    policyArgs,
  });
  return sha256HexPrefixed(`${PROVIDER_POLICY_INPUT_HASH_DOMAIN}${bytes}`);
}

/**
 * Build the JCS-serializable canonical action object. Property order here is
 * irrelevant (JCS re-sorts), but we build it as a plain object so the serializer
 * never sees a class instance.
 */
function toCanonicalActionObject(
  a: GithubCanonicalActionV1,
): Record<string, unknown> {
  return {
    profile: a.profile,
    method: a.method,
    origin: a.origin,
    normalizedPath: a.normalizedPath,
    orderedQueryPairs: a.orderedQueryPairs.map(([n, v]) => [n, v]),
    selectedHeaders: a.selectedHeaders.map(([n, v]) => [n, v]),
    canonicalBody: a.canonicalBody,
  };
}

/** `canonicalActionBytes` as a UTF-8 string (no newline). */
export function canonicalActionBytes(a: GithubCanonicalActionV1): string {
  return jcsStringify(toCanonicalActionObject(a));
}

/** `actionDigest` = sha256: hex of the canonical action bytes. */
export function computeActionDigest(a: GithubCanonicalActionV1): string {
  return sha256HexPrefixed(canonicalActionBytes(a));
}

function toEnvelopeObject(
  e: ProviderRequestEnvelopeV1,
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    schemaVersion: e.schemaVersion,
    tenantId: e.tenantId,
    workspaceId: e.workspaceId,
    actorAgentId: e.actorAgentId,
    providerAccountId: e.providerAccountId,
    operationId: e.operationId,
    operationRevision: e.operationRevision,
    actionDigest: e.actionDigest,
    idempotencyKeyHash: e.idempotencyKeyHash,
    requestedAt: e.requestedAt,
    expiresAt: e.expiresAt,
    nonce: e.nonce,
  };
  // Preserve the byte-for-byte hash of version-1 envelopes without policy inputs.
  if (e.policyInputDigest !== undefined)
    envelope.policyInputDigest = e.policyInputDigest;
  if (e.xSummonAttestationDigest !== undefined)
    envelope.xSummonAttestationDigest = e.xSummonAttestationDigest;
  return envelope;
}

/** `requestHash` = sha256: hex of the JCS of the request envelope. */
export function computeRequestHash(e: ProviderRequestEnvelopeV1): string {
  return sha256HexPrefixed(jcsStringify(toEnvelopeObject(e)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider execution authorization v2 commitment (spec §3)
//
// The v2 authorization is bound by an HMAC over a canonical commitment document
// serialized with the SAME strict RFC 8785 JCS used above (adjudication conflict
// 13 in-house JCS). The commitment binds the exact outbound bytes, the exact
// approval, rotation revisions, and the pinned request line so a claimed
// authorization cannot be replayed against a different route/method/path/header
// profile/secret. `commitmentHash` is a content hash; the HMAC signature is
// domain-separated (§3.1) so a v2 signature can never collide with the v1
// signature payload or an audit HMAC.
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_EXECUTION_COMMITMENT_SCHEMA_VERSION =
  "steward.provider-execution-authorization.v2" as const;

/**
 * Domain-separation prefix mixed into the HMAC input (NOT into commitmentHash).
 * A v2 signature is `HMAC(v2Key, SIG_DOMAIN || JCS(commitment))`; a v1 signature
 * is `HMAC(v1Key, JCS(v1Payload))` with no prefix and a different key, so the two
 * can never be confused (spec §3.1, P12).
 */
export const PROVIDER_EXECUTION_SIGNATURE_DOMAIN =
  "steward.execution-authorization.v2\n" as const;

export interface ProviderExecutionCommitmentTargetV2 {
  scheme: "https";
  host: string;
  port: 443;
  normalizedPath: string;
  method: CanonicalMethod;
}

export interface ProviderExecutionCommitmentV2 {
  schemaVersion: typeof PROVIDER_EXECUTION_COMMITMENT_SCHEMA_VERSION;
  authorizationId: string;
  executionId: string;
  intentId: string;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  actorAgentId: string;
  providerAccountId: string;
  operationId: string;
  operationRevision: number;
  requestHash: string;
  actionDigest: string;
  grantDependencyHash: string;
  policyRevisionHash: string;
  accessDecisionHash: string;
  approvalId: string;
  approvalCommitmentHash: string;
  target: ProviderExecutionCommitmentTargetV2;
  headerAllowlistDigest: string;
  routeId: string;
  routeRevision: number;
  secretId: string;
  secretVersion: number;
  backend: "credential-proxy";
  providerIdempotencyKey: string;
  maxUses: 1;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
}

export interface ProviderExecutionPolicyEvidenceExpectation {
  decisionId: string;
  intentId: string;
  requestHash: string;
  actionDigest: string;
  operationId: string;
  operationKey: string;
  policyRevisionHash: string;
  decidedAt: string;
}

/**
 * Verify the complete execute-time policy evidence before an authorization is
 * minted or claimed. Keeping this check shared prevents the API and proxy
 * boundaries from accepting different evidence shapes during rollout.
 */
export function verifyProviderExecutionPolicyEvidence(
  decision: unknown,
  decisionHash: string | null | undefined,
  expected: ProviderExecutionPolicyEvidenceExpectation,
): boolean {
  if (
    !decision ||
    typeof decision !== "object" ||
    Array.isArray(decision) ||
    !decisionHash
  ) {
    return false;
  }
  const doc = decision as Record<string, unknown>;
  if (
    doc.schemaVersion !== "steward.provider-policy-decision.v1" ||
    doc.decisionId !== expected.decisionId ||
    doc.intentId !== expected.intentId ||
    doc.requestHash !== expected.requestHash ||
    doc.actionDigest !== expected.actionDigest ||
    doc.operationId !== expected.operationId ||
    doc.operationKey !== expected.operationKey ||
    doc.policyRevisionHash !== expected.policyRevisionHash ||
    doc.decidedAt !== expected.decidedAt ||
    typeof doc.evaluatorVersion !== "string" ||
    doc.evaluatorVersion.length === 0 ||
    !Array.isArray(doc.reasonCodes) ||
    doc.reasonCodes.some((code) => typeof code !== "string") ||
    !Array.isArray(doc.policyResults) ||
    (doc.effect !== "allow" && doc.effect !== "approval_required")
  ) {
    return false;
  }
  try {
    return sha256HexPrefixed(jcsStringify(doc)) === decisionHash;
  } catch {
    return false;
  }
}

function toExecutionCommitmentObject(
  c: ProviderExecutionCommitmentV2,
): Record<string, unknown> {
  // Build a plain object graph (no class instances) so the JCS serializer never
  // sees a Date/Map/etc. Property order here is irrelevant (JCS re-sorts).
  return {
    schemaVersion: c.schemaVersion,
    authorizationId: c.authorizationId,
    executionId: c.executionId,
    intentId: c.intentId,
    requestId: c.requestId,
    tenantId: c.tenantId,
    workspaceId: c.workspaceId,
    actorAgentId: c.actorAgentId,
    providerAccountId: c.providerAccountId,
    operationId: c.operationId,
    operationRevision: c.operationRevision,
    requestHash: c.requestHash,
    actionDigest: c.actionDigest,
    grantDependencyHash: c.grantDependencyHash,
    policyRevisionHash: c.policyRevisionHash,
    accessDecisionHash: c.accessDecisionHash,
    approvalId: c.approvalId,
    approvalCommitmentHash: c.approvalCommitmentHash,
    target: {
      scheme: c.target.scheme,
      host: c.target.host,
      port: c.target.port,
      normalizedPath: c.target.normalizedPath,
      method: c.target.method,
    },
    headerAllowlistDigest: c.headerAllowlistDigest,
    routeId: c.routeId,
    routeRevision: c.routeRevision,
    secretId: c.secretId,
    secretVersion: c.secretVersion,
    backend: c.backend,
    providerIdempotencyKey: c.providerIdempotencyKey,
    maxUses: c.maxUses,
    nonce: c.nonce,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    keyId: c.keyId,
  };
}

/** JCS bytes of the v2 commitment (UTF-8 string, no trailing newline). */
export function providerExecutionCommitmentBytes(
  c: ProviderExecutionCommitmentV2,
): string {
  return jcsStringify(toExecutionCommitmentObject(c));
}

/** `commitmentHash` = sha256: hex of JCS(commitment). Content hash, NOT the HMAC. */
export function computeProviderExecutionCommitmentHash(
  c: ProviderExecutionCommitmentV2,
): string {
  return sha256HexPrefixed(providerExecutionCommitmentBytes(c));
}

/**
 * Domain-separated signature input: `SIG_DOMAIN || JCS(commitment)`. The caller
 * HMACs this with the v2-derived key. Kept in @stwd/shared so the (future) proxy
 * verifier and the API minter agree on the exact bytes.
 */
export function providerExecutionSignatureInput(
  c: ProviderExecutionCommitmentV2,
): string {
  return `${PROVIDER_EXECUTION_SIGNATURE_DOMAIN}${providerExecutionCommitmentBytes(c)}`;
}

/**
 * sha256: hex of JCS of the sorted selected-header name set from a canonical
 * action. Binds the outbound header profile into the commitment so a claimed
 * authorization cannot be replayed with a different header set (P31/P32/P33).
 * Only header NAMES are committed (values are already in the actionDigest); the
 * injected credential header is never among selectedHeaders.
 */
export function computeHeaderAllowlistDigest(
  action: GithubCanonicalActionV1,
): string {
  const names = action.selectedHeaders
    .map(([name]) => name)
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256HexPrefixed(jcsStringify(names));
}

// Deterministic v2 commitment builder, grant-dependency hash, and outbound
// query serialization. These are PURE (no DB, no crypto key) so the API minter
// and the separate-process proxy verifier reconstruct the SAME commitment bytes
// from the same persisted approval commitment and canonical action.

/**
 * Deterministic grant/binding dependency hash. Binds the EXACT matched
 * grant/binding ids and revisions the access decision committed, so a revoked or
 * re-revised grant fails the claim (X5, P15). Arrays are sorted by uuid bytes
 * (same rule as the approval commitment) then JCS-serialized.
 */
export function computeGrantDependencyHash(access: {
  matchedBindings: ReadonlyArray<{ id: string; revision: number }>;
  matchedGrants: ReadonlyArray<{ id: string; revision: number }>;
}): string {
  const byUuid = (a: { id: string }, b: { id: string }): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const doc = {
    matchedBindings: [...access.matchedBindings]
      .sort(byUuid)
      .map((b) => ({ id: b.id, revision: b.revision })),
    matchedGrants: [...access.matchedGrants]
      .sort(byUuid)
      .map((g) => ({ id: g.id, revision: g.revision })),
  };
  return sha256HexPrefixed(jcsStringify(doc));
}

/**
 * Serialize canonical `orderedQueryPairs` into an outbound query string (WITHOUT
 * the leading `?`) using the canonical RFC 3986 encoding rule (uppercase percent hex,
 * `%20` not `+`). Duplicate keys and order are preserved exactly. Empty list ->
 * "". This is the ONLY governed query source (spec section 5.4): the proxy
 * rebuilds the outbound query from these canonical pairs, never from a raw stored
 * string.
 */
export function serializeCanonicalOutboundQuery(
  orderedQueryPairs: ReadonlyArray<readonly [string, string]>,
): string {
  return orderedQueryPairs
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
}

/** Inputs to reconstruct a v2 commitment from the persisted approval commitment. */
export interface ProviderExecutionCommitmentBuildInput {
  approval: {
    intentId: string;
    tenantId: string;
    workspaceId: string;
    requestActor: { id: string };
    providerAccount: { id: string };
    operation: { id: string; revision: number };
    requestHash: string;
    actionDigest: string;
    accessDecision: {
      id: string;
      hash: string;
      matchedBindings: ReadonlyArray<{ id: string; revision: number }>;
      matchedGrants: ReadonlyArray<{ id: string; revision: number }>;
    };
    policyDecision: { policyRevisionHash: string };
    executionDependencies: {
      routeId: string;
      routeRevision: number;
      secretId: string;
      secretVersion: number;
    };
  };
  action: GithubCanonicalActionV1;
  approvalCommitmentHash: string;
  approvalId: string;
  authorizationId: string;
  executionId: string;
  requestId: string;
  providerIdempotencyKey: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
}

/**
 * Reconstruct the exact v2 commitment document from an approval commitment,
 * canonical action, and mint parameters. Both the API mint and proxy claim call
 * this so the commitment bytes (and thus `commitmentHash` and the HMAC) are
 * byte-identical on both sides. `target` and `headerAllowlistDigest` come from
 * the canonical action (pinned origin host, normalized path, method, sorted
 * selected-header names); everything else comes from the committed approval so a
 * drifted dependency changes the hash (X5).
 */
export function buildProviderExecutionCommitmentV2(
  input: ProviderExecutionCommitmentBuildInput,
): ProviderExecutionCommitmentV2 {
  const host = new URL(input.action.origin).host;
  return {
    schemaVersion: PROVIDER_EXECUTION_COMMITMENT_SCHEMA_VERSION,
    authorizationId: input.authorizationId,
    executionId: input.executionId,
    intentId: input.approval.intentId,
    requestId: input.requestId,
    tenantId: input.approval.tenantId,
    workspaceId: input.approval.workspaceId,
    actorAgentId: input.approval.requestActor.id,
    providerAccountId: input.approval.providerAccount.id,
    operationId: input.approval.operation.id,
    operationRevision: input.approval.operation.revision,
    requestHash: input.approval.requestHash,
    actionDigest: input.approval.actionDigest,
    grantDependencyHash: computeGrantDependencyHash(
      input.approval.accessDecision,
    ),
    policyRevisionHash: input.approval.policyDecision.policyRevisionHash,
    accessDecisionHash: input.approval.accessDecision.hash,
    approvalId: input.approvalId,
    approvalCommitmentHash: input.approvalCommitmentHash,
    target: {
      scheme: "https",
      host,
      port: 443,
      normalizedPath: input.action.normalizedPath,
      method: input.action.method,
    },
    headerAllowlistDigest: computeHeaderAllowlistDigest(input.action),
    routeId: input.approval.executionDependencies.routeId,
    routeRevision: input.approval.executionDependencies.routeRevision,
    secretId: input.approval.executionDependencies.secretId,
    secretVersion: input.approval.executionDependencies.secretVersion,
    backend: "credential-proxy",
    providerIdempotencyKey: input.providerIdempotencyKey,
    maxUses: 1,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    keyId: input.keyId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Method canonicalization (section 3.3)
// ─────────────────────────────────────────────────────────────────────────────

export function canonicalizeMethod(raw: string): CanonicalMethod {
  if (typeof raw !== "string" || raw.length === 0)
    fail("CANON_METHOD_INVALID", "method must be a non-empty string");
  // No trimming. Must be an ASCII token with no whitespace.
  if (!/^[A-Za-z]+$/.test(raw))
    fail("CANON_METHOD_INVALID", `invalid method token '${raw}'`);
  const upper = raw.toUpperCase();
  if (!ALLOWED_METHODS.has(upper))
    fail("CANON_METHOD_UNSUPPORTED", `method not supported '${upper}'`);
  return upper as CanonicalMethod;
}

// ─────────────────────────────────────────────────────────────────────────────
// Origin canonicalization (section 3.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a raw origin string to the canonical `https://api.github.com`, or
 * deny. IDNA is deliberately NOT performed. Only scheme/host ASCII-lowercasing,
 * one terminal DNS-dot removal, explicit :443 omission, and empty-or-`/` path.
 */
export function canonicalizeOrigin(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0)
    fail("CANON_ORIGIN_INVALID", "origin must be a non-empty string");
  // Reject embedded control/space/NUL up front.
  if (containsAsciiControl(raw) || raw.includes(" "))
    fail("CANON_ORIGIN_INVALID", "control/space in origin");

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (!schemeMatch) fail("CANON_ORIGIN_INVALID", "origin missing scheme://");
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme !== "https")
    fail("CANON_ORIGIN_SCHEME_UNSUPPORTED", `scheme '${scheme}' not https`);

  const rest = raw.slice(schemeMatch[0].length);
  // Reject userinfo, query, fragment anywhere.
  if (rest.includes("@")) fail("CANON_ORIGIN_INVALID", "userinfo not allowed");
  if (rest.includes("?"))
    fail("CANON_ORIGIN_INVALID", "query not allowed in origin");
  if (rest.includes("#"))
    fail("CANON_ORIGIN_INVALID", "fragment not allowed in origin");

  // Split host[:port] from an optional trailing path.
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash);
  if (path !== "" && path !== "/")
    fail("CANON_ORIGIN_INVALID", "origin path must be empty or '/'");

  // Reject bracketed IPv6 literals before port parsing (the ':' inside brackets
  // would otherwise be misread as a port separator).
  if (authority.includes("[") || authority.includes("]"))
    fail("CANON_ORIGIN_HOST_INVALID", "IP literal host");

  // Port handling: only explicit :443 permitted, and it is dropped.
  let host = authority;
  const colon = authority.lastIndexOf(":");
  if (colon !== -1) {
    const portStr = authority.slice(colon + 1);
    host = authority.slice(0, colon);
    if (!/^[0-9]+$/.test(portStr))
      fail("CANON_ORIGIN_PORT_UNSUPPORTED", "invalid port");
    if (portStr !== "443")
      fail("CANON_ORIGIN_PORT_UNSUPPORTED", `nondefault port ${portStr}`);
  }

  // Host must be ASCII, may have exactly one terminal dot which we strip.
  if (/%/.test(host))
    fail("CANON_ORIGIN_HOST_INVALID", "percent escape in host");
  if (Array.from(host).some((character) => character.charCodeAt(0) > 0x7f))
    fail("CANON_ORIGIN_HOST_INVALID", "non-ASCII host");
  let h = host.toLowerCase();
  if (h.endsWith(".."))
    fail("CANON_ORIGIN_HOST_INVALID", "multiple terminal dots");
  if (h.endsWith(".")) h = h.slice(0, -1);
  // Reject IP literals (v4 dotted-decimal, or bracketed v6).
  if (h.startsWith("[")) fail("CANON_ORIGIN_HOST_INVALID", "IP literal host");
  if (/^[0-9]+(\.[0-9]+)*$/.test(h))
    fail("CANON_ORIGIN_HOST_INVALID", "numeric/IPv4 host");
  // Validate DNS labels.
  for (const label of h.split(".")) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      fail("CANON_ORIGIN_HOST_INVALID", `invalid DNS label '${label}'`);
  }
  if (h !== "api.github.com")
    fail("CANON_ORIGIN_NOT_ALLOWED", `host '${h}' not allowed`);
  return CANONICAL_ORIGIN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path normalization (section 3.5)
// ─────────────────────────────────────────────────────────────────────────────

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * Normalize a raw ASCII path per section 3.5. Denies traversal, ambiguous
 * percent-encoding, encoded delimiters, backslashes, empty segments, trailing
 * slash (except root). Decodes percent-encoded unreserved bytes (other than `.`)
 * and uppercases remaining allowed escapes. No dot-segment removal or slash
 * collapsing: if normalization would be needed to make an unsafe path safe, deny.
 */
export function normalizePath(raw: string): string {
  if (typeof raw !== "string")
    fail("CANON_PATH_INVALID", "path must be a string");
  if (raw.length === 0 || raw[0] !== "/")
    fail("CANON_PATH_INVALID", "path must begin with '/'");
  if (raw.includes("?") || raw.includes("#"))
    fail("CANON_PATH_INVALID", "path must not contain query/fragment");
  if (raw === "/") return "/";

  // Forbidden raw bytes: control, DEL, space, non-ASCII, backslash.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f)
      fail("CANON_PATH_FORBIDDEN_BYTE", "control/DEL in path");
    if (c === 0x20) fail("CANON_PATH_FORBIDDEN_BYTE", "space in path");
    if (c > 0x7f) fail("CANON_PATH_FORBIDDEN_BYTE", "non-ASCII in path");
    if (c === 0x5c) fail("CANON_PATH_FORBIDDEN_BYTE", "backslash in path");
  }

  if (raw.endsWith("/"))
    fail("CANON_PATH_EMPTY_SEGMENT", "trailing slash not allowed");

  const segments = raw.slice(1).split("/");
  const outSegments: string[] = [];
  for (const seg of segments) {
    if (seg.length === 0)
      fail("CANON_PATH_EMPTY_SEGMENT", "empty path segment ('//')");
    if (seg === "." || seg === "..")
      fail("CANON_PATH_TRAVERSAL", "literal dot segment");
    outSegments.push(normalizePathSegment(seg));
  }
  return `/${outSegments.join("/")}`;
}

function normalizePathSegment(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; ) {
    const c = seg[i];
    if (c === "%") {
      if (i + 2 >= seg.length)
        fail("CANON_PATH_PERCENT_INVALID", "truncated percent escape");
      const hex = seg.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex))
        fail("CANON_PATH_PERCENT_INVALID", `malformed percent escape %${hex}`);
      const byte = Number.parseInt(hex, 16);
      // Encoded dot/slash/backslash/percent/control/DEL/non-ASCII always deny.
      if (
        byte === 0x2e || // .
        byte === 0x2f || // /
        byte === 0x5c || // backslash
        byte === 0x25 || // %
        byte < 0x20 ||
        byte === 0x7f ||
        byte >= 0x80
      )
        fail(
          "CANON_PATH_ENCODED_AMBIGUITY",
          `encoded byte 0x${hex} not allowed`,
        );
      const ch = String.fromCharCode(byte);
      if (UNRESERVED.test(ch)) {
        // Decode unreserved (other than `.`, already denied above).
        out += ch;
      } else {
        // Keep as an escape, uppercased.
        out += `%${hex.toUpperCase()}`;
      }
      i += 3;
      continue;
    }
    // Literal byte. Reserved delimiters may appear literally only where the
    // operation template permits; at the profile layer we accept any ASCII
    // non-forbidden literal (forbidden bytes already rejected in normalizePath).
    out += c;
    i += 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query canonicalization (section 3.6)
// ─────────────────────────────────────────────────────────────────────────────

/** A logical query pair (decoded name/value). */
export type QueryPair = [string, string];

/**
 * Given ALREADY-DECODED logical query pairs, validate and produce the canonical
 * ordered pairs: dedupe (deny duplicates), validate Unicode, sort bytewise by
 * RFC-3986 percent-encoding of name then value. Callers that start from a raw
 * query string must first call {@link parseRawQuery}.
 */
export function canonicalizeQueryPairs(
  pairs: ReadonlyArray<QueryPair>,
): Array<[string, string]> {
  const seen = new Set<string>();
  const validated: QueryPair[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2)
      fail("CANON_QUERY_SHAPE_INVALID", "query pair must be [name,value]");
    const [name, value] = pair;
    if (typeof name !== "string" || typeof value !== "string")
      fail("CANON_QUERY_SHAPE_INVALID", "query name/value must be strings");
    if (name.length === 0) fail("CANON_QUERY_NAME_EMPTY", "empty query name");
    assertQueryScalar(name);
    assertQueryScalar(value);
    if (seen.has(name))
      fail("CANON_QUERY_DUPLICATE_KEY", `duplicate query name '${name}'`);
    seen.add(name);
    validated.push([name, value]);
  }
  validated.sort((a, b) => {
    const an = encodeRfc3986(a[0]);
    const bn = encodeRfc3986(b[0]);
    if (an < bn) return -1;
    if (an > bn) return 1;
    const av = encodeRfc3986(a[1]);
    const bv = encodeRfc3986(b[1]);
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
  return validated.map(([n, v]) => [n, v]);
}

function assertQueryScalar(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x00) fail("CANON_QUERY_VALUE_INVALID", "NUL in query");
    if (c < 0x20 || c === 0x7f)
      fail("CANON_QUERY_VALUE_INVALID", "control/DEL in query");
  }
  assertNoLoneSurrogateCanon(s, "CANON_QUERY_VALUE_INVALID");
}

function assertNoLoneSurrogateCanon(s: string, code: CanonErrorCode): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(code, "lone surrogate");
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      fail(code, "lone surrogate");
    }
  }
}

/**
 * RFC 3986 percent-encoding for query serialization / sort key: UTF-8 bytes,
 * uppercase hex, unescaped `A-Z a-z 0-9 - . _ ~`, space as `%20`, never `+`.
 */
export function encodeRfc3986(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (b < 0x80 && UNRESERVED.test(ch)) out += ch;
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Parse a raw query string (WITHOUT the leading `?`) into logical decoded pairs.
 * Rejects bare keys (no `=`), `;` separators, fragments, `+`-as-space ambiguity
 * (we treat `+` as literal plus, per profile), and invalid percent/UTF-8.
 */
export function parseRawQuery(raw: string): QueryPair[] {
  if (raw.length === 0) return [];
  if (raw.includes("#"))
    fail("CANON_QUERY_SYNTAX_AMBIGUOUS", "fragment in query");
  if (raw.includes(";"))
    fail("CANON_QUERY_SYNTAX_AMBIGUOUS", "semicolon separator in query");
  const out: QueryPair[] = [];
  for (const part of raw.split("&")) {
    if (part.length === 0)
      fail("CANON_QUERY_SYNTAX_AMBIGUOUS", "empty query segment");
    const eq = part.indexOf("=");
    if (eq === -1) fail("CANON_QUERY_SYNTAX_AMBIGUOUS", "bare key without '='");
    if (part.indexOf("=", eq + 1) !== -1)
      fail("CANON_QUERY_SYNTAX_AMBIGUOUS", "multiple '=' in query segment");
    const rawName = part.slice(0, eq);
    const rawValue = part.slice(eq + 1);
    out.push([percentDecodeQuery(rawName), percentDecodeQuery(rawValue)]);
  }
  return out;
}

/** Percent-decode a query token exactly once; `+` is literal plus (never space). */
function percentDecodeQuery(token: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < token.length; ) {
    const c = token[i];
    if (c === "%") {
      if (i + 2 >= token.length)
        fail("CANON_QUERY_PERCENT_INVALID", "truncated percent escape");
      const hex = token.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex))
        fail("CANON_QUERY_PERCENT_INVALID", `malformed percent escape %${hex}`);
      bytes.push(Number.parseInt(hex, 16));
      i += 3;
    } else {
      const code = token.charCodeAt(i);
      if (code > 0x7f)
        fail("CANON_QUERY_VALUE_INVALID", "raw non-ASCII byte in query token");
      bytes.push(code);
      i += 1;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    fail(
      "CANON_QUERY_PERCENT_INVALID",
      "percent-decoded bytes are not valid UTF-8",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Header canonicalization (section 3.7)
// ─────────────────────────────────────────────────────────────────────────────

export const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "x-github-api-version",
]);

/** Headers a caller may never supply; presence yields CREDENTIAL_FORBIDDEN. */
const FORBIDDEN_HEADER_PREFIXES = ["x-steward-"];
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "trailer",
  "te",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-original-url",
  "x-original-host",
  "x-http-method-override",
  "x-method-override",
  "x-steward-authorization",
]);

const GITHUB_API_VERSION = "2022-11-28";
const TOKEN_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Canonicalize a set of raw header occurrences (name/value, possibly repeated)
 * into the allowlisted, validated, sorted `selectedHeaders`. `content-type` is
 * NOT included here for body-bearing operations — the body/content-type matrix
 * (section 3.9) owns that and injects the canonical value. Pass content-type in
 * only for non-body header validation contexts.
 */
export function canonicalizeHeaders(
  raw: ReadonlyArray<[string, string]>,
): Array<[string, string]> {
  const byName = new Map<string, string>();
  for (const [rawName, rawValue] of raw) {
    if (typeof rawName !== "string" || typeof rawValue !== "string")
      fail("CANON_HEADER_INVALID", "header name/value must be strings");
    const name = rawName.toLowerCase();
    if (!TOKEN_NAME.test(name))
      fail("CANON_HEADER_INVALID", `invalid header name '${rawName}'`);
    // Credential / forbidden headers first.
    if (
      FORBIDDEN_HEADERS.has(name) ||
      FORBIDDEN_HEADER_PREFIXES.some((p) => name.startsWith(p))
    )
      fail("CANON_HEADER_CREDENTIAL_FORBIDDEN", `forbidden header '${name}'`);
    if (!HEADER_ALLOWLIST.has(name))
      fail("CANON_HEADER_UNSUPPORTED", `non-allowlisted header '${name}'`);
    if (byName.has(name))
      fail("CANON_HEADER_DUPLICATE", `duplicate header '${name}'`);
    const value = trimOws(rawValue);
    assertHeaderValueClean(value);
    byName.set(name, canonicalizeHeaderValue(name, value));
  }
  const entries = [...byName.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  return entries.map(([n, v]) => [n, v]);
}

function trimOws(s: string): string {
  let start = 0;
  let end = s.length;
  while (
    start < end &&
    (s.charCodeAt(start) === 0x20 || s.charCodeAt(start) === 0x09)
  )
    start += 1;
  while (
    end > start &&
    (s.charCodeAt(end - 1) === 0x20 || s.charCodeAt(end - 1) === 0x09)
  )
    end -= 1;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

function assertHeaderValueClean(v: string): void {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d)
      fail("CANON_HEADER_INVALID", "HTAB/CR/LF in header value");
    if (c < 0x20 || c === 0x7f)
      fail("CANON_HEADER_INVALID", "control/DEL in header value");
  }
}

function canonicalizeHeaderValue(name: string, value: string): string {
  switch (name) {
    case "accept":
      if (
        value !== "application/vnd.github+json" &&
        value !== "application/json"
      )
        fail("CANON_ACCEPT_INVALID", `unsupported accept '${value}'`);
      return value;
    case "content-type":
      return canonicalizeContentType(value);
    case "if-match":
    case "if-none-match":
      return canonicalizeEntityTag(value);
    case "x-github-api-version":
      if (value !== GITHUB_API_VERSION)
        fail("CANON_GITHUB_VERSION_INVALID", `unsupported version '${value}'`);
      return value;
    default:
      // unreachable: only allowlisted names reach here
      fail("CANON_HEADER_UNSUPPORTED", `unexpected header '${name}'`);
  }
}

function canonicalizeEntityTag(value: string): string {
  if (value === "*") return "*";
  // one syntactically valid entity tag: optional W/ then quoted string
  if (!/^(W\/)?"[^"\r\n]*"$/.test(value))
    fail("CANON_CONDITIONAL_HEADER_INVALID", `invalid entity tag '${value}'`);
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Content-type + body matrix (section 3.9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonicalize a content-type to `application/json` or `application/vnd.github+json`,
 * accepting an optional case-insensitive `charset=utf-8`. Denies duplicate
 * parameters, quoted charset, non-UTF-8 charset, extra parameters, other media.
 */
export function canonicalizeContentType(raw: string): string {
  const trimmed = trimOws(raw);
  const parts = trimmed.split(";").map((p) => p.trim());
  const media = parts[0].toLowerCase();
  if (media !== "application/json" && media !== "application/vnd.github+json")
    fail(
      "CANON_BODY_CONTENT_TYPE_UNSUPPORTED",
      `unsupported media type '${media}'`,
    );
  const params = parts.slice(1).filter((p) => p.length > 0);
  const seenParam = new Set<string>();
  for (const p of params) {
    const eq = p.indexOf("=");
    if (eq === -1)
      fail(
        "CANON_BODY_CONTENT_TYPE_INVALID",
        "malformed content-type parameter",
      );
    const pname = p.slice(0, eq).trim().toLowerCase();
    const pvalRaw = p.slice(eq + 1).trim();
    if (seenParam.has(pname))
      fail(
        "CANON_BODY_CONTENT_TYPE_INVALID",
        `duplicate content-type parameter '${pname}'`,
      );
    seenParam.add(pname);
    if (pname !== "charset")
      fail(
        "CANON_BODY_CONTENT_TYPE_INVALID",
        `unsupported content-type parameter '${pname}'`,
      );
    // charset must be unquoted utf-8
    if (pvalRaw.startsWith('"'))
      fail("CANON_BODY_CONTENT_TYPE_INVALID", "quoted charset not allowed");
    if (pvalRaw.toLowerCase() !== "utf-8")
      fail(
        "CANON_BODY_CONTENT_TYPE_INVALID",
        `unsupported charset '${pvalRaw}'`,
      );
  }
  return media;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw internal HTTP representation → canonical action (section 2.2 / 3.9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A raw, INTERNAL HTTP representation of a provider action. This is NOT the
 * public API shape — it is what the GitHub adapter constructs from validated
 * operation arguments, and what proxy recomputation and the offline
 * verifier feed in. Because ALL of these consumers call
 * {@link canonicalizeRawInternalAction}, there is exactly ONE canonicalization
 * path and the golden corpus proves it byte-for-byte.
 *
 * Fields are raw/pre-canonical: `method` may be any case, `origin` any
 * equivalent form, `path` a raw ASCII path, `query` already-decoded logical
 * pairs (the adapter builds these from validated args, never from a raw string;
 * a raw-string producer must call {@link parseRawQuery} first), `headers` raw
 * occurrences, and `body`:
 *   - `undefined` / absent  => no body (GET/HEAD/bodyless DELETE)
 *   - a JsonValue           => a JSON body; `contentType` MUST be present
 */
export interface RawInternalAction {
  method: string;
  origin: string;
  path: string;
  query?: ReadonlyArray<QueryPair>;
  headers?: ReadonlyArray<[string, string]>;
  /** Raw content-type header value when a body is present; omit for no body. */
  contentType?: string;
  /** Already-parsed JSON body value, or absent/undefined for no body. */
  body?: JsonValue;
}

/** Methods that MUST NOT carry a request body in this profile. */
const BODYLESS_METHODS: ReadonlySet<CanonicalMethod> = new Set(["GET", "HEAD"]);
/** Methods that MAY carry a JSON body. */
const BODY_METHODS: ReadonlySet<CanonicalMethod> = new Set([
  "POST",
  "PUT",
  "PATCH",
]);

/**
 * Canonicalize a raw internal HTTP representation into the fully-canonical
 * {@link GithubCanonicalActionV1}, applying the body/content-type matrix
 * (section 3.9). Throws {@link CanonError} on any ambiguity (never a 500).
 *
 * The content-type header is validated and injected HERE (not via
 * {@link canonicalizeHeaders}, which excludes it for body-bearing actions) so
 * the body and its media type are canonicalized together per the matrix.
 */
export function canonicalizeRawInternalAction(
  raw: RawInternalAction,
): GithubCanonicalActionV1 {
  const method = canonicalizeMethod(raw.method);
  const origin = canonicalizeOrigin(raw.origin);
  const normalizedPath = normalizePath(raw.path);
  const orderedQueryPairs = canonicalizeQueryPairs(raw.query ?? []);
  const selectedHeaders = canonicalizeHeaders(raw.headers ?? []);

  const hasBody = raw.body !== undefined;
  const hasContentType = raw.contentType !== undefined;

  let canonicalBody: JsonValue | null = null;

  if (BODYLESS_METHODS.has(method)) {
    // GET/HEAD: any body or content-type denies.
    if (hasBody || hasContentType)
      fail("CANON_BODY_FORBIDDEN", `${method} must not carry a body`);
  } else if (BODY_METHODS.has(method)) {
    // POST/PUT/PATCH: a JSON body is required (bodyless mutation is a new profile).
    if (!hasBody) fail("CANON_BODY_REQUIRED", `${method} requires a body`);
    if (!hasContentType)
      fail(
        "CANON_BODY_CONTENT_TYPE_REQUIRED",
        "body present without content-type",
      );
    const media = canonicalizeContentType(raw.contentType as string);
    // Inject the canonical content-type into selectedHeaders (deny a duplicate a
    // caller may have also passed through the header list).
    if (selectedHeaders.some(([n]) => n === "content-type"))
      fail(
        "CANON_HEADER_DUPLICATE",
        "content-type supplied both as header and body media type",
      );
    selectedHeaders.push(["content-type", media]);
    selectedHeaders.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (
      raw.body === null ||
      typeof raw.body !== "object" ||
      Array.isArray(raw.body)
    )
      fail("CANON_JSON_SHAPE_INVALID", "body must be a JSON object");
    canonicalBody = raw.body;
  } else {
    // DELETE is bodyless in the current profile; no operation declares a DELETE body.
    if (hasBody || hasContentType)
      fail("CANON_BODY_FORBIDDEN", `${method} must not carry a body`);
  }

  return {
    profile: GITHUB_PROVIDER_ACTION_PROFILE,
    method,
    origin,
    normalizedPath,
    orderedQueryPairs,
    selectedHeaders,
    canonicalBody,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decimal business-value validation (section 3.8) — corpus rule
// ─────────────────────────────────────────────────────────────────────────────

/** Validate a business-decimal STRING: `^(0|[1-9][0-9]*)(\.[0-9]+)?$`. */
export function assertDecimalString(s: string): void {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s))
    fail("CANON_DECIMAL_STRING_INVALID", `invalid decimal string '${s}'`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Golden vectors (section 4) — the authoritative corpus, imported by every suite.
// ─────────────────────────────────────────────────────────────────────────────

/** The fixed envelope fields shared by all golden vectors (minus actionDigest). */
export const GOLDEN_ENVELOPE_BASE = {
  schemaVersion: PROVIDER_REQUEST_SCHEMA_VERSION,
  tenantId: "tenant_acme",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  actorAgentId: "agent_x",
  providerAccountId: "22222222-2222-4222-8222-222222222222",
  operationId: "33333333-3333-4333-8333-333333333333",
  operationRevision: 7,
  idempotencyKeyHash:
    "sha256:36c27d7668cf64a4354635a421f14d74410e9cd54bf1002bffa82421145c7a57",
  requestedAt: "2026-07-14T20:00:00.000Z",
  expiresAt: "2026-07-14T20:05:00.000Z",
  nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
} as const;

export interface GoldenVector {
  id: string;
  description: string;
  action: GithubCanonicalActionV1;
  canonicalActionBytes: string;
  actionDigest: string;
  requestHash: string;
}

function ga(
  method: CanonicalMethod,
  normalizedPath: string,
  orderedQueryPairs: Array<[string, string]>,
  selectedHeaders: Array<[string, string]>,
  canonicalBody: null | JsonValue,
): GithubCanonicalActionV1 {
  return {
    profile: GITHUB_PROVIDER_ACTION_PROFILE,
    method,
    origin: CANONICAL_ORIGIN,
    normalizedPath,
    orderedQueryPairs,
    selectedHeaders,
    canonicalBody,
  };
}

/**
 * The 17 golden vectors, expressed as their canonical action objects plus the
 * expected bytes/digests/hashes copied verbatim from the spec. Tests assert both
 * that OUR serializer reproduces `canonicalActionBytes` and that the recorded
 * digests/hashes match — a byte corruption in either direction fails.
 */
export const GOLDEN_VECTORS: GoldenVector[] = [
  {
    id: "GV-01",
    description: "basic issue list",
    action: ga("GET", "/repos/octo/hello/issues", [], [], null),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/hello/issues","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[]}',
    actionDigest:
      "sha256:effa84639ed9c9b0b2c01b65bd716342a25a846d9209818b194ab3d151276f3a",
    requestHash:
      "sha256:8c0d3d5761ad6ad8ea017d3d36bd57157a7d2f5767acce8ede417d4556b377e3",
  },
  {
    id: "GV-02",
    description: "method case normalized",
    action: ga("GET", "/repos/octo/hello/issues", [], [], null),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/hello/issues","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[]}',
    actionDigest:
      "sha256:effa84639ed9c9b0b2c01b65bd716342a25a846d9209818b194ab3d151276f3a",
    requestHash:
      "sha256:8c0d3d5761ad6ad8ea017d3d36bd57157a7d2f5767acce8ede417d4556b377e3",
  },
  {
    id: "GV-03",
    description: "origin case/default-port normalized",
    action: ga("GET", "/repos/octo/hello/issues", [], [], null),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/hello/issues","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[]}',
    actionDigest:
      "sha256:effa84639ed9c9b0b2c01b65bd716342a25a846d9209818b194ab3d151276f3a",
    requestHash:
      "sha256:8c0d3d5761ad6ad8ea017d3d36bd57157a7d2f5767acce8ede417d4556b377e3",
  },
  {
    id: "GV-04",
    description: "query sorting",
    action: ga(
      "GET",
      "/repos/octo/hello/issues",
      [
        ["per_page", "30"],
        ["state", "open"],
      ],
      [],
      null,
    ),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/hello/issues","orderedQueryPairs":[["per_page","30"],["state","open"]],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[]}',
    actionDigest:
      "sha256:445b2d106b942351d69feeb8d8a7575d793ddfbc357b0cea35e66f0696432b57",
    requestHash:
      "sha256:ea3288afc951a71bccca01fd4e06e638998e9d86b303321545d8d4afe4fb8f38",
  },
  {
    id: "GV-05",
    description: "two query keys canonical order",
    action: ga(
      "GET",
      "/repos/octo/hello/issues",
      [
        ["direction", "desc"],
        ["sort", "created"],
      ],
      [],
      null,
    ),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/hello/issues","orderedQueryPairs":[["direction","desc"],["sort","created"]],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[]}',
    actionDigest:
      "sha256:13256b604d25d80a338c192e7a1848f7b33917434b6014906657123008c61bcb",
    requestHash:
      "sha256:72b69a61a6c11515a025086f041dcd021e1c9abd1a4a5706e9420768c3d6bc49",
  },
  {
    id: "GV-06",
    description: "query empty value",
    action: ga(
      "GET",
      "/repos/octo/hello/issues",
      [
        ["page", ""],
        ["state", "all"],
      ],
      [],
      null,
    ),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/hello/issues","orderedQueryPairs":[["page",""],["state","all"]],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[]}',
    actionDigest:
      "sha256:61d58545cb091a9d74f2ef062dcb98afd6ecf6dbe6495da26192a2aaef9caf0d",
    requestHash:
      "sha256:5fb075a546f84b8e7a9134632272dfac4f9b8d1a8e3eca25d3c11c496920b798",
  },
  {
    id: "GV-07",
    description: "query Unicode decoded value",
    action: ga(
      "GET",
      "/search/issues",
      [["q", "café repo:octo/hello"]],
      [],
      null,
    ),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/search/issues","orderedQueryPairs":[["q","café repo:octo/hello"]],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[]}',
    actionDigest:
      "sha256:583796c845d1ac8698d7f8b18af21969da588323c4dfa555273d47be491fac37",
    requestHash:
      "sha256:42b54c0c181aabd929519dd674d635f677dfd20574fd3e0df1673a4b131fcead",
  },
  {
    id: "GV-08",
    description: "accept header",
    action: ga(
      "GET",
      "/repos/octo/hello/issues",
      [],
      [["accept", "application/vnd.github+json"]],
      null,
    ),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/hello/issues","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[["accept","application/vnd.github+json"]]}',
    actionDigest:
      "sha256:04bf6b053c634f0dc6a216dc718841ddfffec4bb29c75ca5f1215067335960f4",
    requestHash:
      "sha256:b679c7cb25bdb5d5ea7ac673f0a6cfeb239ca036f3644b1e87b175195e742116",
  },
  {
    id: "GV-09",
    description: "header OWS/case normalized",
    action: ga(
      "GET",
      "/repos/octo/hello/issues",
      [],
      [["if-none-match", '"abc"']],
      null,
    ),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/hello/issues","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[["if-none-match","\\"abc\\""]]}',
    actionDigest:
      "sha256:f9b1ea94ad961932469a55c952ebb531988132bf8c018741ebcb7b9285597a86",
    requestHash:
      "sha256:caaa283757f984567398d7c64f3ef8699e02c8b3765e67568de7eed175d197d3",
  },
  {
    id: "GV-10",
    description: "multiple selected headers sorted",
    action: ga(
      "GET",
      "/repos/octo/hello/issues",
      [],
      [
        ["accept", "application/vnd.github+json"],
        ["if-none-match", 'W/"7"'],
        ["x-github-api-version", "2022-11-28"],
      ],
      null,
    ),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/hello/issues","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[["accept","application/vnd.github+json"],["if-none-match","W/\\"7\\""],["x-github-api-version","2022-11-28"]]}',
    actionDigest:
      "sha256:f1b5fea9a6a70c9862fd58959f98d1464d3030864b2f34f419f50ec0a4ab4ab5",
    requestHash:
      "sha256:d15a5781c01b2e7cf6d9ec9def521188a09eb37331270f578e278c9d56f43996",
  },
  {
    id: "GV-11",
    description: "create comment",
    action: ga(
      "POST",
      "/repos/octo/hello/issues/42/comments",
      [],
      [["content-type", "application/json"]],
      { body: "looks good" },
    ),
    canonicalActionBytes:
      '{"canonicalBody":{"body":"looks good"},"method":"POST","normalizedPath":"/repos/octo/hello/issues/42/comments","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[["content-type","application/json"]]}',
    actionDigest:
      "sha256:374f75fb15c8cfd2086597a685dcc14aba668897e8519deebecb84e6ee9d6196",
    requestHash:
      "sha256:9015bba7077c6a973e370ba620786dbc45e3e175370b81f74b42afaeed931d51",
  },
  {
    id: "GV-12",
    description: "JSON key ordering",
    action: ga(
      "POST",
      "/repos/octo/hello/issues/42/comments",
      [],
      [["content-type", "application/json"]],
      { body: "ship it", metadata: { a: 1, z: true } },
    ),
    canonicalActionBytes:
      '{"canonicalBody":{"body":"ship it","metadata":{"a":1,"z":true}},"method":"POST","normalizedPath":"/repos/octo/hello/issues/42/comments","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[["content-type","application/json"]]}',
    actionDigest:
      "sha256:1eb38fc53c5e424aff0e3f0cb4680b9078fab110bb1c04eb22738e6e41e8031c",
    requestHash:
      "sha256:d43cdda870f9c00deedb72c76523494faec9ed6b582d3fb6cd8612046279e901",
  },
  {
    id: "GV-13",
    description: "Unicode JSON preserved",
    action: ga(
      "POST",
      "/repos/octo/hello/issues/42/comments",
      [],
      [["content-type", "application/json"]],
      { body: "café ☕" },
    ),
    canonicalActionBytes:
      '{"canonicalBody":{"body":"café ☕"},"method":"POST","normalizedPath":"/repos/octo/hello/issues/42/comments","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[["content-type","application/json"]]}',
    actionDigest:
      "sha256:0670c3e5ccdffcb2acf47ef76d22183bd02d8b41a320990b4ff5be1b8ab6751c",
    requestHash:
      "sha256:4b15779aa787faa36bd448e33df3bee496bd1bde98fa7f29d4b3baa6e4fe1af9",
  },
  {
    id: "GV-14",
    description: "safe integer JSON number",
    action: ga(
      "POST",
      "/repos/octo/hello/issues/42/comments",
      [],
      [["content-type", "application/json"]],
      { body: "line note", line: 12, side: "RIGHT" },
    ),
    canonicalActionBytes:
      '{"canonicalBody":{"body":"line note","line":12,"side":"RIGHT"},"method":"POST","normalizedPath":"/repos/octo/hello/issues/42/comments","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[["content-type","application/json"]]}',
    actionDigest:
      "sha256:b5df21376f2f76310889d5c00d063a28e4e7b37166df5e5f24799a3502bac148",
    requestHash:
      "sha256:e9fdbd5d464d8f7a81a4e68fb9dfe2d3ee068146f62ce7a2217c08d7bc6cae31",
  },
  {
    id: "GV-15",
    description: "null boolean array JSON",
    action: ga(
      "POST",
      "/repos/octo/hello/issues/42/comments",
      [],
      [["content-type", "application/vnd.github+json"]],
      { active: false, labels: ["bug", null] },
    ),
    canonicalActionBytes:
      '{"canonicalBody":{"active":false,"labels":["bug",null]},"method":"POST","normalizedPath":"/repos/octo/hello/issues/42/comments","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[["content-type","application/vnd.github+json"]]}',
    actionDigest:
      "sha256:aa31a6681277932dbbbaca01bd7811a1317428bf76e04a7a02c496d7f2065148",
    requestHash:
      "sha256:e3854994f534286310f4174ff80be6bd4124adb73026884219c722d0141de74b",
  },
  {
    id: "GV-16",
    description: "unreserved path escape normalized",
    action: ga("GET", "/repos/octo/~hello/issues", [], [], null),
    canonicalActionBytes:
      '{"canonicalBody":null,"method":"GET","normalizedPath":"/repos/octo/~hello/issues","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[]}',
    actionDigest:
      "sha256:f7a1a6dc6f0f4b2ccc8f48bfa2e270e06c483326c2933ce4c88d45ba2313ad1f",
    requestHash:
      "sha256:0533dc5342d9faa71bfb5c72a5f156c3f0bb0dc8dddf2f75934f2fc3560288c8",
  },
  {
    id: "GV-17",
    description: "decimal business value as string",
    action: ga(
      "PATCH",
      "/repos/octo/hello/issues/42",
      [],
      [["content-type", "application/json"]],
      {
        estimate: "12.50",
      },
    ),
    canonicalActionBytes:
      '{"canonicalBody":{"estimate":"12.50"},"method":"PATCH","normalizedPath":"/repos/octo/hello/issues/42","orderedQueryPairs":[],"origin":"https://api.github.com","profile":"github.provider-action.v1","selectedHeaders":[["content-type","application/json"]]}',
    actionDigest:
      "sha256:3c0a35585b46cce53aeb1894f1fa7f96e75e1a623e75d2563df3a2ea83ef26e2",
    requestHash:
      "sha256:73d6bd9a9b0937e6d2ee4657a94cbbee3202ddacec1ad2be8499a988b5640d68",
  },
];

/** Build the full request envelope for a golden vector (base + its digest). */
export function goldenEnvelope(
  actionDigest: string,
): ProviderRequestEnvelopeV1 {
  return { ...GOLDEN_ENVELOPE_BASE, actionDigest };
}
