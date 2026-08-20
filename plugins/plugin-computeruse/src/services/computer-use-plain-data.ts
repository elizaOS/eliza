/**
 * Bounds the nested snapshot pretty-print used when ComputerUseService
 * serializes browser/window state into action `content`. Hostile nests
 * RangeError'd `renderPlainData` at 8k depth on Node 24.15.0. Depth, node,
 * and cycle limits are all load-bearing. Descriptor-only reads so a getter
 * cannot hang the computer-use action path.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_COMPUTER_USE_PLAIN_DATA_DEPTH = 32;
export const MAX_COMPUTER_USE_PLAIN_DATA_NODES = 2_048;
export const COMPUTER_USE_PLAIN_DATA_UNBOUNDED =
  "COMPUTER_USE_PLAIN_DATA_UNBOUNDED";

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failUnbounded(
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new ElizaError(
    "Computer-use snapshot exceeds the plain-data walk budget",
    {
      code: COMPUTER_USE_PLAIN_DATA_UNBOUNDED,
      context,
      cause,
      severity: "fatal",
    },
  );
}

function reserve(ctx: WalkContext, count: number): void {
  if (count > MAX_COMPUTER_USE_PLAIN_DATA_NODES - ctx.visits) {
    failUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_COMPUTER_USE_PLAIN_DATA_NODES,
    });
  }
  ctx.visits += count;
}

function inspectRecord<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J3 Proxy inspection failures make an untrusted snapshot invalid.
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

export function stringifyData(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return renderPlainData(value);
}

export function renderPlainData(value: unknown): string {
  return renderPlainDataInner(value, 0, {
    visits: 0,
    visiting: new WeakSet<object>(),
  });
}

function renderPlainDataInner(
  value: unknown,
  depth: number,
  ctx: WalkContext,
  visitAlreadyReserved = false,
): string {
  if (depth > MAX_COMPUTER_USE_PLAIN_DATA_DEPTH) {
    failUnbounded({ depth, max: MAX_COMPUTER_USE_PLAIN_DATA_DEPTH });
  }
  if (value === null || value === undefined) {
    return "none";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (!visitAlreadyReserved) reserve(ctx, 1);
    return String(value);
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (!visitAlreadyReserved) reserve(ctx, 1);
  if (ctx.visiting.has(value)) {
    failUnbounded({ cycle: true });
  }
  ctx.visiting.add(value);
  const prefix = "  ".repeat(depth);
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
      if (length === 0) {
        return "items[0]:";
      }
      const lines: string[] = [`items[${length}]:`];
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownDescriptor(value, String(index));
        if (!descriptor) continue;
        if (!("value" in descriptor)) {
          failUnbounded({ accessor: true, side: "array", index });
        }
        lines.push(
          `${prefix}- ${renderPlainDataInner(descriptor.value, depth + 1, ctx, true)}`,
        );
      }
      return lines.join("\n");
    }

    const keys = inspectRecord("ownKeys", () => Reflect.ownKeys(value));
    reserve(ctx, keys.length);
    const lines: string[] = [];
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = ownDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) {
        failUnbounded({ accessor: true, side: "object", key });
      }
      const nestedValue = descriptor.value;
      if (nestedValue && typeof nestedValue === "object") {
        lines.push(
          `${key}:\n${renderPlainDataInner(nestedValue, depth + 1, ctx, true)}`,
        );
      } else {
        lines.push(
          `${key}: ${renderPlainDataInner(nestedValue, depth + 1, ctx, true)}`,
        );
      }
    }
    return lines.join("\n");
  } finally {
    ctx.visiting.delete(value);
  }
}
