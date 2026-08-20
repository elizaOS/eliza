/**
 * Bounds the nested JSON walk used when Google GenAI tool-call `args` are
 * converted into elizaOS `JsonValue`. Hostile nests RangeError'd
 * `toJsonValue` at 8k depth on Node 24.15.0. Depth, node, and cycle limits
 * are all load-bearing. Descriptor-only reads so a getter cannot hang the
 * Gemini text-handler tool-call path.
 */

import { ElizaError, type JsonValue } from "@elizaos/core";

export const MAX_GOOGLE_GENAI_JSON_DEPTH = 32;
export const MAX_GOOGLE_GENAI_JSON_NODES = 2_048;
export const GOOGLE_GENAI_JSON_UNBOUNDED = "GOOGLE_GENAI_JSON_UNBOUNDED";

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failUnbounded(
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new ElizaError(
    "Google GenAI tool-call JSON exceeds the parse walk budget",
    {
      code: GOOGLE_GENAI_JSON_UNBOUNDED,
      context,
      cause,
      severity: "fatal",
    },
  );
}

function reserve(ctx: WalkContext, count: number): void {
  if (count > MAX_GOOGLE_GENAI_JSON_NODES - ctx.visits) {
    failUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_GOOGLE_GENAI_JSON_NODES,
    });
  }
  ctx.visits += count;
}

function inspectRecord<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J3 Proxy inspection failures make untrusted tool-call JSON invalid.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !isArrayRecord(value));
}

function newWalkContext(): WalkContext {
  return {
    visits: 0,
    visiting: new WeakSet<object>(),
  };
}

/**
 * Production tool-call boundary: descriptor-only conversion of Gemini
 * `functionCall.args` with one shared node/cycle budget.
 */
export function toToolArguments(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value)) {
    return {};
  }
  const jsonValue = toJsonValueInner(value, 0, newWalkContext());
  return isRecord(jsonValue) ? (jsonValue as Record<string, JsonValue>) : {};
}

export function toJsonValue(value: unknown): JsonValue {
  return toJsonValueInner(value, 0, newWalkContext());
}

function toJsonValueInner(
  value: unknown,
  depth: number,
  ctx: WalkContext,
  visitAlreadyReserved = false,
): JsonValue {
  if (depth > MAX_GOOGLE_GENAI_JSON_DEPTH) {
    failUnbounded({ depth, max: MAX_GOOGLE_GENAI_JSON_DEPTH });
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    if (!visitAlreadyReserved) reserve(ctx, 1);
    return value;
  }
  if (typeof value === "number") {
    if (!visitAlreadyReserved) reserve(ctx, 1);
    return Number.isFinite(value) ? value : null;
  }
  if (value === undefined || typeof value !== "object") {
    if (!visitAlreadyReserved) reserve(ctx, 1);
    return String(value);
  }
  if (!visitAlreadyReserved) reserve(ctx, 1);
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
      const out = new Array<JsonValue>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownDescriptor(value, String(index));
        if (!descriptor) continue;
        if (!("value" in descriptor)) {
          failUnbounded({ accessor: true, side: "array", index });
        }
        out[index] = toJsonValueInner(descriptor.value, depth + 1, ctx, true);
      }
      return out;
    }

    const keys = inspectRecord("ownKeys", () => Reflect.ownKeys(value));
    reserve(ctx, keys.length);
    const record: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = ownDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) {
        failUnbounded({ accessor: true, side: "object", key });
      }
      if (descriptor.value === undefined) continue;
      record[key] = toJsonValueInner(descriptor.value, depth + 1, ctx, true);
    }
    return record;
  } finally {
    ctx.visiting.delete(value);
  }
}
