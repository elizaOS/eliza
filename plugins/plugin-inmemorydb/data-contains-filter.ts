/**
 * Bounds the nested component-data filter walk used by InMemoryDatabaseAdapter.
 * Stored component `data` and query `componentDataFilter` are untrusted JSON;
 * the previous recursive matcher RangeError'd an 8k nest on Node 24.15.0.
 * Depth, node, and cycle limits are all load-bearing.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_INMEMORY_FILTER_DEPTH = 32;
export const MAX_INMEMORY_FILTER_NODES = 2_048;
export const INMEMORY_FILTER_UNBOUNDED = "INMEMORY_FILTER_UNBOUNDED";

type WalkContext = {
  visits: number;
  visitingValues: WeakSet<object>;
  visitingFilters: WeakSet<object>;
};

function failUnbounded(context: Record<string, unknown>): never {
  throw new ElizaError("In-memory component filter exceeds the match walk budget", {
    code: INMEMORY_FILTER_UNBOUNDED,
    context,
    severity: "fatal",
  });
}

function reserve(ctx: WalkContext, count: number): void {
  if (count > MAX_INMEMORY_FILTER_NODES - ctx.visits) {
    failUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_INMEMORY_FILTER_NODES,
    });
  }
  ctx.visits += count;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownEnumerableDataEntries(value: object): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) continue;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function enter(value: object, set: "visitingValues" | "visitingFilters", ctx: WalkContext): void {
  if (ctx[set].has(value)) {
    failUnbounded({ cycle: true });
  }
  ctx[set].add(value);
}

export function dataContainsFilter(
  value: unknown,
  filter: Record<string, unknown> | undefined
): boolean {
  if (!filter) return true;
  return dataContainsFilterInner(value, filter, 0, {
    visits: 0,
    visitingValues: new WeakSet<object>(),
    visitingFilters: new WeakSet<object>(),
  });
}

function dataContainsFilterInner(
  value: unknown,
  filter: Record<string, unknown>,
  depth: number,
  ctx: WalkContext,
  visitAlreadyReserved = false
): boolean {
  if (depth > MAX_INMEMORY_FILTER_DEPTH) {
    failUnbounded({ depth, max: MAX_INMEMORY_FILTER_DEPTH });
  }
  if (!visitAlreadyReserved) reserve(ctx, 1);
  if (!isPlainObject(value)) return false;

  enter(value, "visitingValues", ctx);
  enter(filter, "visitingFilters", ctx);
  try {
    const expectedEntries = ownEnumerableDataEntries(filter);
    reserve(ctx, expectedEntries.length);
    for (const [key, expected] of expectedEntries) {
      const actualDescriptor = Object.getOwnPropertyDescriptor(value, key);
      const actual =
        actualDescriptor && "value" in actualDescriptor ? actualDescriptor.value : undefined;

      if (isPlainObject(expected)) {
        if (!dataContainsFilterInner(actual, expected, depth + 1, ctx, true)) {
          return false;
        }
        continue;
      }

      if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return false;
        reserve(ctx, expected.length + actual.length);
        for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
          if (!(expectedIndex in expected)) continue;
          const expectedItem = expected[expectedIndex];
          let found = false;
          for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
            if (!(actualIndex in actual)) continue;
            const actualItem = actual[actualIndex];
            const matched = isPlainObject(expectedItem)
              ? dataContainsFilterInner(actualItem, expectedItem, depth + 1, ctx, true)
              : actualItem === expectedItem;
            if (matched) {
              found = true;
              break;
            }
          }
          if (!found) return false;
        }
        continue;
      }

      if (actual !== expected) return false;
    }
    return true;
  } finally {
    ctx.visitingFilters.delete(filter);
    ctx.visitingValues.delete(value);
  }
}
