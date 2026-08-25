/**
 * Unit coverage for boundedWalk — the descriptor-safe budgeted walker that
 * backs tool-output validation, cycle detection, and privacy redaction.
 *
 * Drives the real module. Assertions record observed rejection reasons, copy
 * semantics, path-local cycle detection, width reservation, and option
 * behaviour; nothing is mocked.
 */

import { describe, expect, it } from "vitest";

import {
  type BoundedWalkOptions,
  type BoundedWalkRejection,
  boundedWalk,
  TOOL_OUTPUT_LIMITS,
} from "./bounded-walk.ts";

function reasonOf(
  value: unknown,
  options?: BoundedWalkOptions,
): BoundedWalkRejection | "accepted" {
  const result = boundedWalk(value, options);
  return result.ok ? "accepted" : result.reason;
}

function acceptedValue(value: unknown, options?: BoundedWalkOptions): unknown {
  const result = boundedWalk(value, options);
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.reason}`);
  }
  return result.value;
}

function nestedObject(levels: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let node = root;
  for (let index = 0; index < levels; index += 1) {
    const next: Record<string, unknown> = {};
    node.next = next;
    node = next;
  }
  node.leaf = "x";
  return root;
}

function nestedArray(levels: number): unknown[] {
  let node: unknown[] = ["leaf"];
  for (let index = 0; index < levels; index += 1) node = [node];
  return node;
}

describe("TOOL_OUTPUT_LIMITS", () => {
  it("exports the documented default budget", () => {
    expect(TOOL_OUTPUT_LIMITS).toEqual({
      maxDepth: 32,
      maxNodes: 100_000,
      maxKeys: 100_000,
      maxStringLength: 4_000_000,
      maxBytes: 16_000_000,
    });
  });
});

describe("boundedWalk primitives", () => {
  it("returns null unchanged", () => {
    expect(boundedWalk(null)).toEqual({ ok: true, value: null });
  });

  it("returns booleans unchanged", () => {
    expect(boundedWalk(true)).toEqual({ ok: true, value: true });
    expect(boundedWalk(false)).toEqual({ ok: true, value: false });
  });

  it("returns finite numbers unchanged, including -0", () => {
    expect(boundedWalk(0)).toEqual({ ok: true, value: 0 });
    expect(boundedWalk(1.5)).toEqual({ ok: true, value: 1.5 });
    expect(boundedWalk(-7)).toEqual({ ok: true, value: -7 });
    const result = boundedWalk(-0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.is(result.value, -0)).toBe(true);
  });

  it("returns strings unchanged when no transform is configured", () => {
    expect(boundedWalk("")).toEqual({ ok: true, value: "" });
    expect(boundedWalk("hello")).toEqual({ ok: true, value: "hello" });
  });

  it("rejects NaN, Infinity, and -Infinity as unsupported under default strict primitives", () => {
    expect(reasonOf(Number.NaN)).toBe("unsupported");
    expect(reasonOf(Number.POSITIVE_INFINITY)).toBe("unsupported");
    expect(reasonOf(Number.NEGATIVE_INFINITY)).toBe("unsupported");
  });

  it("rejects undefined, function, symbol, and bigint as unsupported under default strict primitives", () => {
    expect(reasonOf(undefined)).toBe("unsupported");
    expect(reasonOf(() => 1)).toBe("unsupported");
    expect(reasonOf(Symbol("s"))).toBe("unsupported");
    expect(reasonOf(1n)).toBe("unsupported");
  });

  it("passes non-JSON primitives through when strictPrimitives is false", () => {
    const fn = () => 1;
    const sym = Symbol("s");
    expect(boundedWalk(undefined, { strictPrimitives: false })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(boundedWalk(fn, { strictPrimitives: false })).toEqual({
      ok: true,
      value: fn,
    });
    expect(boundedWalk(sym, { strictPrimitives: false })).toEqual({
      ok: true,
      value: sym,
    });
    expect(boundedWalk(1n, { strictPrimitives: false })).toEqual({
      ok: true,
      value: 1n,
    });
    expect(boundedWalk(Number.NaN, { strictPrimitives: false })).toEqual({
      ok: true,
      value: Number.NaN,
    });
    expect(
      boundedWalk(Number.POSITIVE_INFINITY, { strictPrimitives: false }),
    ).toEqual({ ok: true, value: Number.POSITIVE_INFINITY });
    expect(
      boundedWalk(Number.NEGATIVE_INFINITY, { strictPrimitives: false }),
    ).toEqual({ ok: true, value: Number.NEGATIVE_INFINITY });
  });
});

describe("boundedWalk containers", () => {
  it("copies an empty object and an empty array", () => {
    const emptyObject = {};
    const emptyArray: unknown[] = [];
    const objectResult = boundedWalk(emptyObject);
    const arrayResult = boundedWalk(emptyArray);
    expect(objectResult).toEqual({ ok: true, value: {} });
    expect(arrayResult).toEqual({ ok: true, value: [] });
    if (objectResult.ok) expect(objectResult.value).not.toBe(emptyObject);
    if (arrayResult.ok) expect(arrayResult.value).not.toBe(emptyArray);
  });

  it("copies a single-key object and a single-element array", () => {
    expect(boundedWalk({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
    expect(boundedWalk(["only"])).toEqual({ ok: true, value: ["only"] });
  });

  it("preserves own-key insertion order and does not sort keys", () => {
    const result = boundedWalk({ z: 1, a: 2, m: 3 });
    expect(result).toEqual({ ok: true, value: { z: 1, a: 2, m: 3 } });
    if (result.ok) {
      expect(Object.keys(result.value as Record<string, unknown>)).toEqual([
        "z",
        "a",
        "m",
      ]);
    }
  });

  it("ignores symbol own keys because width comes from getOwnPropertyNames", () => {
    const input = { a: 1, [Symbol("hidden")]: 2 };
    expect(boundedWalk(input)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("accepts a null-prototype object and rejects class instances, Date, Map, and Set", () => {
    const dictionary = Object.create(null) as Record<string, unknown>;
    dictionary.a = 1;
    expect(boundedWalk(dictionary)).toEqual({ ok: true, value: { a: 1 } });

    class Example {
      x = 1;
    }
    expect(reasonOf(new Example())).toBe("unsupported");
    expect(reasonOf(new Date(0))).toBe("unsupported");
    expect(reasonOf(new Map())).toBe("unsupported");
    expect(reasonOf(new Set())).toBe("unsupported");
  });

  it("isolates the returned copy from later mutation of the input and the output", () => {
    const input: Record<string, unknown> = { a: 1, nested: { b: 2 } };
    const result = boundedWalk(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value as Record<string, unknown>;
    output.a = 99;
    (output.nested as Record<string, unknown>).b = 99;
    input.a = 7;
    expect(input.nested).toEqual({ b: 2 });
    expect(output.nested).toEqual({ b: 99 });
    expect(acceptedValue(input)).toEqual({ a: 7, nested: { b: 2 } });
  });

  it("serializes array holes as null and explicit undefined as unsupported in strict mode", () => {
    const holes: unknown[] = [];
    holes[1] = 1;
    holes[3] = 2;
    expect(boundedWalk(holes)).toEqual({
      ok: true,
      value: [null, 1, null, 2],
    });
    expect(reasonOf([undefined])).toBe("unsupported");
    expect(boundedWalk([undefined], { strictPrimitives: false })).toEqual({
      ok: true,
      value: [undefined],
    });
  });

  it("skips non-enumerable data properties and does not treat them as missing-key errors", () => {
    const input: Record<string, unknown> = { visible: 1 };
    Object.defineProperty(input, "hidden", {
      value: 2,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(boundedWalk(input)).toEqual({ ok: true, value: { visible: 1 } });
  });

  it("copies nested objects and arrays", () => {
    expect(boundedWalk({ a: [1, { b: "x" }], c: null })).toEqual({
      ok: true,
      value: { a: [1, { b: "x" }], c: null },
    });
  });

  it("preserves honest DAGs and repeated references via path-local cycle detection", () => {
    const shared = { x: 1, y: [2, 3] };
    const dag = { left: shared, right: shared, again: [shared, shared] };
    expect(boundedWalk(dag)).toEqual({
      ok: true,
      value: {
        left: { x: 1, y: [2, 3] },
        right: { x: 1, y: [2, 3] },
        again: [
          { x: 1, y: [2, 3] },
          { x: 1, y: [2, 3] },
        ],
      },
    });
  });

  it("rejects a true object cycle and a true array cycle", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(reasonOf(cyclic)).toBe("cycle");

    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);
    expect(reasonOf(cyclicArray)).toBe("cycle");
  });
});

describe("boundedWalk budgets", () => {
  it("rejects a container at the root when maxDepth is 0, but still accepts primitives", () => {
    expect(reasonOf({ a: 1 }, { limits: { maxDepth: 0 } })).toBe("depth");
    expect(reasonOf([1], { limits: { maxDepth: 0 } })).toBe("depth");
    expect(boundedWalk("ok", { limits: { maxDepth: 0 } })).toEqual({
      ok: true,
      value: "ok",
    });
  });

  it("accepts nesting right up to maxDepth and rejects one level past it", () => {
    // Root is depth 0; one nested container is walked at depth 1.
    expect(reasonOf({ a: { b: 1 } }, { limits: { maxDepth: 1 } })).toBe(
      "depth",
    );
    expect(boundedWalk({ a: { b: 1 } }, { limits: { maxDepth: 2 } })).toEqual({
      ok: true,
      value: { a: { b: 1 } },
    });
    expect(reasonOf(nestedObject(2), { limits: { maxDepth: 2 } })).toBe(
      "depth",
    );
    expect(reasonOf(nestedObject(1), { limits: { maxDepth: 2 } })).toBe(
      "accepted",
    );
    expect(reasonOf(nestedArray(2), { limits: { maxDepth: 2 } })).toBe("depth");
    expect(reasonOf(nestedArray(1), { limits: { maxDepth: 2 } })).toBe(
      "accepted",
    );
  });

  it("rejects the first value when maxNodes is 0", () => {
    expect(reasonOf(null, { limits: { maxNodes: 0 } })).toBe("nodes");
    expect(reasonOf("x", { limits: { maxNodes: 0 } })).toBe("nodes");
  });

  it("counts every visited value against the node budget, including nested leaves", () => {
    // Root object + one child number = 2 nodes.
    expect(reasonOf({ a: 1 }, { limits: { maxNodes: 1 } })).toBe("nodes");
    expect(reasonOf({ a: 1 }, { limits: { maxNodes: 2 } })).toBe("accepted");
    expect(reasonOf([1, 2], { limits: { maxNodes: 2 } })).toBe("nodes");
    expect(reasonOf([1, 2], { limits: { maxNodes: 3 } })).toBe("accepted");
  });

  it("reserves object width from the own-key inventory before any descriptor read", () => {
    let getterCalls = 0;
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 3; index += 1) {
      Object.defineProperty(wide, `k${index}`, {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("getter must never run");
        },
      });
    }
    expect(reasonOf(wide, { limits: { maxKeys: 2 } })).toBe("keys");
    expect(getterCalls).toBe(0);
  });

  it("reserves array width from the length descriptor before any element work", () => {
    let getterCalls = 0;
    const wide = new Array(3);
    Object.defineProperty(wide, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expect(reasonOf(wide, { limits: { maxKeys: 2 } })).toBe("keys");
    expect(getterCalls).toBe(0);
  });

  it("accepts an empty container when maxKeys is 0 and rejects a single key", () => {
    expect(reasonOf({}, { limits: { maxKeys: 0 } })).toBe("accepted");
    expect(reasonOf([], { limits: { maxKeys: 0 } })).toBe("accepted");
    expect(reasonOf({ a: 1 }, { limits: { maxKeys: 0 } })).toBe("keys");
    expect(reasonOf([1], { limits: { maxKeys: 0 } })).toBe("keys");
  });

  it("shares the key budget across nested containers", () => {
    // Root width 1 (`a`) + array width 2 = 3.
    expect(reasonOf({ a: [1, 2] }, { limits: { maxKeys: 3 } })).toBe(
      "accepted",
    );
    expect(reasonOf({ a: [1, 2], b: 0 }, { limits: { maxKeys: 3 } })).toBe(
      "keys",
    );
  });

  it("rejects a string leaf that exceeds maxStringLength before charging its bytes", () => {
    expect(reasonOf("ab", { limits: { maxStringLength: 1 } })).toBe(
      "string-length",
    );
    expect(reasonOf("ab", { limits: { maxStringLength: 2 } })).toBe("accepted");
    expect(reasonOf({ a: "xyz" }, { limits: { maxStringLength: 2 } })).toBe(
      "string-length",
    );
  });

  it("charges a flat per-node byte cost so a tiny maxBytes rejects even null", () => {
    // NODE_BYTE_COST is 8; the comparison is strict greater-than.
    expect(reasonOf(null, { limits: { maxBytes: 7 } })).toBe("bytes");
    expect(reasonOf(null, { limits: { maxBytes: 8 } })).toBe("accepted");
  });

  it("charges string leaf bytes after the node cost", () => {
    // "hi" is 2 chars + 8 node cost = 10.
    expect(reasonOf("hi", { limits: { maxBytes: 9 } })).toBe("bytes");
    expect(reasonOf("hi", { limits: { maxBytes: 10 } })).toBe("accepted");
  });

  it("charges object key-name lengths against the byte budget before reading values", () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "abcdef", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    // Root node cost 8 + key length 6 = 14. A maxBytes of 13 must reject
    // "bytes" without invoking the accessor.
    expect(reasonOf(input, { limits: { maxBytes: 13 } })).toBe("bytes");
    expect(getterCalls).toBe(0);
    // Plenty of bytes, but the accessor is still rejected without running.
    expect(reasonOf(input, { limits: { maxBytes: 100 } })).toBe("accessor");
    expect(getterCalls).toBe(0);
  });

  it("merges partial limits over TOOL_OUTPUT_LIMITS rather than replacing the rest", () => {
    const long = "x".repeat(100);
    expect(reasonOf(long, { limits: { maxDepth: 1 } })).toBe("accepted");
    expect(reasonOf({ a: { b: 1 } }, { limits: { maxDepth: 1 } })).toBe(
      "depth",
    );
    expect(reasonOf("abc", { limits: { maxStringLength: 2 } })).toBe(
      "string-length",
    );
  });
});

describe("boundedWalk hostile input", () => {
  it("never invokes a getter; enumerable accessors reject as accessor", () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = { safe: 1 };
    Object.defineProperty(hostile, "boom", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter must never run");
      },
    });
    expect(reasonOf(hostile)).toBe("accessor");
    expect(getterCalls).toBe(0);
  });

  it("rejects a non-enumerable accessor as accessor, not as an absent skip", () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = { visible: 1 };
    Object.defineProperty(input, "hiddenGetter", {
      configurable: true,
      enumerable: false,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expect(reasonOf(input)).toBe("accessor");
    expect(getterCalls).toBe(0);
  });

  it("rejects an accessor at an array index without invoking it", () => {
    let getterCalls = 0;
    const input: unknown[] = [];
    input.length = 1;
    Object.defineProperty(input, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expect(reasonOf(input)).toBe("accessor");
    expect(getterCalls).toBe(0);
  });

  it("rejects a Proxy and a revoked Proxy as reflection before any trap runs", () => {
    let trapCalls = 0;
    const proxy = new Proxy(
      { a: 1 },
      {
        get(_target, prop, receiver) {
          trapCalls += 1;
          return Reflect.get(_target, prop, receiver);
        },
        ownKeys(target) {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, prop) {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      },
    );
    expect(reasonOf(proxy)).toBe("reflection");
    expect(trapCalls).toBe(0);

    const { proxy: revoked, revoke } = Proxy.revocable({ a: 1 }, {});
    revoke();
    expect(reasonOf(revoked)).toBe("reflection");
  });
});

describe("boundedWalk transformString", () => {
  it("transforms string leaves and leaves property names untouched", () => {
    expect(
      boundedWalk(
        { Hello: "world", nested: ["ab", { k: "cd" }] },
        { transformString: (input) => input.toUpperCase() },
      ),
    ).toEqual({
      ok: true,
      value: { Hello: "WORLD", nested: ["AB", { k: "CD" }] },
    });
  });

  it("does not transform a rejected over-long string", () => {
    let calls = 0;
    expect(
      reasonOf("abcd", {
        limits: { maxStringLength: 2 },
        transformString: (input) => {
          calls += 1;
          return input;
        },
      }),
    ).toBe("string-length");
    expect(calls).toBe(0);
  });
});

describe("boundedWalk substitute", () => {
  it("always succeeds at the root by replacing a rejected value", () => {
    expect(
      boundedWalk(() => 1, { substitute: (reason) => `SUB:${reason}` }),
    ).toEqual({ ok: true, value: "SUB:unsupported" });
    expect(
      boundedWalk(new Proxy({ a: 1 }, {}), {
        substitute: (reason) => `SUB:${reason}`,
      }),
    ).toEqual({ ok: true, value: "SUB:reflection" });
    expect(
      boundedWalk(
        { a: 1 },
        {
          limits: { maxDepth: 0 },
          substitute: (reason) => `SUB:${reason}`,
        },
      ),
    ).toEqual({ ok: true, value: "SUB:depth" });
  });

  it("substitutes a cyclic child in place rather than replacing the root container", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      boundedWalk(cyclic, { substitute: (reason) => `SUB:${reason}` }),
    ).toEqual({ ok: true, value: { self: "SUB:cycle" } });
  });

  it("replaces a rejected child and continues walking siblings", () => {
    let getterCalls = 0;
    // Insertion order must put a live sibling after the accessor so the
    // walk continuing (not aborting) is observable.
    const ordered: Record<string, unknown> = {};
    ordered.first = 1;
    Object.defineProperty(ordered, "boom", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    ordered.last = 3;
    expect(
      boundedWalk(ordered, { substitute: (reason) => `SUB:${reason}` }),
    ).toEqual({
      ok: true,
      value: { first: 1, boom: "SUB:accessor", last: 3 },
    });
    expect(getterCalls).toBe(0);
  });

  it("replaces a rejected array element with the substitute and keeps walking", () => {
    const input: unknown[] = [1, () => 2, 3];
    expect(
      boundedWalk(input, { substitute: (reason) => `SUB:${reason}` }),
    ).toEqual({
      ok: true,
      value: [1, "SUB:unsupported", 3],
    });
  });

  it("keeps the shared node budget while substituting", () => {
    // Root + {b:1} consume 2 nodes; the leaf `1` then the sibling `c` both
    // overflow maxNodes and are substituted.
    const result = boundedWalk(
      { a: { b: 1 }, c: 2 },
      {
        limits: { maxNodes: 2 },
        substitute: (reason) => `SUB:${reason}`,
      },
    );
    expect(result).toEqual({
      ok: true,
      value: { a: { b: "SUB:nodes" }, c: "SUB:nodes" },
    });
  });
});
