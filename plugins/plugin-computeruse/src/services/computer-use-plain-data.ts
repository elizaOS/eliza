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
export const MAX_COMPUTER_USE_PLAIN_DATA_CHARS = 64 * 1_024;
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

function requireBoundedOutput(length: number): void {
  if (length > MAX_COMPUTER_USE_PLAIN_DATA_CHARS) {
    failUnbounded({
      outputChars: length,
      maxChars: MAX_COMPUTER_USE_PLAIN_DATA_CHARS,
    });
  }
}

function inspectRecord<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J2 Preserve the reflection/conversion cause in the typed boundary error.
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
    requireBoundedOutput(value.length);
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
    const rendered = String(value);
    requireBoundedOutput(rendered.length);
    return rendered;
  }
  if (typeof value !== "object") {
    failUnbounded({ unsupportedType: typeof value });
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
      let outputChars = lines[0].length;
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownDescriptor(value, String(index));
        if (!descriptor) {
          // Preserve the prior Array#map rendering: a sparse slot contributes
          // one blank line while still consuming the bounded traversal budget.
          outputChars += 1;
          requireBoundedOutput(outputChars);
          lines.push("");
          continue;
        }
        if (!("value" in descriptor)) {
          failUnbounded({ accessor: true, side: "array", index });
        }
        const nested = renderPlainDataInner(
          descriptor.value,
          depth + 1,
          ctx,
          true,
        );
        outputChars += 1 + prefix.length + 2 + nested.length;
        requireBoundedOutput(outputChars);
        lines.push(`${prefix}- ${nested}`);
      }
      return lines.join("\n");
    }

    const keys = inspectRecord("ownKeys", () => Reflect.ownKeys(value));
    reserve(ctx, keys.length);
    const lines: string[] = [];
    let outputChars = 0;
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = ownDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) {
        failUnbounded({ accessor: true, side: "object", key });
      }
      const nestedValue = descriptor.value;
      const nested = renderPlainDataInner(nestedValue, depth + 1, ctx, true);
      const separator =
        nestedValue && typeof nestedValue === "object" ? ":\n" : ": ";
      const lineLength = key.length + separator.length + nested.length;
      outputChars += (lines.length === 0 ? 0 : 1) + lineLength;
      requireBoundedOutput(outputChars);
      if (nestedValue && typeof nestedValue === "object") {
        lines.push(`${key}:\n${nested}`);
      } else {
        lines.push(`${key}: ${nested}`);
      }
    }
    return lines.join("\n");
  } finally {
    ctx.visiting.delete(value);
  }
}
