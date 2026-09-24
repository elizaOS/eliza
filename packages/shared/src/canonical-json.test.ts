/**
 * The shared bounded canonical-JSON walk.
 *
 * Two obligations, and the second one is the reason this file is long:
 *   1. deep / cyclic / hostile payloads fail closed with a typed error instead
 *      of `RangeError`ing an integrity gate; and
 *   2. every payload the unbounded predecessors accepted still produces the
 *      SAME canonical bytes. A backup state that hashed one way yesterday and
 *      another way today would silently invalidate the backups already stored
 *      for it, so compatibility is pinned differentially against a verbatim
 *      copy of the recursion this module replaces.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  AGENT_BACKUP_CANONICAL_JSON,
  CANONICAL_JSON_UNBOUNDED,
  type CanonicalJsonOptions,
  canonicalJsonString,
  failCanonicalJsonUnbounded,
  readCanonicalArrayLength,
  stableJsonString,
} from "./canonical-json.js";

/**
 * The exact unbounded body that shipped in agent-backup.ts,
 * agent-backup-diff.ts and agent-backup-verifier.ts, kept here as the
 * compatibility oracle. `JSON.stringify(legacyCanonicalize(v))` is the byte
 * sequence every already-stored backup hash was taken over.
 */
function legacyCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyCanonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = legacyCanonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function legacyStableJson(value: unknown): string {
  return JSON.stringify(legacyCanonicalize(value));
}

const OPTIONS = AGENT_BACKUP_CANONICAL_JSON;

function expectUnbounded(fn: () => unknown): ElizaError {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw).toBe(true);
  expect(caught).toBeInstanceOf(ElizaError);
  expect(caught).not.toBeInstanceOf(RangeError);
  expect((caught as ElizaError).code).toBe(CANONICAL_JSON_UNBOUNDED);
  return caught as ElizaError;
}

function nest(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i += 1) value = { a: value };
  return value;
}

/** An honest backup state, deep enough to be interesting but finite. */
function honestState(depth: number) {
  return {
    memories: [
      { role: "user", text: "hi 🦊", timestamp: 1 },
      { role: "assistant", text: "hello", timestamp: 2 },
    ],
    config: {
      zeta: 1,
      alpha: { nested: nest(depth), list: [1, "two", null, true] },
      beta: null,
      unicode: "sur\u{1F98A}rogate éè",
    },
    workspaceFiles: { "b.txt": "second", "a.txt": "first" },
  };
}

describe("canonical JSON compatibility with the unbounded predecessor", () => {
  const corpus: Array<[string, unknown]> = [
    ["null", null],
    ["number", 42],
    ["negative zero", -0],
    ["non-finite number", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["string with quotes and newlines", 'a"b\nc\\d'],
    ["astral string", "🦊🦊"],
    ["boolean", true],
    ["empty object", {}],
    ["empty array", []],
    ["flat object out of key order", { b: 1, a: 2, C: 3, "": 4 }],
    ["nested arrays", [[1, [2, [3, [4]]]], []]],
    ["array of objects", [{ b: 1, a: 2 }, { z: [1, 2] }]],
    ["undefined-valued key", { a: 1, b: undefined }],
    ["function-valued key", { a: 1, b: () => 1 }],
    ["symbol-valued key", { a: 1, b: Symbol("s") }],
    ["undefined array slot", [1, undefined, 3]],
    ["function array slot", [1, () => 1, 3]],
    ["null array slot", [1, null, 3]],
    ["symbol key", { a: 1, [Symbol("s")]: 2 }],
    ["Date value", { at: new Date(0) }],
    ["Map value", { m: new Map([["a", 1]]) }],
    ["Set value", { s: new Set([1, 2]) }],
    [
      "null-prototype object",
      Object.assign(Object.create(null), { b: 1, a: 2 }),
    ],
    ["honest backup state", honestState(4)],
    ["deep but finite state (depth 55)", honestState(50)],
    [
      "wide object",
      Object.fromEntries(
        Array.from({ length: 2_000 }, (_v, i) => [
          `k${(2_000 - i).toString(36)}`,
          i,
        ]),
      ),
    ],
    [
      "long memory log",
      {
        memories: Array.from({ length: 5_000 }, (_v, i) => ({
          role: i % 2 ? "user" : "assistant",
          text: `m${i}`,
          timestamp: i,
        })),
        config: {},
        workspaceFiles: {},
      },
    ],
  ];

  for (const [label, value] of corpus) {
    it(`emits identical canonical bytes: ${label}`, () => {
      expect(stableJsonString(value, OPTIONS)).toBe(legacyStableJson(value));
    });
  }

  it("keeps a non-enumerable own property out of the digest, as before", () => {
    const value: Record<string, unknown> = { a: 1 };
    Object.defineProperty(value, "hidden", { value: 2, enumerable: false });
    expect(stableJsonString(value, OPTIONS)).toBe(legacyStableJson(value));
    expect(stableJsonString(value, OPTIONS)).toBe('{"a":1}');
  });

  it("preserves the sparse-hole rendering of JSON.stringify", () => {
    const sparse = [1];
    sparse[2] = 3;
    expect(stableJsonString(sparse, OPTIONS)).toBe(legacyStableJson(sparse));
    expect(stableJsonString(sparse, OPTIONS)).toBe("[1,null,3]");
  });

  it("keeps undefined at the root undefined, so absent != null stays true", () => {
    // The differ compares stableJson(a) === stableJson(b); collapsing an
    // absent value onto "null" would stop reporting a null -> absent change.
    expect(stableJsonString(undefined, OPTIONS)).toBe(
      legacyStableJson(undefined),
    );
    expect(stableJsonString(undefined, OPTIONS)).toBeUndefined();
    expect(stableJsonString(null, OPTIONS)).toBe("null");
  });

  it("hashes key-order permutations of one state identically", () => {
    const left = { config: { a: 1, b: 2 }, memories: [], workspaceFiles: {} };
    const right = { memories: [], workspaceFiles: {}, config: { b: 2, a: 1 } };
    expect(stableJsonString(left, OPTIONS)).toBe(
      stableJsonString(right, OPTIONS),
    );
  });

  it("preserves an honest shared reference (DAG), not just rejecting cycles", () => {
    // Reviewers have caught the difference twice: `seen`-forever rejects a DAG
    // the live path accepts today. `visiting` is path-local, so this must hash
    // exactly as the unbounded walk did.
    const shared = { b: 1, a: [1, 2, { deep: true }] };
    const dag = { config: { x: shared, y: shared, z: { again: shared } } };
    expect(stableJsonString(dag, OPTIONS)).toBe(legacyStableJson(dag));
  });

  it("preserves a shared reference repeated inside one array", () => {
    const shared = { a: 1 };
    const value = [shared, shared, shared];
    expect(stableJsonString(value, OPTIONS)).toBe(legacyStableJson(value));
    expect(stableJsonString(value, OPTIONS)).toBe('[{"a":1},{"a":1},{"a":1}]');
  });

  it("accepts a state nested one level under the depth ceiling", () => {
    const atLimit = nest(OPTIONS.maxDepth);
    expect(stableJsonString(atLimit, OPTIONS)).toBe(legacyStableJson(atLimit));
  });
});

describe("canonical JSON fail-closed bounds", () => {
  it("fails closed on a cyclic graph instead of RangeError", () => {
    const cyclic: Record<string, unknown> = { id: "state" };
    cyclic.self = cyclic;
    const error = expectUnbounded(() => stableJsonString(cyclic, OPTIONS));
    expect(error.context).toEqual({ cycle: true });
    expect(error.severity).toBe("fatal");
  });

  it("fails closed on an over-deep nest before the walk RangeErrors", () => {
    const error = expectUnbounded(() =>
      stableJsonString(nest(OPTIONS.maxDepth + 8), OPTIONS),
    );
    expect(error.context).toMatchObject({ max: OPTIONS.maxDepth });
  });

  it("fails closed after JSON.parse accepts a 20k-deep payload", () => {
    const raw = `${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}`;
    const parsed = JSON.parse(raw) as unknown;
    expectUnbounded(() => stableJsonString(parsed, OPTIONS));
  });

  it("bounds an exponential shared-reference expansion on output chars", () => {
    // Path-local cycle detection is correct and keeps DAGs honest, but a
    // 40-level doubling graph is a few hundred bytes of input that flattens to
    // a terabyte of canonical text. The output budget is what stops it.
    let node: Record<string, unknown> = { leaf: "0123456789" };
    for (let i = 0; i < 40; i += 1) node = { a: node, b: node };
    const error = expectUnbounded(() =>
      stableJsonString(node, {
        ...OPTIONS,
        maxDepth: 128,
        maxOutputChars: 1_000_000,
      }),
    );
    expect(error.context).toMatchObject({ maxOutputChars: 1_000_000 });
  });

  it("never invokes an enumerable getter", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("GETTER_INVOKED");
      },
    });
    const error = expectUnbounded(() =>
      stableJsonString({ config: hostile }, OPTIONS),
    );
    expect(String(error)).not.toContain("GETTER_INVOKED");
  });

  it("never echoes an attacker-controlled property name in error context", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "AWS_SECRET_ACCESS_KEY", {
      enumerable: true,
      configurable: true,
      get: () => "leaked",
    });
    const error = expectUnbounded(() => stableJsonString(hostile, OPTIONS));
    expect(error.context).toEqual({ accessor: true, container: "object" });
    expect(JSON.stringify(error.context ?? {})).not.toContain(
      "AWS_SECRET_ACCESS_KEY",
    );
    expect(error.message).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("charges a wide object's breadth before any descriptor read or sort", () => {
    const options: CanonicalJsonOptions = { ...OPTIONS, maxNodes: 1_000 };
    const keys = Array.from({ length: 1_001 }, (_v, i) => `k${i}`);
    let descriptorReads = 0;
    const wide = new Proxy(
      {},
      {
        ownKeys: () => keys,
        getOwnPropertyDescriptor: () => {
          descriptorReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: 1,
          };
        },
      },
    );
    const error = expectUnbounded(() => stableJsonString(wide, options));
    expect(descriptorReads).toBe(0);
    expect(error.context).toEqual({ visits: 1_002, maxNodes: 1_000 });
  });

  it("fails closed on a huge sparse length before allocating the join", () => {
    const options: CanonicalJsonOptions = { ...OPTIONS, maxNodes: 1_000 };
    const sparse: unknown[] = [];
    sparse.length = 1_001;
    expectUnbounded(() => stableJsonString(sparse, options));
  });

  it("wraps a revoked Proxy as a typed rejection, preserving the cause", () => {
    const pair = Proxy.revocable({ a: 1 }, {});
    pair.revoke();
    const error = expectUnbounded(() => stableJsonString(pair.proxy, OPTIONS));
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.context).toEqual({ inspection: "isArray" });
  });

  it("keeps honest canonical bytes for an ordinary Proxy", () => {
    expect(stableJsonString(new Proxy({ b: 1, a: 2 }, {}), OPTIONS)).toBe(
      '{"a":2,"b":1}',
    );
    expect(stableJsonString(new Proxy([2, 1], {}), OPTIONS)).toBe("[2,1]");
  });

  it("reads one object descriptor snapshot so Proxy drift cannot change bytes", () => {
    let reads = 0;
    const drifted = new Proxy(
      { a: 1 },
      {
        ownKeys: () => ["a"],
        getOwnPropertyDescriptor: () => {
          reads += 1;
          if (reads === 1) {
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: 1,
            };
          }
          throw new Error("DESCRIPTOR_DRIFT");
        },
      },
    );
    expect(stableJsonString(drifted, OPTIONS)).toBe('{"a":1}');
    expect(reads).toBe(1);
  });

  it("reads an array length exactly once for a caller that also publishes it", () => {
    const items = [{ id: "a" }, { id: "b" }];
    let lengthReads = 0;
    const counted = new Proxy(items, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") lengthReads += 1;
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    const length = readCanonicalArrayLength(counted, OPTIONS);
    expect(length).toBe(2);
    expect(lengthReads).toBe(1);
    expect(canonicalJsonString(counted, OPTIONS, length)).toBe(
      canonicalJsonString(items, OPTIONS),
    );
    expect(lengthReads).toBe(1);
  });

  it("renders a sparse hole per the call site's declared policy", () => {
    const sparse = [1];
    sparse[2] = 3;
    const omit: CanonicalJsonOptions = { ...OPTIONS, sparseArrayHoles: "omit" };
    expect(canonicalJsonString(sparse, omit)).toBe("[1,,3]");
    expect(canonicalJsonString(sparse, OPTIONS)).toBe("[1,null,3]");
  });

  it("routes rejections through a call site's own error type", () => {
    class DomainError extends ElizaError {}
    const options: CanonicalJsonOptions = {
      ...OPTIONS,
      onUnbounded: (context, cause) => {
        throw new DomainError("domain", {
          code: "DOMAIN_UNBOUNDED",
          context,
          cause,
        });
      },
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonString(cyclic, options)).toThrow(DomainError);
    expect(typeof failCanonicalJsonUnbounded).toBe("function");
  });
});
