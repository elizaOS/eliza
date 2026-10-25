/**
 * Shared descriptor-safe bounded traversal for the tool-call cache.
 *
 * One walker backs all three consumers — output validation
 * (`isCacheableToolOutput`), cycle detection, and privacy redaction
 * (`defaultPrivacyRedactor`) — so they cannot drift apart in what they
 * consider walkable.
 *
 * Hostile-input contract:
 *   - Width is reserved BEFORE any per-entry work. Array length is read from
 *     the `length` property *descriptor* and object width from
 *     `Object.getOwnPropertyNames`; both are compared against the remaining
 *     key budget before a single element/property is touched. Nothing calls
 *     `Object.values`/`Object.entries`, so a flat million-key result is
 *     rejected without allocating a values array.
 *   - Property values are read from data descriptors only. An accessor
 *     (getter/setter) property is rejected outright, so no user getter and no
 *     user property getter is ever invoked.
 *   - Proxies are rejected with Node's trap-free Proxy detector before any
 *     JavaScript reflection runs. Guarded reflection calls then keep unusual
 *     non-Proxy objects from leaking raw errors onto the caller's success path.
 *   - Depth, node count, aggregate key width, per-string length and aggregate
 *     bytes are all budgeted, and the budget is shared across the whole walk.
 *   - Cycle detection is path-local (`seen.delete` on container exit) so valid
 *     DAGs / repeated references are preserved; only true cycles reject.
 */

import { types as nodeUtilTypes } from "node:util";

export interface BoundedWalkLimits {
  /** Maximum container nesting. Depth 0 is the root value. */
  maxDepth: number;
  /** Maximum values visited across the whole walk. */
  maxNodes: number;
  /** Maximum aggregate array length + own-key width reserved across the walk. */
  maxKeys: number;
  /** Maximum length of any single string leaf. */
  maxStringLength: number;
  /** Maximum aggregate estimated bytes (node overhead + key + string lengths). */
  maxBytes: number;
}

/** Default budget. Callers may narrow (never widen) individual limits. */
export const TOOL_OUTPUT_LIMITS: BoundedWalkLimits = {
  /** Maximum container nesting. Depth 0 is the root value. */
  maxDepth: 32,
  /** Maximum values visited across the whole walk. */
  maxNodes: 100_000,
  /** Maximum aggregate array length + own-key width reserved across the walk. */
  maxKeys: 100_000,
  /** Maximum length of any single string leaf. */
  maxStringLength: 4_000_000,
  /** Maximum aggregate estimated bytes (node overhead + key + string lengths). */
  maxBytes: 16_000_000,
};

export type BoundedWalkRejection =
  /** Property is a getter/setter; reading it would run user code. */
  | "accessor"
  /** Aggregate byte budget exhausted. */
  | "bytes"
  /** True cycle (the value is already on the current path). */
  | "cycle"
  /** Depth budget exhausted. */
  | "depth"
  /** Aggregate array-length / own-key width budget exhausted. */
  | "keys"
  /** Node budget exhausted. */
  | "nodes"
  /** Reflection was unsafe (including any Proxy) or a reflection call threw. */
  | "reflection"
  /** A single string leaf exceeded the per-string cap. */
  | "string-length"
  /** Not representable as `ToolOutput` (function, symbol, NaN, class instance…). */
  | "unsupported";

export type BoundedWalkResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: BoundedWalkRejection };

export interface BoundedWalkOptions {
  /** Applied to every string leaf. Identity when omitted. */
  transformString?: (input: string) => string;
  /**
   * When provided the walk never fails: a rejected node is replaced by this
   * value and traversal continues (still inside the same shared budget).
   * Used by the redactor, which must always return a value.
   */
  substitute?: (reason: BoundedWalkRejection) => unknown;
  /**
   * When false, primitives that are not JSON-representable (undefined,
   * function, symbol, bigint, NaN) pass through unchanged instead of being
   * rejected. The redactor sets this; validation leaves it on.
   */
  strictPrimitives?: boolean;
  /** Narrowed limits, merged over {@link TOOL_OUTPUT_LIMITS}. */
  limits?: Partial<BoundedWalkLimits>;
}

/** Flat per-node overhead charged against the byte budget. */
const NODE_BYTE_COST = 8;

interface WalkState {
  limits: BoundedWalkLimits;
  transformString: ((input: string) => string) | undefined;
  substitute: ((reason: BoundedWalkRejection) => unknown) | undefined;
  strictPrimitives: boolean;
  seen: WeakSet<object>;
  nodes: number;
  keys: number;
  bytes: number;
}

type ContainerShape =
  | { kind: "array"; length: number }
  | { kind: "object"; names: string[] }
  | { kind: "reject"; reason: BoundedWalkRejection };

/**
 * Classify a container and report its width without reading any property
 * value. Proxies are rejected before reflection, and every subsequent
 * reflection call is guarded so unusual host objects reject rather than throw.
 */
function describeContainer(value: object): ContainerShape {
  // `util.types.isProxy` inspects the engine object directly and never invokes
  // user traps, including for revoked proxies.
  if (nodeUtilTypes.isProxy(value)) {
    return { kind: "reject", reason: "reflection" };
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return { kind: "reject", reason: "reflection" };
  }

  if (isArray) {
    let lengthDescriptor: PropertyDescriptor | undefined;
    try {
      lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    } catch {
      return { kind: "reject", reason: "reflection" };
    }
    if (!lengthDescriptor || !("value" in lengthDescriptor)) {
      return { kind: "reject", reason: "accessor" };
    }
    if (typeof lengthDescriptor.value !== "number") {
      return { kind: "reject", reason: "unsupported" };
    }
    return { kind: "array", length: lengthDescriptor.value };
  }

  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return { kind: "reject", reason: "reflection" };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return { kind: "reject", reason: "unsupported" };
  }

  let names: string[];
  try {
    names = Object.getOwnPropertyNames(value);
  } catch {
    return { kind: "reject", reason: "reflection" };
  }
  return { kind: "object", names };
}

/** Read one own property as a data descriptor, never through `[[Get]]`. */
function readDataProperty(
  container: object,
  key: string,
):
  | { kind: "value"; value: unknown }
  | { kind: "absent" }
  | { kind: "reject"; reason: BoundedWalkRejection } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, key);
  } catch {
    return { kind: "reject", reason: "reflection" };
  }
  if (!descriptor) return { kind: "absent" };
  // Accessor properties are rejected before the getter can run.
  if (!("value" in descriptor)) return { kind: "reject", reason: "accessor" };
  if (!descriptor.enumerable) return { kind: "absent" };
  return { kind: "value", value: descriptor.value };
}

function walkValue(
  value: unknown,
  state: WalkState,
  depth: number,
): BoundedWalkResult {
  if (state.nodes >= state.limits.maxNodes) {
    return { ok: false, reason: "nodes" };
  }
  state.nodes += 1;
  state.bytes += NODE_BYTE_COST;
  if (state.bytes > state.limits.maxBytes) {
    return { ok: false, reason: "bytes" };
  }

  if (value === null) return { ok: true, value: null };

  const type = typeof value;
  if (type === "string") {
    const text = value as string;
    if (text.length > state.limits.maxStringLength) {
      return { ok: false, reason: "string-length" };
    }
    state.bytes += text.length;
    if (state.bytes > state.limits.maxBytes) {
      return { ok: false, reason: "bytes" };
    }
    return {
      ok: true,
      value: state.transformString ? state.transformString(text) : text,
    };
  }
  if (type === "boolean") return { ok: true, value };
  if (type === "number") {
    if (Number.isFinite(value)) return { ok: true, value };
    return state.strictPrimitives
      ? { ok: false, reason: "unsupported" }
      : { ok: true, value };
  }
  if (type !== "object") {
    return state.strictPrimitives
      ? { ok: false, reason: "unsupported" }
      : { ok: true, value };
  }

  const container = value as object;
  if (state.seen.has(container)) return { ok: false, reason: "cycle" };
  if (depth >= state.limits.maxDepth) return { ok: false, reason: "depth" };

  const shape = describeContainer(container);
  if (shape.kind === "reject") return { ok: false, reason: shape.reason };

  // Reserve the full width BEFORE touching a single entry, so a hostile flat
  // object/array is rejected without per-entry allocation or reflection.
  const width = shape.kind === "array" ? shape.length : shape.names.length;
  if (!Number.isSafeInteger(width) || width < 0) {
    return { ok: false, reason: "unsupported" };
  }
  if (state.keys + width > state.limits.maxKeys) {
    return { ok: false, reason: "keys" };
  }
  state.keys += width;

  state.seen.add(container);
  try {
    if (shape.kind === "array") {
      const out: unknown[] = [];
      for (let index = 0; index < shape.length; index += 1) {
        const read = readDataProperty(container, String(index));
        if (read.kind === "reject") {
          if (!state.substitute) return { ok: false, reason: read.reason };
          out.push(state.substitute(read.reason));
          continue;
        }
        // Array holes serialize as null through JSON; mirror that.
        if (read.kind === "absent") {
          out.push(null);
          continue;
        }
        const child = walkValue(read.value, state, depth + 1);
        if (!child.ok) {
          if (!state.substitute) return child;
          out.push(state.substitute(child.reason));
          continue;
        }
        out.push(child.value);
      }
      return { ok: true, value: out };
    }

    const out: Record<string, unknown> = {};
    for (const name of shape.names) {
      state.bytes += name.length;
      if (state.bytes > state.limits.maxBytes) {
        return { ok: false, reason: "bytes" };
      }
      const read = readDataProperty(container, name);
      if (read.kind === "reject") {
        if (!state.substitute) return { ok: false, reason: read.reason };
        out[name] = state.substitute(read.reason);
        continue;
      }
      if (read.kind === "absent") continue;
      const child = walkValue(read.value, state, depth + 1);
      if (!child.ok) {
        if (!state.substitute) return child;
        out[name] = state.substitute(child.reason);
        continue;
      }
      out[name] = child.value;
    }
    return { ok: true, value: out };
  } finally {
    state.seen.delete(container);
  }
}

/**
 * Walk `value` under a shared node/key/string/byte budget using
 * descriptor-safe, path-local traversal. Returns the (optionally transformed)
 * copy on success, or the first rejection reason. With `substitute` the walk
 * always succeeds and rejected subtrees are replaced in place.
 */
export function boundedWalk(
  value: unknown,
  options: BoundedWalkOptions = {},
): BoundedWalkResult {
  const state: WalkState = {
    limits: { ...TOOL_OUTPUT_LIMITS, ...options.limits },
    transformString: options.transformString,
    substitute: options.substitute,
    strictPrimitives: options.strictPrimitives ?? true,
    seen: new WeakSet<object>(),
    nodes: 0,
    keys: 0,
    bytes: 0,
  };
  const result = walkValue(value, state, 0);
  if (!result.ok && state.substitute) {
    return { ok: true, value: state.substitute(result.reason) };
  }
  return result;
}
