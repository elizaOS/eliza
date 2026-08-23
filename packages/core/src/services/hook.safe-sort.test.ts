/**
 * Regression for hook priority sort handling of NaN/Infinity — imports production comparator.
 */
import { describe, expect, it } from "vitest";
import { __testCompareHookRegistrations } from "./hook.ts";
import type { HookRegistration } from "../types/hook.ts";

function reg(id: string, priority: number, registeredAt: number): HookRegistration {
  return {
    id,
    metadata: {
      name: id,
      description: "",
      source: "runtime",
      events: [],
      priority,
      enabled: true,
    },
    handler: async () => {},
    registeredAt,
  } as HookRegistration;
}

describe("hook priority safe-sort", () => {
  it("treats NaN/Infinity priority as 0 (sorted after finite)", () => {
    const regs = [
      reg("b", Number.NaN, 1),
      reg("a", 10, 1),
      reg("c", Number.POSITIVE_INFINITY, 1),
    ];
    expect([...regs].sort(__testCompareHookRegistrations).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("sorts by priority desc, then registeredAt asc, then numeric id", () => {
    const regs = [
      reg("hook_10_test", 5, 10),
      reg("hook_9_test", 5, 10),
      reg("hook_2_test", 5, 10),
    ];
    expect([...regs].sort(__testCompareHookRegistrations).map((r) => r.id)).toEqual([
      "hook_2_test",
      "hook_9_test",
      "hook_10_test",
    ]);
  });
  it("handles NaN registeredAt as 0", () => {
    const regs = [reg("a", 5, Number.NaN), reg("b", 5, 10)];
    expect([...regs].sort(__testCompareHookRegistrations).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
