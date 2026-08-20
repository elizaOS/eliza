/**
 * Deterministic tests for the blocked-object-key walk: prototype-pollution
 * key stripping plus the depth/node/cycle bound that fails closed instead of
 * RangeErroring OpenAI-compat chat JSON. No live model.
 */
import { ElizaError } from "@elizaos/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BLOCKED_OBJECT_GRAPH_UNBOUNDED,
  cloneWithoutBlockedObjectKeys,
  hasBlockedObjectKeyDeep,
  MAX_BLOCKED_OBJECT_DEPTH,
  MAX_BLOCKED_OBJECT_NODES,
} from "./blocked-object-keys";

function nestArray(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

describe("blocked object key sanitization", () => {
  it("detects and removes nested prototype-pollution keys without mutating safe data", () => {
    const hostile = JSON.parse(
      '{"safe":{"value":1},"items":[{"constructor":{"prototype":{"polluted":true}}}],"prototype":"x"}',
    ) as Record<string, unknown>;

    expect(hasBlockedObjectKeyDeep(hostile)).toBe(true);

    const clean = cloneWithoutBlockedObjectKeys(hostile);

    expect(clean).toEqual({
      safe: { value: 1 },
      items: [{}],
    });
    expect(hasBlockedObjectKeyDeep(clean)).toBe(false);
    expect(hostile).toHaveProperty("prototype", "x");
  });

  it("does not assign __proto__ while cloning hostile parsed JSON", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"nested":{"ok":true}}',
    ) as Record<string, unknown>;

    const clean = cloneWithoutBlockedObjectKeys(hostile) as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(clean, "__proto__")).toBe(false);
    expect(clean).toEqual({ nested: { ok: true } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("fuzzes JSON-compatible values with blocked keys injected at arbitrary leaves", () => {
    fc.assert(
      fc.property(
        // The "legit" value must not itself contain blocked keys, otherwise the
        // sanitizer correctly strips them and clean !== the original value.
        fc.jsonValue().filter((v) => !hasBlockedObjectKeyDeep(v)),
        fc.constantFrom("__proto__", "constructor", "prototype"),
        (value, blockedKey) => {
          const payload = {
            value,
            wrapper: [{ [blockedKey]: { value: "drop me" } }],
          };

          expect(hasBlockedObjectKeyDeep(payload)).toBe(true);
          const clean = cloneWithoutBlockedObjectKeys(payload);
          const cleanValue = cloneWithoutBlockedObjectKeys(value);
          expect(hasBlockedObjectKeyDeep(clean)).toBe(false);
          expect(clean).toEqual({
            value: cleanValue,
            wrapper: [{}],
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it(`accepts a ${MAX_BLOCKED_OBJECT_DEPTH}-deep nest without blocked keys`, () => {
    const honest = nestArray(MAX_BLOCKED_OBJECT_DEPTH);
    expect(hasBlockedObjectKeyDeep(honest)).toBe(false);
    expect(cloneWithoutBlockedObjectKeys(honest)).toEqual(honest);
  });

  it(`rejects one past depth ${MAX_BLOCKED_OBJECT_DEPTH} without RangeError`, () => {
    const hostile = nestArray(MAX_BLOCKED_OBJECT_DEPTH + 1);
    expect(hasBlockedObjectKeyDeep(hostile)).toBe(true);
    try {
      cloneWithoutBlockedObjectKeys(hostile);
      expect.unreachable("clone should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(BLOCKED_OBJECT_GRAPH_UNBOUNDED);
    }
  });

  it(`rejects a sparse array past ${MAX_BLOCKED_OBJECT_NODES} holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_BLOCKED_OBJECT_NODES] = "x";
    expect(hasBlockedObjectKeyDeep(sparse)).toBe(true);
    try {
      cloneWithoutBlockedObjectKeys(sparse);
      expect.unreachable(
        "clone should fail closed on over-budget sparse length",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(BLOCKED_OBJECT_GRAPH_UNBOUNDED);
    }
  });

  it("rejects a cyclic object without hanging", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(hasBlockedObjectKeyDeep(cyclic)).toBe(true);
    try {
      cloneWithoutBlockedObjectKeys(cyclic);
      expect.unreachable("clone should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(BLOCKED_OBJECT_GRAPH_UNBOUNDED);
    }
  });

  it("does not invoke accessors while walking", () => {
    let invoked = 0;
    const hostile = {
      safe: 1,
      get trap() {
        invoked += 1;
        return { constructor: { prototype: { polluted: true } } };
      },
    };
    expect(hasBlockedObjectKeyDeep(hostile)).toBe(false);
    const clean = cloneWithoutBlockedObjectKeys(hostile);
    expect(invoked).toBe(0);
    expect(clean).toEqual({ safe: 1 });
  });

  it("does not invoke numeric array accessors while walking", () => {
    let invoked = 0;
    const array = ["safe"];
    Object.defineProperty(array, "1", {
      enumerable: true,
      get() {
        invoked += 1;
        return { constructor: { prototype: { polluted: true } } };
      },
    });

    expect(hasBlockedObjectKeyDeep(array)).toBe(false);
    const clean = cloneWithoutBlockedObjectKeys(array);

    expect(invoked).toBe(0);
    expect(clean).toHaveLength(2);
    expect(clean[0]).toBe("safe");
    expect(Object.hasOwn(clean, 1)).toBe(false);
  });

  it("accepts a realistic broad chat history", () => {
    const payload = {
      model: "gpt-4.1",
      messages: Array.from({ length: 1_000 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
      })),
    };

    expect(hasBlockedObjectKeyDeep(payload)).toBe(false);
    expect(cloneWithoutBlockedObjectKeys(payload)).toEqual(payload);
  });

  it("fails closed on a 20k nest instead of throwing RangeError", () => {
    const hostile = nestArray(20_000);
    expect(hasBlockedObjectKeyDeep(hostile)).toBe(true);

    try {
      cloneWithoutBlockedObjectKeys(hostile);
      expect.unreachable("clone should fail closed on a 20k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(BLOCKED_OBJECT_GRAPH_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
  });

  it("rejects a 20k nest accepted by JSON.parse as blocked", () => {
    const body = JSON.parse(
      `${"[".repeat(20_000)}${"]".repeat(20_000)}`,
    ) as unknown;
    expect(hasBlockedObjectKeyDeep(body)).toBe(true);
  });
});
