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
    const raw = JSON.stringify({
      name: "Ada",
      messageExamples: [
        [{ name: "Ada", content: { text: "hi", extra: nestArr(20_000) } }],
      ],
    });
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
});
