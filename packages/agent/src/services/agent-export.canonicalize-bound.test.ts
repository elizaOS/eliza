/**
 * Fail-closed canonicalize walk for agent export integrity digests.
 *
 * Origin develop JSON.parse'd a 20k-deep nest (legal, ~120 KiB, under the
 * 16 MiB gunzip cap) then RangeError'd in canonicalize during
 * verifyExportManifest. Cyclic graphs and enumerable getters did the same.
 * Depth/node/cycle fail-closed replaces that with AgentExportError
 * AGENT_EXPORT_CANONICALIZE_UNBOUNDED.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_EXPORT_CANONICALIZE_UNBOUNDED,
  AgentExportError,
  canonicalize,
  digestCollection,
  MANIFEST_COLLECTIONS,
  MAX_AGENT_EXPORT_CANONICALIZE_DEPTH,
  MAX_AGENT_EXPORT_CANONICALIZE_NODES,
  verifyExportManifest,
} from "./agent-export.ts";

function nest(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i += 1) value = { a: value };
  return value;
}

function expectUnbounded(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected AGENT_EXPORT_CANONICALIZE_UNBOUNDED");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentExportError);
    expect((error as AgentExportError).code).toBe(
      AGENT_EXPORT_CANONICALIZE_UNBOUNDED,
    );
    expect(error).not.toBeInstanceOf(RangeError);
  }
}

function emptyPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    exportedAt: "2026-08-21T00:00:00.000Z",
    sourceAgentId: "agent-1",
    agent: { name: "Ada" },
    entities: [],
    memories: [],
    components: [],
    rooms: [],
    participants: [],
    relationships: [],
    worlds: [],
    tasks: [],
    logs: [],
    ...overrides,
  };
}

function manifestFor(payload: Record<string, unknown>) {
  const components: Record<string, ReturnType<typeof digestCollection>> = {};
  for (const name of MANIFEST_COLLECTIONS) {
    const items = payload[name];
    components[name] = digestCollection(
      Array.isArray(items) ? items : [],
    );
  }
  return { algorithm: "sha256" as const, components };
}

describe("canonicalize fail-closed walk", () => {
  it("still sorts keys and drops undefined (stable across key order)", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    expect(canonicalize({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
  });

  it("fail-closed on a cyclic export graph instead of RangeError", () => {
    const cyclic: Record<string, unknown> = { id: "mem-1", text: "hi" };
    cyclic.self = cyclic;
    expectUnbounded(() => canonicalize(cyclic));
  });

  it("fail-closed on over-deep nests before the walk RangeErrors", () => {
    expectUnbounded(() =>
      canonicalize(nest(MAX_AGENT_EXPORT_CANONICALIZE_DEPTH + 8)),
    );
  });

  it("fail-closed after JSON.parse accepts a 20k-deep import nest", () => {
    const raw = `${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}`;
    const parsed = JSON.parse(raw) as unknown;
    expect(typeof parsed).toBe("object");
    expectUnbounded(() => canonicalize(parsed));
  });

  it("does not invoke enumerable getters while canonicalizing", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      get() {
        throw new Error("GETTER_INVOKED");
      },
    });
    try {
      canonicalize({ id: "mem-1", content: hostile });
      throw new Error("expected AGENT_EXPORT_CANONICALIZE_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentExportError);
      expect((error as AgentExportError).code).toBe(
        AGENT_EXPORT_CANONICALIZE_UNBOUNDED,
      );
      expect(String(error)).not.toContain("GETTER_INVOKED");
    }
  });

  it("verifyExportManifest fail-closed on a cyclic memory collection", () => {
    const cyclic: Record<string, unknown> = { id: "mem-1", text: "hi" };
    cyclic.self = cyclic;
    expectUnbounded(() =>
      verifyExportManifest({
        ...emptyPayload({ memories: [cyclic] }),
        manifest: {
          algorithm: "sha256",
          components: {
            memories: { sha256: "abc", count: 1 },
          },
        },
      } as never),
    );
  });

  it("ordinary Proxy object/array keep honest canonical bytes", () => {
    expect(canonicalize(new Proxy({ b: 1, a: 2 }, {}))).toBe('{"a":2,"b":1}');
    expect(canonicalize(new Proxy([2, 1], {}))).toBe("[2,1]");
  });

  it("revoked object and array Proxies fail closed instead of TypeError", () => {
    const objectPair = Proxy.revocable({ a: 1 }, {});
    objectPair.revoke();
    expectUnbounded(() => canonicalize(objectPair.proxy));
    const arrayPair = Proxy.revocable([1, 2], {});
    arrayPair.revoke();
    expectUnbounded(() => canonicalize(arrayPair.proxy));
  });

  it("does not invoke own or inherited array accessors", () => {
    const ownHostile: unknown[] = [];
    Object.defineProperty(ownHostile, "0", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("ARRAY_OWN_ACCESSOR");
      },
    });
    try {
      canonicalize(ownHostile);
      throw new Error("expected AGENT_EXPORT_CANONICALIZE_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentExportError);
      expect((error as AgentExportError).code).toBe(
        AGENT_EXPORT_CANONICALIZE_UNBOUNDED,
      );
      expect(String(error)).not.toContain("ARRAY_OWN_ACCESSOR");
    }

    let inheritedInvoked = false;
    Object.defineProperty(Array.prototype, "1", {
      configurable: true,
      enumerable: false,
      get() {
        inheritedInvoked = true;
        return "PWN";
      },
    });
    try {
      const sparse = [0];
      sparse.length = 3;
      sparse[2] = 2;
      expect(canonicalize(sparse)).toBe("[0,,2]");
      expect(inheritedInvoked).toBe(false);
    } finally {
      Reflect.deleteProperty(Array.prototype, "1");
    }
  });

  it("fail-closed on a huge sparse length before allocating the join", () => {
    const sparse: unknown[] = [];
    sparse.length = MAX_AGENT_EXPORT_CANONICALIZE_NODES + 1;
    expectUnbounded(() => canonicalize(sparse));
  });

  it("captures one object descriptor snapshot so Proxy drift cannot change the walk", () => {
    let reads = 0;
    const drifted = new Proxy(
      { a: 1 },
      {
        ownKeys() {
          return ["a"];
        },
        getOwnPropertyDescriptor() {
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
    expect(canonicalize(drifted)).toBe('{"a":1}');
    expect(reads).toBe(1);
  });

  it("preserves sparse-hole canonical string and undefined-as-null array slots", () => {
    const sparse = [1];
    sparse[2] = 3;
    expect(canonicalize(sparse)).toBe("[1,,3]");
    expect(canonicalize([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("verifyExportManifest keeps honest output and fail-closed revoked/sparse/drift", () => {
    const memories = [{ id: "mem-1", text: "hi", skip: undefined }];
    const honest = emptyPayload({ memories });
    const result = verifyExportManifest({
      ...honest,
      manifest: manifestFor(honest),
    } as never);
    expect(result.present).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);

    const revoked = Proxy.revocable([{ id: "mem-1" }], {});
    revoked.revoke();
    expectUnbounded(() =>
      verifyExportManifest({
        ...emptyPayload({ memories: revoked.proxy }),
        manifest: {
          algorithm: "sha256",
          components: { memories: { sha256: "abc", count: 1 } },
        },
      } as never),
    );

    const huge: unknown[] = [];
    huge.length = MAX_AGENT_EXPORT_CANONICALIZE_NODES + 1;
    expectUnbounded(() =>
      verifyExportManifest({
        ...emptyPayload({ memories: huge }),
        manifest: {
          algorithm: "sha256",
          components: { memories: { sha256: "abc", count: 1 } },
        },
      } as never),
    );

    let reads = 0;
    const drifted = new Proxy(
      [{ id: "mem-1" }],
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "length") {
            return {
              configurable: false,
              enumerable: false,
              writable: true,
              value: 1,
            };
          }
          reads += 1;
          if (reads === 1) {
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: { id: "mem-1" },
            };
          }
          throw new Error("DESCRIPTOR_DRIFT");
        },
      },
    );
    const driftedPayload = emptyPayload({ memories: drifted });
    const driftedResult = verifyExportManifest({
      ...driftedPayload,
      manifest: {
        algorithm: "sha256",
        components: {
          ...manifestFor(emptyPayload({ memories: [{ id: "mem-1" }] }))
            .components,
        },
      },
    } as never);
    expect(driftedResult.ok).toBe(true);
  });
});
