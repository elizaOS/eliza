/**
 * Fail-closed character-history walk for Zod-accepted messageExamples.
 *
 * Origin develop JSON.parse + validateCharacter accepted content.passthrough
 * extra keys, including a 20k-deep nest (~40 KiB) and cyclic in-memory
 * graphs, then RangeError'd in toCharacterHistoryValue during
 * buildCharacterHistorySnapshot. Depth/node/cycle fail-closed replaces
 * that with a typed ElizaError CHARACTER_HISTORY_UNBOUNDED, and every array
 * reserves its whole logical length in the shared aggregate walk budget.
 */
import { ElizaError, isElizaError, MemoryType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildCharacterHistorySnapshot,
  CHARACTER_HISTORY_UNBOUNDED,
  MAX_CHARACTER_HISTORY_WALK_DEPTH,
  MAX_CHARACTER_HISTORY_WALK_NODES,
  parseCharacterHistoryEntry,
} from "./character-history.ts";

function nestArr(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

function sparse(length: number): unknown[] {
  const value: unknown[] = [];
  value.length = length;
  return value;
}

function expectUnbounded(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected CHARACTER_HISTORY_UNBOUNDED");
  } catch (error) {
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe(CHARACTER_HISTORY_UNBOUNDED);
    expect(error).not.toBeInstanceOf(RangeError);
  }
}

describe("character-history fail-closed walk", () => {
  it("still snapshots an honest character with message examples", () => {
    const snapshot = buildCharacterHistorySnapshot({
      name: "Ada",
      messageExamples: [[{ name: "Ada", content: { text: "hi" } }]],
    });
    expect(snapshot.name).toBe("Ada");
    expect(snapshot.messageExamples).toEqual([
      [{ name: "Ada", content: { text: "hi" } }],
    ]);
  });

  it("fail-closed on a cyclic messageExamples graph instead of RangeError", () => {
    const cyclic: Record<string, unknown> = { text: "hi" };
    cyclic.self = cyclic;
    expectUnbounded(() =>
      buildCharacterHistorySnapshot({
        name: "Ada",
        messageExamples: [[{ name: "Ada", content: cyclic }]],
      }),
    );
  });

  it("fail-closed on over-deep nests before the walk RangeErrors", () => {
    expectUnbounded(() =>
      buildCharacterHistorySnapshot({
        name: "Ada",
        messageExamples: nestArr(MAX_CHARACTER_HISTORY_WALK_DEPTH + 8),
      }),
    );
  });

  it("fail-closed after JSON.parse accepts a 20k-deep passthrough extra", () => {
    const extra = `${"[".repeat(20_000)}"leaf"${"]".repeat(20_000)}`;
    const raw = `{"name":"Ada","messageExamples":[[{"name":"Ada","content":{"text":"hi","extra":${extra}}}]]}`;
    const parsed = JSON.parse(raw) as {
      name: string;
      messageExamples: unknown;
    };
    expect(typeof parsed).toBe("object");
    expectUnbounded(() => buildCharacterHistorySnapshot(parsed));
  });

  it("does not invoke enumerable getters while snapshotting", () => {
    const hostile: Record<string, unknown> = { text: "hi" };
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      get() {
        throw new Error("GETTER_INVOKED");
      },
    });
    try {
      buildCharacterHistorySnapshot({
        name: "Ada",
        messageExamples: [[{ name: "Ada", content: hostile }]],
      });
      throw new Error("expected CHARACTER_HISTORY_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CHARACTER_HISTORY_UNBOUNDED);
      expect(String(error)).not.toContain("GETTER_INVOKED");
    }
  });

  it("raises a typed ElizaError carrying code, severity, context and cause", () => {
    const cyclic: Record<string, unknown> = { text: "hi" };
    cyclic.self = cyclic;
    try {
      buildCharacterHistorySnapshot({
        name: "Ada",
        messageExamples: [[{ name: "Ada", content: cyclic }]],
      });
      throw new Error("expected CHARACTER_HISTORY_UNBOUNDED");
    } catch (error) {
      expect(isElizaError(error)).toBe(true);
      const typed = error as ElizaError;
      expect(typed.code).toBe(CHARACTER_HISTORY_UNBOUNDED);
      expect(typed.severity).toBe("fatal");
      expect(typed.context).toMatchObject({ cycle: true });
    }

    const { proxy, revoke } = Proxy.revocable(["leaf"], {});
    revoke();
    try {
      buildCharacterHistorySnapshot({ name: "Ada", messageExamples: proxy });
      throw new Error("expected CHARACTER_HISTORY_UNBOUNDED");
    } catch (error) {
      expect(isElizaError(error)).toBe(true);
      const typed = error as ElizaError;
      expect(typed.code).toBe(CHARACTER_HISTORY_UNBOUNDED);
      expect(typed.context).toMatchObject({ inspection: "isArray" });
      expect(typed.cause).toBeInstanceOf(TypeError);
    }
  });

  it("reserves every logical array slot in the aggregate walk budget", () => {
    // character + outer array + 2 outer slots + 2 * childLength == budget.
    const childLength = Math.floor((MAX_CHARACTER_HISTORY_WALK_NODES - 4) / 2);
    expect(childLength).toBe(49_998);
    expect(1 + 1 + 2 + childLength * 2).toBe(MAX_CHARACTER_HISTORY_WALK_NODES);

    const snapshot = buildCharacterHistorySnapshot({
      name: "Ada",
      messageExamples: [sparse(childLength), sparse(childLength)],
    });
    const walked = snapshot.messageExamples as unknown[];
    expect(walked).toHaveLength(2);
    expect((walked[0] as unknown[]).length).toBe(childLength);

    // One extra slot per nested array crosses the aggregate boundary even
    // though the graph still holds only three array containers.
    expectUnbounded(() =>
      buildCharacterHistorySnapshot({
        name: "Ada",
        messageExamples: [sparse(childLength + 1), sparse(childLength + 1)],
      }),
    );
  });

  it("charges a single sparse array its exact logical length", () => {
    // character + array container leaves exactly budget - 2 logical slots.
    const exact = MAX_CHARACTER_HISTORY_WALK_NODES - 2;
    expect(
      (
        buildCharacterHistorySnapshot({ messageExamples: sparse(exact) })
          .messageExamples as unknown[]
      ).length,
    ).toBe(exact);
    expectUnbounded(() =>
      buildCharacterHistorySnapshot({ messageExamples: sparse(exact + 1) }),
    );
  });

  it("charges sparse slots across sibling character fields", () => {
    const half = Math.floor(MAX_CHARACTER_HISTORY_WALK_NODES / 2);
    expectUnbounded(() =>
      buildCharacterHistorySnapshot({
        bio: sparse(half) as string[],
        topics: sparse(half) as string[],
        postExamples: sparse(half) as string[],
      }),
    );
  });

  it("reads each enumerable own descriptor exactly once", () => {
    const target = { text: "first" };
    let descriptorReads = 0;
    const drifting = new Proxy(target, {
      getOwnPropertyDescriptor(inner, key) {
        if (key === "text") {
          descriptorReads += 1;
          return {
            value: descriptorReads === 1 ? "first" : "drifted",
            enumerable: true,
            configurable: true,
            writable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(inner, key);
      },
    });

    const snapshot = buildCharacterHistorySnapshot({
      name: "Ada",
      messageExamples: [{ examples: [{ name: "Ada", content: drifting }] }],
    });
    const walked = snapshot.messageExamples as Array<{
      examples: Array<{ content: Record<string, unknown> }>;
    }>;
    expect(descriptorReads).toBe(1);
    expect(walked[0].examples[0].content.text).toBe("first");
  });

  it("fail-closed when a drifting descriptor turns into an accessor", () => {
    let descriptorReads = 0;
    const drifting = new Proxy(
      { text: "first" },
      {
        getOwnPropertyDescriptor(inner, key) {
          if (key === "text") {
            descriptorReads += 1;
            if (descriptorReads > 1) {
              return {
                get() {
                  throw new Error("ACCESSOR_INVOKED");
                },
                enumerable: true,
                configurable: true,
              };
            }
          }
          return Reflect.getOwnPropertyDescriptor(inner, key);
        },
      },
    );
    const snapshot = buildCharacterHistorySnapshot({
      messageExamples: [{ examples: [{ name: "Ada", content: drifting }] }],
    });
    expect(descriptorReads).toBe(1);
    expect(String(JSON.stringify(snapshot))).toContain("first");
  });

  it("parseCharacterHistoryEntry skips a cyclic stored change instead of throwing", () => {
    const cyclic: Record<string, unknown> = { text: "hi" };
    cyclic.self = cyclic;
    const parsed = parseCharacterHistoryEntry({
      content: { text: "change" },
      metadata: {
        type: MemoryType.CUSTOM,
        service: "character_history",
        action: "character_updated",
        timestamp: 1,
        historySource: "manual",
        fieldsChanged: ["messageExamples"],
        changes: [
          { field: "messageExamples", before: cyclic, after: { name: "b" } },
        ],
        before: { name: "a" },
        after: { name: "b" },
      },
    } as never);
    expect(parsed).toBeNull();
  });

  it("skips a poisoned stored snapshot instead of fabricating an empty one", () => {
    const cyclic: Record<string, unknown> = { name: "Ada" };
    cyclic.self = cyclic;
    const parsed = parseCharacterHistoryEntry({
      content: { text: "change" },
      metadata: {
        type: MemoryType.CUSTOM,
        service: "character_history",
        action: "character_updated",
        timestamp: 1,
        historySource: "manual",
        changes: [{ field: "name", before: "a", after: "b" }],
        before: cyclic,
        after: { name: "b" },
      },
    } as never);
    expect(parsed).toBeNull();
  });

  it.each([
    ["over-depth", nestArr(MAX_CHARACTER_HISTORY_WALK_DEPTH + 1)],
    [
      "over-node",
      (() => {
        const sparse: unknown[] = [];
        sparse.length = MAX_CHARACTER_HISTORY_WALK_NODES + 1;
        return sparse;
      })(),
    ],
  ])("skips a %s stored snapshot before emission", (_label, poisoned) => {
    const parsed = parseCharacterHistoryEntry({
      content: { text: "change" },
      metadata: {
        type: MemoryType.CUSTOM,
        service: "character_history",
        action: "character_updated",
        timestamp: 1,
        historySource: "manual",
        changes: [{ field: "name", before: "a", after: "b" }],
        before: poisoned,
        after: { name: "b" },
      },
    } as never);
    expect(parsed).toBeNull();
  });

  it("preserves an honest empty stored snapshot", () => {
    const parsed = parseCharacterHistoryEntry({
      content: { text: "change" },
      metadata: {
        type: MemoryType.CUSTOM,
        service: "character_history",
        action: "character_updated",
        timestamp: 1,
        historySource: "manual",
        changes: [{ field: "name", before: "a", after: "b" }],
        before: {},
        after: {},
      },
    } as never);
    expect(parsed).not.toBeNull();
    expect(parsed?.before).toEqual({});
    expect(parsed?.after).toEqual({});
  });

  it("skips a stored snapshot accessor without invoking it", () => {
    let calls = 0;
    const poisoned: Record<string, unknown> = {};
    Object.defineProperty(poisoned, "name", {
      enumerable: true,
      get() {
        calls += 1;
        return "poisoned";
      },
    });
    const parsed = parseCharacterHistoryEntry({
      content: { text: "change" },
      metadata: {
        type: MemoryType.CUSTOM,
        service: "character_history",
        action: "character_updated",
        timestamp: 1,
        historySource: "manual",
        changes: [{ field: "name", before: "a", after: "b" }],
        before: poisoned,
        after: { name: "b" },
      },
    } as never);
    expect(parsed).toBeNull();
    expect(calls).toBe(0);
  });

  it("wraps a revoked Array Proxy instead of leaking TypeError", () => {
    const { proxy, revoke } = Proxy.revocable(["leaf"], {});
    revoke();
    try {
      buildCharacterHistorySnapshot({
        name: "Ada",
        messageExamples: proxy,
      });
      throw new Error("expected CHARACTER_HISTORY_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CHARACTER_HISTORY_UNBOUNDED);
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });

  it("does not run ordinary array Proxy get/has traps", () => {
    const target = [[{ name: "Ada", content: { text: "hi" } }]];
    let getTrap = 0;
    const proxy = new Proxy(target, {
      get(nextTarget, key, receiver) {
        getTrap += 1;
        return Reflect.get(nextTarget, key, receiver);
      },
      has() {
        throw new Error("HAS_TRAP");
      },
    });
    const snapshot = buildCharacterHistorySnapshot({
      name: "Ada",
      messageExamples: proxy,
    });
    expect(getTrap).toBe(0);
    expect(snapshot.messageExamples).toEqual(target);
  });

  it("fail-closed on array index accessors without invoking them", () => {
    const hostile: unknown[] = ["placeholder"];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("ACCESSOR_INVOKED");
      },
    });
    try {
      buildCharacterHistorySnapshot({
        name: "Ada",
        messageExamples: hostile,
      });
      throw new Error("expected CHARACTER_HISTORY_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(CHARACTER_HISTORY_UNBOUNDED);
      expect(String(error)).not.toContain("ACCESSOR_INVOKED");
    }
  });

  it("preserves sparse holes and maps explicit undefined to null", () => {
    const sparse: unknown[] = ["a"];
    sparse[2] = "c";
    sparse[3] = undefined;
    const snapshot = buildCharacterHistorySnapshot({
      name: "Ada",
      messageExamples: sparse,
    });
    const walked = snapshot.messageExamples as unknown[];
    expect(Object.hasOwn(walked, "0")).toBe(true);
    expect(Object.hasOwn(walked, "1")).toBe(false);
    expect(walked[0]).toBe("a");
    expect(walked[2]).toBe("c");
    expect(walked[3]).toBeNull();
  });

  it("keeps top and nested enumerable __proto__ as inert own data", () => {
    const pollutedKey = "__proto_pollute_23130";
    const protoDesc = Object.getOwnPropertyDescriptor(
      Object.prototype,
      pollutedKey,
    );
    try {
      const top: Record<string, unknown> = { text: "top" };
      Object.defineProperty(top, "__proto__", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: { [pollutedKey]: "top" },
      });
      const nested: Record<string, unknown> = { text: "nested" };
      Object.defineProperty(nested, "__proto__", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: { [pollutedKey]: "nested" },
      });
      const snapshot = buildCharacterHistorySnapshot({
        name: "Ada",
        messageExamples: [
          [{ name: "Ada", content: { text: "top", child: nested } }],
        ],
      });
      // attach top-level __proto__ on the first example content via a dedicated object
      const topSnapshot = buildCharacterHistorySnapshot({
        name: "Ada",
        messageExamples: [[{ name: "Ada", content: top }]],
      });
      const walkedTop = (
        topSnapshot.messageExamples as Array<
          Array<{ content: Record<string, unknown> }>
        >
      )[0][0].content;
      const walkedNested = (
        snapshot.messageExamples as Array<
          Array<{ content: Record<string, unknown> }>
        >
      )[0][0].content.child as Record<string, unknown>;
      expect(Object.getPrototypeOf(walkedTop)).toBeNull();
      expect(Object.getPrototypeOf(walkedNested)).toBeNull();
      expect(Object.hasOwn(walkedTop, "__proto__")).toBe(true);
      expect(Object.hasOwn(walkedNested, "__proto__")).toBe(true);
      expect(walkedTop["__proto__"]).toEqual({ [pollutedKey]: "top" });
      expect(walkedNested["__proto__"]).toEqual({ [pollutedKey]: "nested" });
      expect(Object.hasOwn(Object.prototype, pollutedKey)).toBe(false);
    } finally {
      if (protoDesc) {
        Object.defineProperty(Object.prototype, pollutedKey, protoDesc);
      } else {
        Reflect.deleteProperty(Object.prototype, pollutedKey);
      }
    }
  });
});
