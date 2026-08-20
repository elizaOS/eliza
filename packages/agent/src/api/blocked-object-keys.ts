/**
 * Bounds the blocked-object-key walk used to sanitize OpenAI-compat and
 * connector request JSON. JSON.parse accepts a 20k-deep nest that the previous
 * recursive walk RangeError'd, 500ing `/v1/chat/completions`. Depth, node, and
 * cycle limits are all load-bearing — descriptor-only reads so a getter cannot
 * hang the agent, and sparse holes still consume the node budget.
 */

import { ElizaError } from "@elizaos/core";

export function isBlockedObjectKey(key: string): boolean {
  return (
    key === "__proto__" ||
    key === "constructor" ||
    key === "prototype" ||
    key === "$include"
  );
}

/** Honest request JSON is a handful of objects deep. */
export const MAX_BLOCKED_OBJECT_DEPTH = 32;
/**
 * Node ceiling across the whole walk, including sparse array holes. The chat
 * routes accept large histories and tool schemas, so this must remain well
 * above an ordinary token-sized request while still bounding synthetic sparse
 * arrays passed by in-process callers.
 */
export const MAX_BLOCKED_OBJECT_NODES = 100_000;
export const BLOCKED_OBJECT_GRAPH_UNBOUNDED = "BLOCKED_OBJECT_GRAPH_UNBOUNDED";

type BlockedObjectWalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failBlockedObjectGraphUnbounded(
  context: Record<string, unknown>,
): never {
  throw new ElizaError(
    "Request JSON exceeds the blocked-object-key walk budget",
    {
      code: BLOCKED_OBJECT_GRAPH_UNBOUNDED,
      context,
      severity: "fatal",
    },
  );
}

function reserveBlockedObjectVisits(
  ctx: BlockedObjectWalkContext,
  count: number,
): void {
  if (count > MAX_BLOCKED_OBJECT_NODES - ctx.visits) {
    failBlockedObjectGraphUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_BLOCKED_OBJECT_NODES,
    });
  }
  ctx.visits += count;
}

function enterBlockedObjectContainer(
  value: object,
  ctx: BlockedObjectWalkContext,
): void {
  if (ctx.visiting.has(value)) {
    failBlockedObjectGraphUnbounded({ cycle: true });
  }
  ctx.visiting.add(value);
}

function ownEnumerableStringKeys(value: object): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    keys.push(key);
  }
  return keys;
}

function ownArrayLength(value: unknown[]): number {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0
  ) {
    failBlockedObjectGraphUnbounded({ invalidArrayLength: true });
  }
  return descriptor.value;
}

function ownArrayElement(
  value: unknown[],
  index: number,
): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    failBlockedObjectGraphUnbounded({ arrayAccessor: true, index });
  }
  return descriptor;
}

function walkHasBlockedObjectKey(
  value: unknown,
  depth: number,
  ctx: BlockedObjectWalkContext,
  visitAlreadyReserved = false,
): boolean {
  if (depth > MAX_BLOCKED_OBJECT_DEPTH) {
    failBlockedObjectGraphUnbounded({
      depth,
      max: MAX_BLOCKED_OBJECT_DEPTH,
    });
  }
  if (!visitAlreadyReserved) reserveBlockedObjectVisits(ctx, 1);
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;

  enterBlockedObjectContainer(value, ctx);
  try {
    if (Array.isArray(value)) {
      const length = ownArrayLength(value);
      reserveBlockedObjectVisits(ctx, length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownArrayElement(value, index);
        if (!descriptor) continue;
        if (walkHasBlockedObjectKey(descriptor.value, depth + 1, ctx, true)) {
          return true;
        }
      }
      return false;
    }

    const keys = ownEnumerableStringKeys(value);
    reserveBlockedObjectVisits(ctx, keys.length);
    for (const key of keys) {
      if (isBlockedObjectKey(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      if (walkHasBlockedObjectKey(descriptor.value, depth + 1, ctx, true)) {
        return true;
      }
    }
    return false;
  } finally {
    ctx.visiting.delete(value);
  }
}

function cloneWithoutBlockedObjectKeysWalk<T>(
  value: T,
  depth: number,
  ctx: BlockedObjectWalkContext,
  visitAlreadyReserved = false,
): T {
  if (depth > MAX_BLOCKED_OBJECT_DEPTH) {
    failBlockedObjectGraphUnbounded({
      depth,
      max: MAX_BLOCKED_OBJECT_DEPTH,
    });
  }
  if (!visitAlreadyReserved) reserveBlockedObjectVisits(ctx, 1);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  enterBlockedObjectContainer(value, ctx);
  try {
    if (Array.isArray(value)) {
      const length = ownArrayLength(value);
      reserveBlockedObjectVisits(ctx, length);
      const next: unknown[] = [];
      next.length = length;
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownArrayElement(value, index);
        if (!descriptor) continue;
        next[index] = cloneWithoutBlockedObjectKeysWalk(
          descriptor.value,
          depth + 1,
          ctx,
          true,
        );
      }
      return next as T;
    }

    const keys = ownEnumerableStringKeys(value);
    reserveBlockedObjectVisits(ctx, keys.length);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (isBlockedObjectKey(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      out[key] = cloneWithoutBlockedObjectKeysWalk(
        descriptor.value,
        depth + 1,
        ctx,
        true,
      );
    }
    return out as T;
  } finally {
    ctx.visiting.delete(value);
  }
}

export function hasBlockedObjectKeyDeep(value: unknown): boolean {
  try {
    return walkHasBlockedObjectKey(value, 0, {
      visits: 0,
      visiting: new WeakSet<object>(),
    });
  } catch (error) {
    // error-policy:J3 untrusted request JSON; an over-budget nest is rejected
    // as blocked rather than RangeErroring the OpenAI-compat chat handler.
    if (
      error instanceof ElizaError &&
      error.code === BLOCKED_OBJECT_GRAPH_UNBOUNDED
    ) {
      return true;
    }
    throw error;
  }
}

export function cloneWithoutBlockedObjectKeys<T>(value: T): T {
  return cloneWithoutBlockedObjectKeysWalk(value, 0, {
    visits: 0,
    visiting: new WeakSet<object>(),
  });
}
