/**
 * Stable cache-key derivation.
 *
 * Args are JSON-stringified with sorted object keys so semantically-equal
 * argument shapes (e.g. `{a:1,b:2}` and `{b:2,a:1}`) collide on the same
 * key. The final key is `sha256(toolName + ':' + canonicalJson)`.
 *
 * These args are the arguments a tool-calling model turn emitted, so they are
 * untrusted input and this is the FIRST function in the cache path to touch
 * them — `ToolCallCache.get`/`set`/`run` key on them before the disk tier's
 * privacy redactor ever sees anything. The canonicalizer therefore walks under
 * an explicit budget:
 *
 *   - Depth, node count, aggregate key width, per-string length and aggregate
 *     serialized bytes are all bounded, and the budget is shared across the
 *     whole walk. An over-deep argument tree fails the budget instead of
 *     overflowing the stack.
 *   - Cycle detection is path-local (`seen.delete` on container exit), so a
 *     DAG or a repeated reference still canonicalizes; only a true cycle is
 *     rejected.
 *   - Width is reserved BEFORE any per-entry work: array length comes from the
 *     `length` property *descriptor* and object width from
 *     `Object.getOwnPropertyNames`, both charged against the remaining key
 *     budget before a single element is touched.
 *   - Property values are read from data descriptors only, so no getter and no
 *     Proxy `get` trap ever runs on model-supplied args. A getter would also
 *     make the key non-deterministic, which a cache key cannot tolerate.
 *   - Every reflection call is guarded, so a revoked or hostile Proxy surfaces
 *     as a typed rejection rather than a raw `TypeError`.
 *
 * Rejection is never silent and never truncating: {@link tryBuildCacheKey}
 * reports the reason so the cache can decline to key the call (the tool still
 * executes, uncached), and {@link buildCacheKey} throws a typed
 * {@link ToolCacheKeyBoundError}. No partially-walked value is ever hashed.
 *
 * Within budget the output is byte-identical to the previous unbounded
 * canonicalizer for every value it accepted, so no existing cache key moves.
 *
 * Why this is not `boundedWalk` (`./bounded-walk.ts`)
 * ---------------------------------------------------
 * Both walks share the same hostile-input contract and now the same budget
 * ({@link CACHE_KEY_LIMITS} is derived from `TOOL_OUTPUT_LIMITS`), but they
 * cannot share a traversal, because the key path is pinned to text the output
 * path cannot produce:
 *
 *   - `boundedWalk` returns a *copy* in own-key order; a cache key needs
 *     canonical *text* in sorted-key order, and that text is not
 *     `JSON.stringify` of the copy. An object property whose value is
 *     `undefined` emits the literal `undefined` token, an `undefined`/hole
 *     array element emits nothing, and a non-finite number emits `null` —
 *     bytes no round-trip through a value copy can reproduce. Re-deriving them
 *     would mean a second full walk of untrusted input and would still move
 *     every existing key for those shapes.
 *   - `boundedWalk` rejects any value whose prototype is neither
 *     `Object.prototype` nor `null`. That is right for outputs, which must
 *     survive `structuredClone` and JSON disk persistence, and wrong for keys:
 *     `Date`, `Map` and class-instance args canonicalize today (as their own
 *     enumerable properties) and are cacheable today, so adopting that rule
 *     here would silently make live calls uncacheable rather than harden them.
 *   - Enumerability is checked before the accessor check here, because
 *     `Object.keys` never saw a non-enumerable property and its getter must
 *     stay unread; `boundedWalk` rejects the accessor first.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { ElizaError } from "@elizaos/core";

import { TOOL_OUTPUT_LIMITS } from "./bounded-walk.ts";
import type { ToolArgs } from "./types.ts";

export interface CanonicalizeLimits {
  /** Maximum container nesting. Depth 0 is the root value. */
  maxDepth: number;
  /** Maximum values visited across the whole walk. */
  maxNodes: number;
  /** Maximum aggregate array length + own-key width reserved across the walk. */
  maxKeys: number;
  /** Maximum length of any single string leaf. */
  maxStringLength: number;
  /** Maximum aggregate canonical-text bytes produced by the walk. */
  maxBytes: number;
}

/**
 * Default budget for canonicalizing tool arguments.
 *
 * Derived from the shared tool-output budget rather than restated, so the
 * input (cache-key) and output (`boundedWalk`) sides of the cache cannot drift
 * apart in how much work one untrusted value may cost. The traversals stay
 * separate — see the note below — but the ceiling is one number in one place.
 */
export const CACHE_KEY_LIMITS: CanonicalizeLimits = { ...TOOL_OUTPUT_LIMITS };

export type CacheKeyRejection =
  /** Enumerable accessor property; reading it would run untrusted code. */
  | "accessor"
  /** Aggregate canonical-byte budget exhausted. */
  | "bytes"
  /** True cycle (the value is already on the current path). */
  | "cycle"
  /** Depth budget exhausted. */
  | "depth"
  /** Aggregate array-length / own-key width budget exhausted. */
  | "keys"
  /** Node budget exhausted. */
  | "nodes"
  /** A reflection call threw (revoked/hostile Proxy). */
  | "reflection"
  /** A single string leaf exceeded the per-string cap. */
  | "string-length"
  /** Not canonicalizable at all (bigint, or an exotic array length). */
  | "unsupported";

/** Typed failure for arguments the cache key walk refuses to hash. */
export class ToolCacheKeyBoundError extends ElizaError {
  override readonly name = "ToolCacheKeyBoundError";

  constructor(
    readonly reason: CacheKeyRejection,
    options: { toolName?: string; cause?: unknown } = {},
  ) {
    super(`tool-call cache key rejected unbounded arguments (${reason})`, {
      code: "TOOL_CACHE_KEY_UNBOUNDED",
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      context: {
        reason,
        limits: CACHE_KEY_LIMITS,
        ...(options.toolName !== undefined
          ? { toolName: options.toolName }
          : {}),
      },
    });
  }
}

export type CanonicalizeResult =
  /**
   * `canonical` is `undefined` only for a root value that has no JSON text at
   * all (`undefined`, a function, a symbol) — the same value the previous
   * canonicalizer returned for those roots.
   */
  | { ok: true; canonical: string | undefined }
  | { ok: false; reason: CacheKeyRejection };

export type CacheKeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: CacheKeyRejection };

interface WalkState {
  limits: CanonicalizeLimits;
  seen: WeakSet<object>;
  nodes: number;
  keys: number;
  bytes: number;
}

type WalkResult =
  | { ok: true; text: string | undefined }
  | { ok: false; reason: CacheKeyRejection };

/** Charge ASCII syntax bytes against the shared canonical-text budget. */
function chargeAscii(state: WalkState, length: number): boolean {
  state.bytes += length;
  return state.bytes <= state.limits.maxBytes;
}

/** Charge a JSON-encoded leaf or key by its actual UTF-8 byte length. */
function chargeText(state: WalkState, text: string): boolean {
  state.bytes += Buffer.byteLength(text, "utf8");
  return state.bytes <= state.limits.maxBytes;
}

/**
 * Read one own property as a data descriptor, never through `[[Get]]`.
 * `absent` covers array holes and (for objects) non-enumerable properties,
 * both of which the previous canonicalizer also skipped.
 */
function readDataProperty(
  container: object,
  key: string,
  requireEnumerable: boolean,
):
  | { kind: "value"; value: unknown }
  | { kind: "absent" }
  | { kind: "reject"; reason: CacheKeyRejection } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, key);
  } catch {
    return { kind: "reject", reason: "reflection" };
  }
  if (!descriptor) return { kind: "absent" };
  // Non-enumerable object properties never reached `Object.keys`, so they are
  // skipped before the accessor check and their getters stay unread.
  if (requireEnumerable && !descriptor.enumerable) return { kind: "absent" };
  // Accessor properties are rejected before the getter can run.
  if (!("value" in descriptor)) return { kind: "reject", reason: "accessor" };
  return { kind: "value", value: descriptor.value };
}

function walkArray(
  container: object,
  state: WalkState,
  depth: number,
): WalkResult {
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(container, "length");
  } catch {
    return { ok: false, reason: "reflection" };
  }
  if (!lengthDescriptor) return { ok: false, reason: "unsupported" };
  if (!("value" in lengthDescriptor)) return { ok: false, reason: "accessor" };
  const length = lengthDescriptor.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    return { ok: false, reason: "unsupported" };
  }

  // Reserve the full width before touching a single element, so a hostile
  // multi-million-entry array is rejected without any per-entry work.
  if (state.keys + length > state.limits.maxKeys) {
    return { ok: false, reason: "keys" };
  }
  state.keys += length;
  if (!chargeAscii(state, 2 + (length > 0 ? length - 1 : 0))) {
    return { ok: false, reason: "bytes" };
  }

  const parts: string[] = [];
  for (let index = 0; index < length; index += 1) {
    // Array element reads follow `Array.prototype.map`, which does not consult
    // enumerability; a hole and an `undefined` element both render as empty.
    const read = readDataProperty(container, String(index), false);
    if (read.kind === "reject") return { ok: false, reason: read.reason };
    if (read.kind === "absent") {
      parts.push("");
      continue;
    }
    const child = walkValue(read.value, state, depth + 1);
    if (!child.ok) return child;
    parts.push(child.text ?? "");
  }
  return { ok: true, text: `[${parts.join(",")}]` };
}

function walkObject(
  container: object,
  state: WalkState,
  depth: number,
): WalkResult {
  let names: string[];
  try {
    names = Object.getOwnPropertyNames(container);
  } catch {
    return { ok: false, reason: "reflection" };
  }

  // Reserve own-key width before reading any descriptor, so a hostile
  // million-key object is rejected without per-key reflection.
  if (state.keys + names.length > state.limits.maxKeys) {
    return { ok: false, reason: "keys" };
  }
  state.keys += names.length;

  const entries: Array<[string, unknown]> = [];
  for (const name of names) {
    const read = readDataProperty(container, name, true);
    if (read.kind === "reject") return { ok: false, reason: read.reason };
    if (read.kind === "absent") continue;
    entries.push([name, read.value]);
  }
  // Matches the previous `Object.keys(obj).sort()` ordering exactly.
  entries.sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );

  if (!chargeAscii(state, 2 + (entries.length > 0 ? entries.length - 1 : 0))) {
    return { ok: false, reason: "bytes" };
  }

  const parts: string[] = [];
  for (const [name, value] of entries) {
    const encodedKey = JSON.stringify(name);
    if (!chargeText(state, encodedKey) || !chargeAscii(state, 1)) {
      return { ok: false, reason: "bytes" };
    }
    const child = walkValue(value, state, depth + 1);
    if (!child.ok) return child;
    // A property whose value has no JSON text kept the literal `undefined`
    // token in the previous canonicalizer; preserved so keys do not move.
    parts.push(
      `${encodedKey}:${child.text === undefined ? "undefined" : child.text}`,
    );
  }
  return { ok: true, text: `{${parts.join(",")}}` };
}

function walkValue(
  value: unknown,
  state: WalkState,
  depth: number,
): WalkResult {
  if (state.nodes >= state.limits.maxNodes) {
    return { ok: false, reason: "nodes" };
  }
  state.nodes += 1;

  if (value === null) {
    return chargeAscii(state, 4)
      ? { ok: true, text: "null" }
      : { ok: false, reason: "bytes" };
  }

  const type = typeof value;
  if (type === "string") {
    const text = value as string;
    if (text.length > state.limits.maxStringLength) {
      return { ok: false, reason: "string-length" };
    }
    const encoded = JSON.stringify(text);
    return chargeText(state, encoded)
      ? { ok: true, text: encoded }
      : { ok: false, reason: "bytes" };
  }
  if (type === "number" || type === "boolean") {
    // Non-finite numbers serialize as `null`, exactly as before.
    const encoded = JSON.stringify(value) as string;
    return chargeAscii(state, encoded.length)
      ? { ok: true, text: encoded }
      : { ok: false, reason: "bytes" };
  }
  if (type === "undefined" || type === "function" || type === "symbol") {
    // `JSON.stringify` produced no text for these; the caller decides how the
    // absence renders (empty inside an array, `undefined` inside an object).
    return { ok: true, text: undefined };
  }
  if (type !== "object") {
    // bigint — `JSON.stringify` threw a raw `TypeError` here before.
    return { ok: false, reason: "unsupported" };
  }

  const container = value as object;
  if (state.seen.has(container)) return { ok: false, reason: "cycle" };
  if (depth >= state.limits.maxDepth) return { ok: false, reason: "depth" };

  let isArray: boolean;
  try {
    isArray = Array.isArray(container);
  } catch {
    return { ok: false, reason: "reflection" };
  }

  state.seen.add(container);
  try {
    return isArray
      ? walkArray(container, state, depth)
      : walkObject(container, state, depth);
  } finally {
    // Path-local: a repeated (non-cyclic) reference stays canonicalizable.
    state.seen.delete(container);
  }
}

/**
 * Canonicalize `value` under the shared budget, reporting the first rejection
 * instead of throwing. No partially-walked text is ever returned.
 */
export function tryCanonicalizeJson(
  value: unknown,
  limits: Partial<CanonicalizeLimits> = {},
): CanonicalizeResult {
  const state: WalkState = {
    limits: { ...CACHE_KEY_LIMITS, ...limits },
    seen: new WeakSet<object>(),
    nodes: 0,
    keys: 0,
    bytes: 0,
  };
  const result = walkValue(value, state, 0);
  return result.ok
    ? { ok: true, canonical: result.text }
    : { ok: false, reason: result.reason };
}

/**
 * Canonicalize `value`, throwing {@link ToolCacheKeyBoundError} when the walk
 * exceeds its budget or hits a cycle, an accessor, or hostile reflection.
 */
export function canonicalizeJson(value: unknown): string {
  const result = tryCanonicalizeJson(value);
  if (!result.ok) throw new ToolCacheKeyBoundError(result.reason);
  // A root `undefined`/function/symbol still yields `undefined`, matching the
  // previous implementation's (untyped) return for those roots.
  return result.canonical as string;
}

/**
 * Derive the cache key for (toolName, args), reporting a bounded rejection
 * instead of throwing. Callers treat a rejection as "not cacheable" and run
 * the tool normally.
 */
export function tryBuildCacheKey(
  toolName: string,
  args: ToolArgs,
): CacheKeyResult {
  const canonical = tryCanonicalizeJson(args);
  if (!canonical.ok) return { ok: false, reason: canonical.reason };
  // Off-contract roots with no JSON text (`undefined`, a function, a symbol)
  // are not hashable; the previous implementation threw a raw `TypeError`
  // from `hash.update(undefined)` on exactly these.
  if (canonical.canonical === undefined) {
    return { ok: false, reason: "unsupported" };
  }
  const hash = createHash("sha256");
  hash.update(toolName);
  hash.update(":");
  hash.update(canonical.canonical);
  return { ok: true, key: hash.digest("hex") };
}

/**
 * Derive the cache key for (toolName, args), throwing
 * {@link ToolCacheKeyBoundError} when the args cannot be bounded.
 */
export function buildCacheKey(toolName: string, args: ToolArgs): string {
  const result = tryBuildCacheKey(toolName, args);
  if (!result.ok) {
    throw new ToolCacheKeyBoundError(result.reason, { toolName });
  }
  return result.key;
}
