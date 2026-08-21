/**
 * Cache-key canonicalizer tests.
 *
 * The regression under test: `canonicalizeJson` used to recurse with no depth
 * counter, no node budget and no cycle guard, and it is the first function in
 * the cache path to touch model-emitted tool arguments. An over-deep or cyclic
 * argument tree overflowed the stack with `RangeError: Maximum call stack size
 * exceeded` inside `ToolCallCache.get`/`set`/`run`.
 *
 * These tests cover the budget, the descriptor-only reflection contract, and —
 * most importantly — a differential compatibility suite proving the bounded
 * canonicalizer emits byte-identical text to the previous implementation for
 * every value that implementation accepted, so no live cache key moves.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ToolCallCache } from "./cache.ts";
import {
  buildCacheKey,
  CACHE_KEY_LIMITS,
  type CacheKeyRejection,
  canonicalizeJson,
  ToolCacheKeyBoundError,
  tryBuildCacheKey,
  tryCanonicalizeJson,
} from "./key.ts";
import type { CacheableToolDescriptor, PrivacyRedactor } from "./types.ts";

/**
 * The canonicalizer exactly as it stood before this fix. Used only as a
 * differential oracle: anything it accepted must still canonicalize to the
 * same bytes.
 */
function legacyCanonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => legacyCanonicalizeJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${legacyCanonicalizeJson(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
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

/** `[<hole>, 1, <hole>, 2]`, built without a sparse-array literal. */
function sparseArray(): unknown[] {
  const holes: unknown[] = [];
  holes[1] = 1;
  holes[3] = 2;
  return holes;
}

function reasonOf(value: unknown): CacheKeyRejection | "accepted" {
  const result = tryCanonicalizeJson(value);
  return result.ok ? "accepted" : result.reason;
}

describe("canonicalizeJson bounds", () => {
  it("rejects a 200k-deep argument tree instead of overflowing the stack", () => {
    const args = { arg: nestedObject(200_000) };

    expect(reasonOf(args)).toBe("depth");
    expect(tryBuildCacheKey("web_search", args)).toEqual({
      ok: false,
      reason: "depth",
    });

    let thrown: unknown;
    try {
      buildCacheKey("web_search", args);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolCacheKeyBoundError);
    expect(thrown).not.toBeInstanceOf(RangeError);
    const typed = thrown as ToolCacheKeyBoundError;
    expect(typed.code).toBe("TOOL_CACHE_KEY_UNBOUNDED");
    expect(typed.reason).toBe("depth");
    expect(typed.context).toMatchObject({
      reason: "depth",
      toolName: "web_search",
    });
  });

  it("rejects a 200k-deep argument array instead of overflowing the stack", () => {
    expect(reasonOf({ arg: nestedArray(200_000) })).toBe("depth");
  });

  it("rejects a self-referencing argument tree as a cycle", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(reasonOf(cyclic)).toBe("cycle");

    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);
    expect(reasonOf({ arg: cyclicArray })).toBe("cycle");
  });

  it("preserves honest DAGs and repeated references (path-local cycle guard)", () => {
    const shared = { a: 1, b: [1, 2] };
    const dag = { left: shared, right: shared, again: [shared, shared] };

    const result = tryCanonicalizeJson(dag);
    expect(result).toEqual({
      ok: true,
      canonical: legacyCanonicalizeJson(dag),
    });
  });

  it("accepts nesting right up to the depth limit", () => {
    // Root object is depth 0, so maxDepth - 1 further containers still fit.
    const deepest = nestedObject(CACHE_KEY_LIMITS.maxDepth - 2);
    expect(reasonOf(deepest)).toBe("accepted");
    expect(tryCanonicalizeJson(deepest)).toEqual({
      ok: true,
      canonical: legacyCanonicalizeJson(deepest),
    });
  });

  it("charges array width from the length descriptor before any element work", () => {
    // Sparse: no element storage at all. If width were charged per element we
    // would walk ten million indices instead of rejecting immediately.
    const wide = new Array(10_000_000);
    // An accessor on element 0 would reject with "accessor" if elements were
    // touched first; getting "keys" proves width is reserved beforehand.
    let getterCalls = 0;
    Object.defineProperty(wide, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });

    expect(reasonOf({ arg: wide })).toBe("keys");
    expect(getterCalls).toBe(0);
  });

  it("charges object width from the own-key inventory before any descriptor read", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < CACHE_KEY_LIMITS.maxKeys + 1; index += 1) {
      wide[`k${index}`] = 1;
    }
    expect(reasonOf(wide)).toBe("keys");
  });

  it("never invokes a getter on untrusted args", () => {
    let getterCalls = 0;
    const hostile = {
      safe: 1,
      get boom() {
        getterCalls += 1;
        throw new Error("getter must never run");
      },
    };

    expect(reasonOf({ arg: hostile })).toBe("accessor");
    expect(getterCalls).toBe(0);
  });

  it("never invokes a Proxy get trap on untrusted args", () => {
    let getTraps = 0;
    const target = { a: 1 };
    const proxied = new Proxy(target, {
      get(receiverTarget, property, receiver) {
        getTraps += 1;
        return Reflect.get(receiverTarget, property, receiver);
      },
    });

    const result = tryCanonicalizeJson({ arg: proxied });
    expect(result).toEqual({
      ok: true,
      canonical: legacyCanonicalizeJson({ arg: target }),
    });
    expect(getTraps).toBe(0);
  });

  it("reports hostile reflection as a typed rejection, not a raw TypeError", () => {
    const throwingOwnKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new TypeError("ownKeys trap exploded");
        },
      },
    );
    expect(reasonOf({ arg: throwingOwnKeys })).toBe("reflection");

    const revocable = Proxy.revocable({ a: 1 }, {});
    revocable.revoke();
    expect(reasonOf({ arg: revocable.proxy })).toBe("reflection");
  });

  it("bounds a single oversized string leaf", () => {
    const huge = "x".repeat(CACHE_KEY_LIMITS.maxStringLength + 1);
    expect(reasonOf({ arg: huge })).toBe("string-length");
  });

  it("bounds aggregate canonical bytes across the whole walk", () => {
    const chunk = "y".repeat(1_000);
    const many: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) many[`k${index}`] = chunk;
    expect(tryCanonicalizeJson(many, { maxBytes: 5_000 })).toEqual({
      ok: false,
      reason: "bytes",
    });
  });

  it("charges canonical text by UTF-8 bytes rather than UTF-16 code units", () => {
    // JSON text is `"é"`: three UTF-16 code units but four UTF-8 bytes.
    expect(tryCanonicalizeJson("é", { maxBytes: 3 })).toEqual({
      ok: false,
      reason: "bytes",
    });
    expect(tryCanonicalizeJson("é", { maxBytes: 4 })).toEqual({
      ok: true,
      canonical: '"é"',
    });
  });

  it("bounds total node count", () => {
    expect(tryCanonicalizeJson([1, 2, 3, 4, 5], { maxNodes: 3 })).toEqual({
      ok: false,
      reason: "nodes",
    });
  });

  it("rejects bigint args as unsupported instead of throwing a raw TypeError", () => {
    expect(reasonOf({ arg: 1n })).toBe("unsupported");
  });

  it("never returns partially walked text on rejection", () => {
    const partial = { good: "value", bad: nestedObject(200_000) };
    const result = tryCanonicalizeJson(partial);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("canonical");
  });
});

describe("canonicalizeJson compatibility with the previous implementation", () => {
  // Every shape the unbounded canonicalizer accepted. Byte-identical output
  // here is what guarantees no live cache key moves and nothing that works
  // today is newly rejected.
  const corpus: Array<[string, unknown]> = [
    ["empty object", {}],
    ["empty array", []],
    ["flat object", { b: 2, a: 1, c: 3 }],
    ["nested object", { b: { y: 2, x: 1 }, a: [1, 2, 3] }],
    ["null", null],
    ["number", 42],
    ["negative zero", -0],
    ["float", 1.5],
    ["boolean", true],
    ["string", "hello"],
    ["string needing escapes", 'line\n"quote"\\slash\u0007'],
    ["unicode keys", { é: 1, z: 2, "\u0000": 3, "": 4 }],
    ["numeric-like keys", { "10": 1, "2": 2, b: 3, "1": 4 }],
    [
      "array of objects",
      [
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ],
    ],
    ["array with holes", sparseArray()],
    ["array with undefined", [undefined, 1, undefined]],
    ["array with functions", [() => 1, 2]],
    ["object with undefined value", { a: undefined, b: 1 }],
    ["object with function value", { a: () => 1, b: 1 }],
    ["object with symbol value", { a: Symbol("s"), b: 1 }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["Date value", { a: new Date(0) }],
    ["Map value", { a: new Map([["k", "v"]]) }],
    [
      "class instance",
      {
        a: new (class Point {
          x = 1;
          y = 2;
        })(),
      },
    ],
    [
      "null-prototype object",
      { a: Object.assign(Object.create(null), { z: 1 }) },
    ],
    ["symbol-keyed property", { a: 1, [Symbol("hidden")]: 2 }],
    [
      "non-enumerable property",
      Object.defineProperty({ a: 1 }, "hidden", {
        value: 2,
        enumerable: false,
      }),
    ],
    ["deeply nested but in budget", nestedObject(20)],
    [
      "realistic tool args",
      {
        url: "https://example.com/search?q=eliza&n=10",
        headers: { accept: "application/json", "x-trace": "abc" },
        body: {
          query: "eliza",
          filters: [{ kind: "date", after: 1700000000 }],
        },
        retries: 3,
        stream: false,
      },
    ],
  ];

  for (const [label, value] of corpus) {
    it(`matches the previous canonical text for ${label}`, () => {
      const expected = legacyCanonicalizeJson(value);
      const result = tryCanonicalizeJson(value);
      expect(result).toEqual({ ok: true, canonical: expected });
      // The exported wrapper keeps the same (untyped) shape as before.
      expect(canonicalizeJson(value)).toBe(expected);
    });
  }

  it("keeps existing cache keys byte-stable", () => {
    for (const [label, value] of corpus) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const args = value as Record<string, unknown>;
      const expected = createHash("sha256")
        .update("web_fetch")
        .update(":")
        .update(legacyCanonicalizeJson(args))
        .digest("hex");
      expect(buildCacheKey("web_fetch", args), label).toBe(expected);
    }
  });
});

describe("ToolCallCache with unkeyable arguments", () => {
  const descriptor: CacheableToolDescriptor = {
    name: "web_search",
    version: "1",
    ttlMs: 60_000,
    cacheable: true,
  };
  const passthrough: PrivacyRedactor = (value) => value;

  function makeCache(observed: Array<{ toolName: string; reason: string }>) {
    return new ToolCallCache({
      diskRoot: "/dev/null/unused",
      redact: passthrough,
      onUnkeyableArgs: (info) => observed.push(info),
    });
  }

  it("runs the tool uncached instead of crashing on hostile args", async () => {
    const observed: Array<{ toolName: string; reason: string }> = [];
    const cache = makeCache(observed);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    let executions = 0;
    const execute = async () => {
      executions += 1;
      return { ok: true };
    };

    await expect(cache.run(descriptor, cyclic, execute)).resolves.toEqual({
      ok: true,
    });
    expect(observed).toEqual([{ toolName: "web_search", reason: "cycle" }]);
    await expect(cache.run(descriptor, cyclic, execute)).resolves.toEqual({
      ok: true,
    });
    // Never served from cache, never crashed.
    expect(executions).toBe(2);
    expect(observed).toEqual([
      { toolName: "web_search", reason: "cycle" },
      { toolName: "web_search", reason: "cycle" },
    ]);
  });

  it("misses on get and no-ops on set for unkeyable args", () => {
    const observed: Array<{ toolName: string; reason: string }> = [];
    const cache = makeCache(observed);
    const deep = { arg: nestedObject(200_000) };

    expect(() => cache.set(descriptor, deep, { cached: true })).not.toThrow();
    expect(cache.get(descriptor, deep)).toBeUndefined();
    expect(observed.every((entry) => entry.reason === "depth")).toBe(true);
    expect(observed.length).toBe(2);
  });
});
