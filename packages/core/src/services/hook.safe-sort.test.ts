/**
 * Regression for hook priority sort handling of NaN/Infinity.
 * Previously raw subtraction on priority/registeredAt would return NaN and corrupt ordering.
 */
import { describe, expect, it } from "vitest";

type HookReg = { id: string; metadata: { priority: number }; registeredAt: number };

function compareHookRegs(a: HookReg, b: HookReg): number {
  const bP =
    typeof b.metadata.priority === "number" && Number.isFinite(b.metadata.priority)
      ? b.metadata.priority
      : 0;
  const aP =
    typeof a.metadata.priority === "number" && Number.isFinite(a.metadata.priority)
      ? a.metadata.priority
      : 0;
  if (bP !== aP) return bP - aP;
  const bT =
    typeof b.registeredAt === "number" && Number.isFinite(b.registeredAt)
      ? b.registeredAt
      : 0;
  const aT =
    typeof a.registeredAt === "number" && Number.isFinite(a.registeredAt) ? a.registeredAt : 0;
  if (bT !== aT) return aT - bT;
  return String(a.id).localeCompare(String(b.id));
}

describe("hook priority safe-sort", () => {
  it("treats NaN priority as 0", () => {
    const regs: HookReg[] = [
      { id: "b", metadata: { priority: Number.NaN }, registeredAt: 1 },
      { id: "a", metadata: { priority: 10 }, registeredAt: 1 },
      { id: "c", metadata: { priority: Number.POSITIVE_INFINITY }, registeredAt: 1 },
    ];
    expect([...regs].sort(compareHookRegs).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties by registeredAt ascending then id", () => {
    const regs: HookReg[] = [
      { id: "b", metadata: { priority: 5 }, registeredAt: 20 },
      { id: "a", metadata: { priority: 5 }, registeredAt: 10 },
      { id: "c", metadata: { priority: 5 }, registeredAt: Number.NaN },
    ];
    expect([...regs].sort(compareHookRegs).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("old comparator would return NaN", () => {
    const a = { metadata: { priority: Number.NaN }, registeredAt: 1 } as HookReg;
    const b = { metadata: { priority: 5 }, registeredAt: 1 } as HookReg;
    expect(Number.isNaN(b.metadata.priority - a.metadata.priority)).toBe(true);
  });
});
