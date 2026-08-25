/**
 * Bounds the nested provider-options walk used when z.ai text handlers
 * accept `GenerateTextParams.providerOptions`. Hostile nests RangeError'd
 * or threw TypeError on JSON.stringify. Depth, node, and cycle limits
 * are all load-bearing. Descriptor-only reads so a getter cannot hang
 * the z.ai generate path.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_ZAI_PROVIDER_OPTIONS_DEPTH = 32;
export const MAX_ZAI_PROVIDER_OPTIONS_NODES = 2_048;
export const ZAI_PROVIDER_OPTIONS_UNBOUNDED = "ZAI_PROVIDER_OPTIONS_UNBOUNDED";

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

type ProviderOptionValue =
  | string
  | number
  | boolean
  | null
  | ProviderOptionValue[]
  | { [key: string]: ProviderOptionValue | undefined };

export type ProviderOptions = {
  [key: string]: ProviderOptionValue | undefined;
  agentName?: string;
};

function failUnbounded(context: Record<string, unknown>, cause?: unknown): never {
  throw new ElizaError("z.ai providerOptions JSON exceeds the parse walk budget", {
    code: ZAI_PROVIDER_OPTIONS_UNBOUNDED,
    context,
    cause,
    severity: "fatal",
  });
}

function reserve(ctx: WalkContext, count: number): void {
  if (count > MAX_ZAI_PROVIDER_OPTIONS_NODES - ctx.visits) {
    failUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_ZAI_PROVIDER_OPTIONS_NODES,
    });
  }
  ctx.visits += count;
}

function inspectRecord<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J2 Preserve reflection failures while adding the failed operation.
    failUnbounded({ inspection: operation }, cause);
  }
}

function ownDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  return inspectRecord("getOwnPropertyDescriptor", () =>
    Object.getOwnPropertyDescriptor(value, key)
  );
}

function isArrayRecord(value: unknown): value is unknown[] {
  return inspectRecord("isArray", () => Array.isArray(value));
}

function assertPlainRecord(value: object): void {
  const prototype = inspectRecord("getPrototypeOf", () => Object.getPrototypeOf(value));
  // Null-prototype records are an explicitly supported JSON-record shape. The
  // copier still returns an ordinary inert data record, so neither input shape
  // can carry custom prototype behavior across the provider boundary.
  if (prototype !== Object.prototype && prototype !== null) {
    failUnbounded({ invalidRecordPrototype: true });
  }
}

function newWalkContext(): WalkContext {
  return {
    visits: 0,
    visiting: new WeakSet<object>(),
  };
}

/**
 * Production z.ai boundary: descriptor-only validation/copy of
 * `providerOptions` with one shared node/cycle budget.
 */
export function readProviderOptions(value: unknown): ProviderOptions {
  if (typeof value !== "object" || value === null || isArrayRecord(value)) {
    failUnbounded({ invalidRoot: true });
  }
  const copied = readProviderOptionValue(value, 0, newWalkContext());
  if (copied === null || typeof copied !== "object" || Array.isArray(copied)) {
    failUnbounded({ invalidRoot: true });
  }
  return copied as ProviderOptions;
}

function readProviderOptionValue(
  value: unknown,
  depth: number,
  ctx: WalkContext,
  visitAlreadyReserved = false
): ProviderOptionValue | undefined {
  if (depth > MAX_ZAI_PROVIDER_OPTIONS_DEPTH) {
    failUnbounded({ depth, max: MAX_ZAI_PROVIDER_OPTIONS_DEPTH });
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (!visitAlreadyReserved) reserve(ctx, 1);
    return value;
  }
  if (typeof value === "number") {
    if (!visitAlreadyReserved) reserve(ctx, 1);
    return Number.isFinite(value) ? value : null;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object") {
    if (!visitAlreadyReserved) reserve(ctx, 1);
    failUnbounded({ invalidType: typeof value });
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
      const out = new Array<ProviderOptionValue>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownDescriptor(value, String(index));
        if (!descriptor) continue;
        if (!("value" in descriptor)) {
          failUnbounded({ accessor: true, side: "array", index });
        }
        const nested = readProviderOptionValue(descriptor.value, depth + 1, ctx, true);
        out[index] = nested ?? null;
      }
      return out;
    }

    assertPlainRecord(value);
    const keys = inspectRecord("ownKeys", () => Reflect.ownKeys(value));
    reserve(ctx, keys.length);
    const record: { [key: string]: ProviderOptionValue | undefined } = {};
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = ownDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) {
        failUnbounded({ accessor: true, side: "object", key });
      }
      if (descriptor.value === undefined) {
        Object.defineProperty(record, key, {
          value: undefined,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        continue;
      }
      const nested = readProviderOptionValue(descriptor.value, depth + 1, ctx, true);
      Object.defineProperty(record, key, {
        value: nested,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return record;
  } finally {
    ctx.visiting.delete(value);
  }
}
