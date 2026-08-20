/**
 * Bounds the nested JSON type-guard used when Codex SSE function-call
 * `arguments` are JSON.parsed. Hostile nests RangeError'd `isJsonValue` at 8k
 * depth on Node 24.15.0 after JSON.parse succeeded. Depth, node, and cycle
 * limits are all load-bearing. Descriptor-only reads so a getter cannot hang
 * the Codex generate path.
 */

import { ElizaError, type JsonValue } from "@elizaos/core";

export const MAX_CODEX_JSON_DEPTH = 32;
export const MAX_CODEX_JSON_NODES = 2_048;
export const CODEX_JSON_UNBOUNDED = "CODEX_JSON_UNBOUNDED";

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failUnbounded(
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new ElizaError("Codex tool-call JSON exceeds the parse walk budget", {
    code: CODEX_JSON_UNBOUNDED,
    context,
    cause,
    severity: "fatal",
  });
}

function reserve(ctx: WalkContext, count: number): void {
  if (count > MAX_CODEX_JSON_NODES - ctx.visits) {
    failUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_CODEX_JSON_NODES,
    });
  }
  ctx.visits += count;
}

function inspectRecord<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J2 Proxy inspection failures wrap with cause as unbounded.
    failUnbounded({ inspection: operation }, cause);
  }
}

function ownDescriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  return inspectRecord("getOwnPropertyDescriptor", () =>
    Object.getOwnPropertyDescriptor(value, key),
  );
}

function isArrayRecord(value: unknown): value is unknown[] {
  return inspectRecord("isArray", () => Array.isArray(value));
}

/**
 * Production Codex tool-arg boundary: descriptor-only JSON record check with
 * one shared node/cycle budget. Throws CODEX_JSON_UNBOUNDED instead of
 * RangeError; returns false for non-JSON values.
 */
export function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return walkJsonValue(value, 0, {
    visits: 0,
    visiting: new WeakSet<object>(),
  });
}

export function isJsonValue(value: unknown): value is JsonValue {
  return walkJsonValue(value, 0, {
    visits: 0,
    visiting: new WeakSet<object>(),
  });
}

function walkJsonValue(value: unknown, depth: number, ctx: WalkContext): boolean {
  if (depth > MAX_CODEX_JSON_DEPTH) {
    failUnbounded({ depth, max: MAX_CODEX_JSON_DEPTH });
  }
  if (typeof value === "function") {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    reserve(ctx, 1);
    return true;
  }
  if (value === undefined || typeof value !== "object") {
    return false;
  }
  reserve(ctx, 1);
  if (ctx.visiting.has(value)) {
    failUnbounded({ cycle: true });
  }
  ctx.visiting.add(value);
  try {
    if (isArrayRecord(value)) {
      const lengthDescriptor = ownDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor)) {
        failUnbounded({ invalidArrayLength: true });
      }
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        failUnbounded({ invalidArrayLength: true });
      }
      reserve(ctx, length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownDescriptor(value, String(index));
        if (!descriptor) continue;
        if (!("value" in descriptor)) {
          failUnbounded({ accessor: true, side: "array", index });
        }
        if (!walkJsonValue(descriptor.value, depth + 1, ctx)) {
          return false;
        }
      }
      return true;
    }

    const keys = inspectRecord("ownKeys", () => Reflect.ownKeys(value));
    reserve(ctx, keys.length);
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = ownDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) {
        failUnbounded({ accessor: true, side: "object", key });
      }
      if (!walkJsonValue(descriptor.value, depth + 1, ctx)) {
        return false;
      }
    }
    return true;
  } finally {
    ctx.visiting.delete(value);
  }
}
