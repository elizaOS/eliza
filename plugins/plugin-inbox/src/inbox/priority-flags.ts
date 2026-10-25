/**
 * Bounds the nested `flags` walk used when parsing LLM priority-scoring
 * records. Model JSON can nest flag arrays; the previous recursive
 * `Array.flatMap` RangeError'd an 8k nest on Node 24.15.0. Depth, node, and
 * cycle limits are all load-bearing. Every reflective read is fail-closed
 * to the typed unbounded error; array length and indexes come from own
 * data descriptors so Proxy get/has traps cannot hang the scorer.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_INBOX_PRIORITY_FLAGS_DEPTH = 32;
export const MAX_INBOX_PRIORITY_FLAGS_NODES = 2_048;
export const MAX_INBOX_PRIORITY_FLAGS_OUTPUT = 2_048;
export const INBOX_PRIORITY_FLAGS_UNBOUNDED = "INBOX_PRIORITY_FLAGS_UNBOUNDED";

type WalkContext = {
  visits: number;
  outputs: number;
  visiting: WeakSet<object>;
};

function failUnbounded(
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new ElizaError("Inbox priority flags exceed the parse walk budget", {
    code: INBOX_PRIORITY_FLAGS_UNBOUNDED,
    context,
    cause,
    severity: "fatal",
  });
}

function reserve(ctx: WalkContext, count: number): void {
  if (count > MAX_INBOX_PRIORITY_FLAGS_NODES - ctx.visits) {
    failUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_INBOX_PRIORITY_FLAGS_NODES,
    });
  }
  ctx.visits += count;
}

function inspectRecord<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J3 Proxy inspection failures make untrusted model JSON invalid.
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

export function parseFlags(value: unknown): string[] {
  return parseFlagsInner(value, 0, {
    visits: 0,
    outputs: 0,
    visiting: new WeakSet<object>(),
  });
}

function parseFlagsInner(
  value: unknown,
  depth: number,
  ctx: WalkContext,
  visitAlreadyReserved = false,
): string[] {
  if (depth > MAX_INBOX_PRIORITY_FLAGS_DEPTH) {
    failUnbounded({ depth, max: MAX_INBOX_PRIORITY_FLAGS_DEPTH });
  }
  if (typeof value === "string") {
    if (!visitAlreadyReserved) reserve(ctx, 1);
    const trimmed = value.trim();
    if (
      trimmed.length === 0 ||
      trimmed === "[]" ||
      trimmed.toLowerCase() === "null" ||
      trimmed.toLowerCase() === "none"
    ) {
      return [];
    }
    const remainingOutputs = MAX_INBOX_PRIORITY_FLAGS_OUTPUT - ctx.outputs;
    const flags: string[] = [];
    let segmentStart = 0;
    for (let index = 0; index <= trimmed.length; index += 1) {
      const character = trimmed[index];
      if (index < trimmed.length && character !== "|" && character !== ",") {
        continue;
      }
      const flag = trimmed
        .slice(segmentStart, index)
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
      segmentStart = index + 1;
      if (flag.length === 0) continue;
      if (flags.length >= remainingOutputs) {
        failUnbounded({
          outputs: ctx.outputs + flags.length + 1,
          maxOutputs: MAX_INBOX_PRIORITY_FLAGS_OUTPUT,
        });
      }
      flags.push(flag);
    }
    ctx.outputs += flags.length;
    return flags;
  }
  if (!isArrayRecord(value)) {
    return [];
  }
  if (!visitAlreadyReserved) reserve(ctx, 1);
  if (ctx.visiting.has(value)) {
    failUnbounded({ cycle: true });
  }
  ctx.visiting.add(value);
  try {
    const lengthDescriptor = ownDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) {
      failUnbounded({ invalidArrayLength: true });
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      failUnbounded({ invalidArrayLength: true });
    }
    reserve(ctx, length);
    const flags: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = ownDescriptor(value, String(index));
      if (!descriptor) continue;
      if (!("value" in descriptor)) {
        failUnbounded({ accessor: true, side: "array" });
      }
      flags.push(...parseFlagsInner(descriptor.value, depth + 1, ctx, true));
    }
    return flags;
  } finally {
    ctx.visiting.delete(value);
  }
}
