/**
 * One bounded canonical-JSON walk for every integrity digest in the monorepo.
 *
 * Canonical JSON — recursively key-sorted, `undefined`-dropping — is what makes
 * a content hash reproducible across a serialize → store → `JSON.parse`
 * round-trip regardless of in-memory key ordering. Four hand-rolled copies of
 * the same six-line recursion existed:
 *
 *   - `packages/agent/src/services/agent-export.ts` (bounded by #23127)
 *   - `packages/agent/src/services/agent-backup.ts`
 *   - `packages/cloud/shared/src/lib/services/agent-backup-diff.ts`
 *   - `packages/cloud/shared/src/lib/services/agent-backup-verifier.ts`
 *
 * Only the export copy was ever bounded. The three backup copies still recursed
 * with no depth counter, no node budget and no cycle guard, so a deep or cyclic
 * payload `RangeError`ed the integrity gate instead of rejecting it. This module
 * is that bounded walk, lifted out of `agent-export.ts` unchanged and
 * parameterized on the two things the call sites legitimately disagree about:
 * the budgets, and how a sparse array hole is rendered.
 *
 * Guarantees the call sites depend on:
 *   - Output is byte-identical to the unbounded predecessor for every input the
 *     predecessor accepted, with `sparseArrayHoles` selecting that site's
 *     historical hole rendering. Existing stored digests stay valid.
 *   - Descriptor-only reflection: `Reflect.ownKeys` plus exactly one
 *     `getOwnPropertyDescriptor` per key. An enumerable getter is never
 *     invoked, and a Proxy cannot serve two different descriptors to two reads.
 *   - Breadth is charged to the node budget BEFORE any descriptor trap runs,
 *     before the snapshot array is allocated and before the O(n log n) sort.
 *   - Cycle detection is PATH-LOCAL (`visiting` is popped in a `finally`), so an
 *     honest shared reference — the same object reached twice down two
 *     different branches, i.e. a DAG — still canonicalizes exactly as it always
 *     did. Only a true ancestor cycle fails closed.
 *   - Every rejection is a typed error carrying a machine-classifiable `code`,
 *     structural-only `context` (never a reflected property name: the walk runs
 *     on attacker-supplied payloads and the error reaches logs and API
 *     responses) and a preserved `cause`.
 */

import { ElizaError } from "@elizaos/core";
import { MAX_RESTORABLE_AGENT_BACKUP_BYTES } from "./agent-backup-limits.js";

/** Classification for a canonical walk that refused to keep going. */
export const CANONICAL_JSON_UNBOUNDED = "CANONICAL_JSON_UNBOUNDED";

/**
 * Rejection hook. Call sites with their own domain error type (export/import
 * failures are `AgentExportError`) pass their own so callers keep catching what
 * they always caught; everything else uses {@link failCanonicalJsonUnbounded}.
 */
export type CanonicalJsonUnbounded = (
  context: Record<string, unknown>,
  cause?: unknown,
) => never;

export type CanonicalJsonOptions = {
  /** Rejected strictly above this. Honest documents are a handful deep. */
  maxDepth: number;
  /** Node ceiling across the whole walk, including sparse array slots. */
  maxNodes: number;
  /**
   * Optional ceiling on the number of characters the canonical form may emit.
   * A cycle guard that is path-local (as it must be, to keep honest DAGs
   * hashing unchanged) still lets a shared-reference graph expand
   * exponentially when it is flattened to a tree; this is the budget that
   * bounds that expansion in output terms rather than input terms. Omit it at
   * a call site whose payload size is already capped upstream.
   */
  maxOutputChars?: number;
  /**
   * How a sparse array hole is rendered. `"omit"` reproduces
   * `array.map(fn).join(",")` (an empty slot); `"null"` reproduces
   * `JSON.stringify`, which renders a hole as `null`. Both are historical
   * behaviours in this repo and both are load-bearing for already-stored
   * digests, so the caller must say which one it is preserving.
   */
  sparseArrayHoles: "omit" | "null";
  /** Typed rejection for this call site. */
  onUnbounded: CanonicalJsonUnbounded;
};

/** Default typed rejection: an {@link ElizaError} with a fatal severity. */
export const failCanonicalJsonUnbounded: CanonicalJsonUnbounded = (
  context,
  cause,
) => {
  throw new ElizaError("Payload exceeds the canonical JSON walk budget", {
    code: CANONICAL_JSON_UNBOUNDED,
    cause,
    context,
    severity: "fatal",
  });
};

/**
 * Budgets for the agent-backup integrity digests.
 *
 * `maxDepth` matches the export walk's 64: an honest backup state — config
 * record, memory log, workspace file map, manifest — is a handful of objects
 * deep, while a decrypted or stored payload can still be legal JSON nested
 * deeply enough to overflow the stack.
 *
 * The node and output ceilings are pinned to
 * {@link MAX_RESTORABLE_AGENT_BACKUP_BYTES} rather than to a smaller round
 * number on purpose: every JSON node costs at least one character in the
 * canonical form, so NO state the restore path is willing to accept can reach
 * either ceiling. That makes them unreachable by honest data by construction —
 * the point that matters, because a state that newly failed to hash would
 * invalidate the backups already stored for it — while still bounding the
 * shared-reference expansion that has no wire-size bound at all.
 */
export const AGENT_BACKUP_CANONICAL_JSON: CanonicalJsonOptions = {
  maxDepth: 64,
  maxNodes: MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  maxOutputChars: MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  sparseArrayHoles: "null",
  onUnbounded: failCanonicalJsonUnbounded,
};

type CanonicalWalkContext = {
  visits: number;
  emitted: number;
  visiting: WeakSet<object>;
  options: CanonicalJsonOptions;
};

function newWalkContext(options: CanonicalJsonOptions): CanonicalWalkContext {
  return { visits: 0, emitted: 0, visiting: new WeakSet<object>(), options };
}

function reserveVisits(ctx: CanonicalWalkContext, count: number): void {
  if (count > ctx.options.maxNodes - ctx.visits) {
    ctx.options.onUnbounded({
      visits: ctx.visits + count,
      maxNodes: ctx.options.maxNodes,
    });
  }
  ctx.visits += count;
}

function reserveOutput(ctx: CanonicalWalkContext, count: number): void {
  const max = ctx.options.maxOutputChars;
  if (max === undefined) return;
  if (count > max - ctx.emitted) {
    ctx.options.onUnbounded({
      emitted: ctx.emitted + count,
      maxOutputChars: max,
    });
  }
  ctx.emitted += count;
}

function emit(ctx: CanonicalWalkContext, text: string): string {
  reserveOutput(ctx, text.length);
  return text;
}

function enterContainer(value: object, ctx: CanonicalWalkContext): void {
  if (ctx.visiting.has(value)) ctx.options.onUnbounded({ cycle: true });
  ctx.visiting.add(value);
}

function inspect<T>(
  ctx: CanonicalWalkContext,
  operation: string,
  read: () => T,
): T {
  try {
    return read();
  } catch (cause) {
    // error-policy:J2 Proxy inspection failures wrap with cause as unbounded.
    ctx.options.onUnbounded({ inspection: operation }, cause);
  }
}

function isCanonicalArray(value: object, ctx: CanonicalWalkContext): boolean {
  return inspect(ctx, "isArray", () => Array.isArray(value));
}

/**
 * Reads `length` off an array exactly once, as an own data descriptor, so a
 * Proxy cannot serve a different value to a second reader. Callers that also
 * need the length (e.g. a manifest `count`) must reuse the returned number
 * rather than calling this again.
 */
function ownArrayLengthWith(value: object, ctx: CanonicalWalkContext): number {
  const descriptor = inspect(ctx, "getOwnPropertyDescriptor", () =>
    Object.getOwnPropertyDescriptor(value, "length"),
  );
  if (descriptor && !("value" in descriptor)) {
    ctx.options.onUnbounded({ accessor: true, property: "length" });
  }
  if (
    !descriptor ||
    typeof descriptor.value !== "number" ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0
  ) {
    ctx.options.onUnbounded({ invalidArrayLength: true });
  }
  return descriptor.value as number;
}

/**
 * One immutable `length` read for a caller that must publish a digest and a
 * count taken from the same snapshot. Pass the result back in as
 * `knownArrayLength`.
 */
export function readCanonicalArrayLength(
  value: object,
  options: CanonicalJsonOptions,
): number {
  return ownArrayLengthWith(value, newWalkContext(options));
}

/** @see readCanonicalArrayLength */
export function isCanonicalJsonArray(
  value: object,
  options: CanonicalJsonOptions,
): boolean {
  return isCanonicalArray(value, newWalkContext(options));
}

/**
 * Values `JSON.stringify` renders as nothing at all: dropped from an object,
 * `null` inside an array. The sorted-key recursions this replaces all deferred
 * to `JSON.stringify` for exactly this, so reproducing it is what keeps their
 * canonical bytes unchanged.
 */
function isJsonInvisible(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  );
}

type DataSnapshot = { key: string; value: unknown };

/**
 * One getOwnPropertyDescriptor per key (prevents Proxy descriptor drift), with
 * the object's breadth charged to the node budget BEFORE any descriptor trap
 * runs, before the snapshot array is allocated and before the O(n log n) sort.
 * A hostile wide object or `ownKeys` Proxy is rejected on the key list alone.
 * The reservation covers every child, so the walks below run with
 * `visitAlreadyReserved`.
 */
function ownEnumerableDataSnapshot(
  value: object,
  ctx: CanonicalWalkContext,
): DataSnapshot[] {
  const keys = inspect(ctx, "ownKeys", () => Reflect.ownKeys(value));
  reserveVisits(ctx, keys.length);
  const snapshot: DataSnapshot[] = [];
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const descriptor = inspect(ctx, "getOwnPropertyDescriptor", () =>
      Object.getOwnPropertyDescriptor(value, key),
    );
    if (!descriptor?.enumerable) continue;
    if (!("value" in descriptor)) {
      ctx.options.onUnbounded({ accessor: true, container: "object" });
    }
    if (isJsonInvisible(descriptor.value)) continue;
    snapshot.push({ key, value: descriptor.value });
  }
  snapshot.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  return snapshot;
}

function canonicalWalk(
  value: unknown,
  depth: number,
  ctx: CanonicalWalkContext,
  visitAlreadyReserved = false,
  /**
   * Array length already read by the caller (root only). Reusing it keeps the
   * digest and any published `count` on one immutable snapshot.
   */
  knownArrayLength?: number,
): string {
  if (depth > ctx.options.maxDepth) {
    ctx.options.onUnbounded({ depth, max: ctx.options.maxDepth });
  }
  if (!visitAlreadyReserved) reserveVisits(ctx, 1);
  if (value === null || typeof value !== "object") {
    // Object keys carrying these were already dropped by the snapshot; reaching
    // one here means an array slot, which `JSON.stringify` renders as `null`.
    if (isJsonInvisible(value)) return emit(ctx, "null");
    return emit(ctx, JSON.stringify(value));
  }

  enterContainer(value, ctx);
  try {
    if (isCanonicalArray(value, ctx)) {
      const length = knownArrayLength ?? ownArrayLengthWith(value, ctx);
      reserveVisits(ctx, length);
      // String-build so inherited Array.prototype index accessors cannot
      // trap assignment into a preallocated parts array.
      let body = "";
      for (let index = 0; index < length; index += 1) {
        if (index > 0) body += emit(ctx, ",");
        const descriptor = inspect(ctx, "getOwnPropertyDescriptor", () =>
          Object.getOwnPropertyDescriptor(value, String(index)),
        );
        if (!descriptor) {
          // Sparse hole: whichever empty-slot rendering this call site has
          // already published digests for.
          if (ctx.options.sparseArrayHoles === "null")
            body += emit(ctx, "null");
          continue;
        }
        if (!("value" in descriptor)) {
          ctx.options.onUnbounded({
            accessor: true,
            container: "array",
            index,
          });
        }
        body += canonicalWalk(descriptor.value, depth + 1, ctx, true);
      }
      return `${emit(ctx, "[")}${body}${emit(ctx, "]")}`;
    }

    const snapshot = ownEnumerableDataSnapshot(value, ctx);
    let body = "";
    for (let index = 0; index < snapshot.length; index += 1) {
      if (index > 0) body += emit(ctx, ",");
      const entry = snapshot[index] as DataSnapshot;
      body += emit(ctx, `${JSON.stringify(entry.key)}:`);
      body += canonicalWalk(entry.value, depth + 1, ctx, true);
    }
    return `${emit(ctx, "{")}${body}${emit(ctx, "}")}`;
  } finally {
    ctx.visiting.delete(value);
  }
}

/**
 * Canonical JSON text for `value`, bounded by `options`.
 *
 * Mirrors `JSON.stringify` for every value the unbounded predecessors reached:
 * keys sorted, `undefined`-valued object keys dropped, `undefined` array slots
 * rendered `null`, non-plain objects (`Date`, `Map`, `Set`) rendered from their
 * own enumerable string keys — which is exactly what the sorted-key recursion
 * they replace already did.
 */
export function canonicalJsonString(
  value: unknown,
  options: CanonicalJsonOptions,
  knownArrayLength?: number,
): string {
  return canonicalWalk(
    value,
    0,
    newWalkContext(options),
    false,
    knownArrayLength,
  );
}

/**
 * `JSON.stringify`-faithful wrapper for the call sites that spelled this
 * `JSON.stringify(canonicalize(value))`.
 *
 * `JSON.stringify(undefined)` is `undefined`, not `"null"`, and callers such as
 * the backup differ rely on that to tell an absent config value apart from a
 * `null` one (same for a bare function or symbol at the root). Its declared return type is `string` for the same reason
 * `JSON.stringify`'s most-used overload is: every call site here passes a
 * defined value, and widening it would ripple through unrelated signatures.
 */
export function stableJsonString(
  value: unknown,
  options: CanonicalJsonOptions,
): string {
  if (isJsonInvisible(value)) return undefined as unknown as string;
  return canonicalJsonString(value, options);
}
