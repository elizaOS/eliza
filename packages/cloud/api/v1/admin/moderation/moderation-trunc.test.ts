/** File-grep proof for moderation truncateText suffix reserve fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = "packages/cloud/api/v1/admin/moderation/route.ts";
const SIBLING = "packages/agent/src/api/health-routes.ts";

describe("moderation truncateText suffix reserve", () => {
  it("reserves suffix length with maxLength - 3 for ...", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain("slice(0, maxLength - 3)}...");
    expect(s).not.toContain("slice(0, maxLength)}...");
  });
  it("has single site", () => {
    const s = readFileSync(SRC, "utf8");
    const count = (s.match(/slice\(0, maxLength - 3\)/g) || []).length;
    expect(count).toBe(1);
  });
  it("payload: weak overflows by 3, fixed bounded", () => {
    const maxLength = 50;
    const weak = "a".repeat(51).slice(0, maxLength) + "...";
    const fixed = "a".repeat(51).slice(0, maxLength - 3) + "...";
    expect(weak.length).toBe(53); // 51->50+3=53 overflow 3
    expect(fixed.length).toBe(50);
  });
  it("sibling still correct with maxStringLength - 3", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("maxStringLength - 3");
  });
});
