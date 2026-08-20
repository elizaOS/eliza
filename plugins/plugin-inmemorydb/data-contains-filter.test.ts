/**
 * Deterministic tests for the in-memory component-data filter bound. No live
 * database: the matcher is the production walk used by getEntities.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  dataContainsFilter,
  INMEMORY_FILTER_UNBOUNDED,
  MAX_INMEMORY_FILTER_DEPTH,
  MAX_INMEMORY_FILTER_NODES,
} from "./data-contains-filter";

function nestObj(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) {
    value = { k: value };
  }
  return value;
}

describe("dataContainsFilter", () => {
  it("matches an honest nested record", () => {
    expect(dataContainsFilter({ a: { b: 1 }, extra: true }, { a: { b: 1 } })).toBe(true);
    expect(dataContainsFilter({ a: { b: 2 } }, { a: { b: 1 } })).toBe(false);
  });

  it(`accepts a ${MAX_INMEMORY_FILTER_DEPTH}-deep nest`, () => {
    const nest = nestObj(MAX_INMEMORY_FILTER_DEPTH);
    expect(dataContainsFilter(nest, nest)).toBe(true);
  });

  it(`throws ${INMEMORY_FILTER_UNBOUNDED} one past depth ${MAX_INMEMORY_FILTER_DEPTH}`, () => {
    const nest = nestObj(MAX_INMEMORY_FILTER_DEPTH + 1);
    try {
      dataContainsFilter(nest, nest);
      expect.unreachable("filter should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INMEMORY_FILTER_UNBOUNDED);
    }
  });

  it(`throws ${INMEMORY_FILTER_UNBOUNDED} past ${MAX_INMEMORY_FILTER_NODES} sparse holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_INMEMORY_FILTER_NODES] = { leaf: true };
    const value = { items: sparse };
    const filter = { items: sparse };
    try {
      dataContainsFilter(value, filter);
      expect.unreachable("filter should fail closed on over-budget sparse length");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INMEMORY_FILTER_UNBOUNDED);
    }
  });

  it("throws on a cyclic filter without hanging", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const started = performance.now();
    try {
      dataContainsFilter(cyclic, cyclic);
      expect.unreachable("filter should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INMEMORY_FILTER_UNBOUNDED);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("does not invoke accessors while matching", () => {
    let invoked = 0;
    const hostile = {
      safe: 1,
      get trap(): Record<string, unknown> {
        invoked += 1;
        return nestObj(20_000);
      },
    };
    expect(dataContainsFilter(hostile, { safe: 1 })).toBe(true);
    expect(invoked).toBe(0);
  });

  it("fails closed on an 8k nest in under 50ms instead of RangeError", () => {
    const nest = nestObj(8_000);
    const started = performance.now();
    try {
      dataContainsFilter(nest, nest);
      expect.unreachable("filter should fail closed on an 8k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INMEMORY_FILTER_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });
});
