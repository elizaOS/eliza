/**
 * Unit coverage for the conversation route comparators. Pure functions, real
 * implementations, no runtime or I/O: each case sorts through the exported
 * comparator that `conversation-routes.ts` passes to `Array.prototype.sort`.
 */
import { describe, expect, it } from "vitest";
import {
  compareConversationsByRecency,
  compareMemoriesByCreatedAt,
} from "./conversation-sort.ts";

describe("compareConversationsByRecency", () => {
  it("orders newest updatedAt first", () => {
    const convos = [
      { id: "c-old", updatedAt: "2026-08-20T10:00:00Z" },
      { id: "c-new", updatedAt: "2026-08-23T10:00:00Z" },
    ];
    convos.sort(compareConversationsByRecency);
    expect(convos.map((c) => c.id)).toEqual(["c-new", "c-old"]);
  });

  it("keeps a total order when an updatedAt is unparseable", () => {
    const convos = [
      { id: "c-nan", updatedAt: "invalid-date" },
      { id: "c-1", updatedAt: "2026-08-23T10:00:00Z" },
    ];
    convos.sort(compareConversationsByRecency);
    expect(convos.map((c) => c.id)).toEqual(["c-1", "c-nan"]);

    expect(
      compareConversationsByRecency(
        { id: "c-nan", updatedAt: "invalid-date" },
        { id: "c-1", updatedAt: "2026-08-23T10:00:00Z" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareConversationsByRecency(
        { id: "c-1", updatedAt: "2026-08-23T10:00:00Z" },
        { id: "c-nan", updatedAt: "invalid-date" },
      ),
    ).toBeLessThan(0);
  });

  it("tie-breaks two equally stale conversations on id", () => {
    expect(
      compareConversationsByRecency(
        { id: "b", updatedAt: "nope" },
        { id: "a", updatedAt: "also-nope" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareConversationsByRecency(
        { id: "a", updatedAt: "nope" },
        { id: "b", updatedAt: "also-nope" },
      ),
    ).toBeLessThan(0);
  });
});

describe("compareMemoriesByCreatedAt", () => {
  it("orders oldest createdAt first", () => {
    const memories = [
      { id: "m-2", createdAt: 2000 },
      { id: "m-1", createdAt: 1000 },
    ];
    memories.sort(compareMemoriesByCreatedAt);
    expect(memories.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });

  it("treats a NaN or missing createdAt as epoch 0 instead of returning NaN", () => {
    const memories = [
      { id: "m-nan", createdAt: Number.NaN },
      { id: "m-1", createdAt: 1000 },
      { id: "m-missing" },
    ];
    memories.sort(compareMemoriesByCreatedAt);
    expect(memories.map((m) => m.id)).toEqual(["m-missing", "m-nan", "m-1"]);

    expect(
      compareMemoriesByCreatedAt(
        { id: "m-nan", createdAt: Number.NaN },
        { id: "m-1", createdAt: 1000 },
      ),
    ).toBeLessThan(0);
    expect(
      compareMemoriesByCreatedAt(
        { id: "m-1", createdAt: 1000 },
        { id: "m-nan", createdAt: Number.NaN },
      ),
    ).toBeGreaterThan(0);
  });

  it("tie-breaks equal timestamps on id and tolerates a missing id", () => {
    expect(
      compareMemoriesByCreatedAt(
        { id: "b", createdAt: 5 },
        { id: "a", createdAt: 5 },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareMemoriesByCreatedAt({ createdAt: 5 }, { id: "a", createdAt: 5 }),
    ).toBeLessThan(0);
  });
});
