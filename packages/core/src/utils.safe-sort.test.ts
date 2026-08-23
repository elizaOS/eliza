/**
 * Regression coverage for `formatPosts` ordering helpers in `utils.ts`.
 *
 * Both the per-room chronological tail and the room-rank by newest message
 * previously used raw subtraction on `createdAt`, which returns `NaN` for a
 * non-finite stamp and leaves the surrounding order in an engine-defined
 * state. Non-finite stamps therefore collapse to `0` (oldest) and ties break
 * on `id` / `roomId` for determinism.
 */
import { describe, expect, it } from "vitest";
import {
  __testCompareMemoryByCreatedAtAsc as cmpMem,
  __testCompareRoomByNewestDesc as cmpRoom,
} from "./utils.ts";

function mem(id: string, createdAt: number | undefined) {
  return { id, createdAt } as { id: string; createdAt?: number };
}

describe("utils safe createdAt comparators", () => {
  it("sorts memories oldest-first", () => {
    const rows = [mem("c", 30), mem("a", 10), mem("b", 20)];
    expect([...rows].sort(cmpMem).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("treats NaN/Infinity/undefined as 0 oldest", () => {
    const rows = [mem("c", 30), mem("b", Number.NaN), mem("a", 10), mem("d", Number.POSITIVE_INFINITY)];
    expect([...rows].sort(cmpMem).map((m) => m.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("breaks equal timestamps by id", () => {
    expect([...[mem("b", 10), mem("a", 10)].sort(cmpMem).map((m) => m.id)]).toEqual(["a", "b"]);
  });

  it("sorts rooms newest-first by last message", () => {
    const rooms: Array<[string, Array<{ createdAt?: number }>] > = [
      ["roomA", [{ createdAt: 10 }, { createdAt: 20 }]],
      ["roomB", [{ createdAt: 50 }]],
      ["roomC", [{ createdAt: Number.NaN }]],
    ];
    expect([...rooms].sort(cmpRoom).map(([id]) => id)).toEqual(["roomB", "roomA", "roomC"]);
  });

  it("breaks equal newest timestamps by roomId", () => {
    const rooms: Array<[string, Array<{ createdAt?: number }>] > = [
      ["roomB", [{ createdAt: 10 }]],
      ["roomA", [{ createdAt: 10 }]],
    ];
    expect([...rooms].sort(cmpRoom).map(([id]) => id)).toEqual(["roomA", "roomB"]);
  });
});
