/** File-grep proof for og clampText suffix reserve fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = "packages/cloud/api/og/route.tsx";
const SIBLING = "packages/agent/src/api/health-routes.ts";

describe("og clampText suffix reserve", () => {
  it("reserves suffix length with maxLength - 3 for ...", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain("slice(0, maxLength - 3)}...");
    expect(s).not.toContain("slice(0, maxLength - 1)}...");
  });
  it("has single site", () => {
    const s = readFileSync(SRC, "utf8");
    const count = (s.match(/slice\(0, maxLength - 3\)/g) || []).length;
    expect(count).toBe(1);
  });
  it("payload: weak overflows by 2, fixed bounded", () => {
    const maxLength = 90;
    const weak = "a".repeat(91).slice(0, maxLength - 1) + "...";
    const fixed = "a".repeat(91).slice(0, maxLength - 3) + "...";
    expect(weak.length).toBe(92); // 89+3=92 overflow 2
    expect(fixed.length).toBe(90);
  });
  it("sibling still correct with maxStringLength - 3", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("maxStringLength - 3");
  });
});
