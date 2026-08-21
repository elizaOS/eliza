/**
 * Fail-closed character-history walk for Zod-accepted messageExamples.
 *
 * Origin develop JSON.parse + validateCharacter accepted content.passthrough
 * extra keys, including a 20k-deep nest (~40 KiB) and cyclic in-memory
 * graphs, then RangeError'd in toCharacterHistoryValue during
 * buildCharacterHistorySnapshot. Depth/node/cycle fail-closed replaces
 * that with CharacterHistoryError CHARACTER_HISTORY_UNBOUNDED.
 */
import { MemoryType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  CHARACTER_HISTORY_UNBOUNDED,
  CharacterHistoryError,
  MAX_CHARACTER_HISTORY_WALK_DEPTH,
  buildCharacterHistorySnapshot,
  parseCharacterHistoryEntry,
} from "./character-history.ts";

function nestArr(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

function expectUnbounded(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected CHARACTER_HISTORY_UNBOUNDED");
  } catch (error) {
    expect(error).toBeInstanceOf(CharacterHistoryError);
    expect((error as CharacterHistoryError).code).toBe(
      CHARACTER_HISTORY_UNBOUNDED,
    );
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
      expect(error).toBeInstanceOf(CharacterHistoryError);
      expect((error as CharacterHistoryError).code).toBe(
        CHARACTER_HISTORY_UNBOUNDED,
      );
      expect(String(error)).not.toContain("GETTER_INVOKED");
    }
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
        changes: [{ field: "messageExamples", before: cyclic, after: { name: "b" } }],
        before: { name: "a" },
        after: { name: "b" },
      },
    } as never);
    expect(parsed).toBeNull();
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
      expect(error).toBeInstanceOf(CharacterHistoryError);
      expect((error as CharacterHistoryError).code).toBe(
        CHARACTER_HISTORY_UNBOUNDED,
      );
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
      expect(error).toBeInstanceOf(CharacterHistoryError);
      expect((error as CharacterHistoryError).code).toBe(
        CHARACTER_HISTORY_UNBOUNDED,
      );
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
        messageExamples: [[{ name: "Ada", content: { text: "top", child: nested } }]],
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
      expect(
        Object.prototype.hasOwnProperty.call(Object.prototype, pollutedKey),
      ).toBe(false);
    } finally {
      if (protoDesc) {
        Object.defineProperty(Object.prototype, pollutedKey, protoDesc);
      } else {
        Reflect.deleteProperty(Object.prototype, pollutedKey);
      }
    }
  });
});
