import { describe, expect, test } from "vitest";

import { stableSerialize } from "./stable-serialize";

describe("stableSerialize", () => {
  test("serializes object keys in deterministic order", () => {
    expect(stableSerialize({ b: 2, a: 1 })).toBe(stableSerialize({ a: 1, b: 2 }));
    expect(stableSerialize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test("serializes nested arrays and objects while preserving array order", () => {
    expect(stableSerialize({ tags: ["b", "a"], nested: { z: true, a: null } })).toBe(
      '{"nested":{"a":null,"z":true},"tags":["b","a"]}',
    );
  });

  test("omits undefined object fields but serializes array undefined slots as null", () => {
    expect(stableSerialize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stableSerialize([1, undefined, 3])).toBe("[1,null,3]");
  });

  test("serializes Date values explicitly instead of collapsing them to empty objects", () => {
    expect(stableSerialize(new Date("2026-05-31T00:00:00.000Z"))).toBe(
      '"2026-05-31T00:00:00.000Z"',
    );
  });

  test("rejects non-plain objects that would otherwise collide", () => {
    expect(() => stableSerialize(new Map([["a", 1]]))).toThrow(TypeError);
    class Example {
      value = 1;
    }
    expect(() => stableSerialize(new Example())).toThrow(TypeError);
  });

  test("rejects circular arrays and objects with a deterministic error", () => {
    const objectCycle: Record<string, unknown> = {};
    objectCycle.self = objectCycle;
    expect(() => stableSerialize(objectCycle)).toThrow("circular references");

    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    expect(() => stableSerialize(arrayCycle)).toThrow("circular references");
  });
});
