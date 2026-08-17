/** File-grep proof for electrobun agent shortError suffix reserve fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = "packages/app-core/platforms/electrobun/src/native/agent.ts";
const SIBLING = "packages/agent/src/actions/runtime.ts";

describe("electrobun shortError suffix reserve", () => {
  it("reserves suffix length with suffix.length", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain('const suffix = "... (see logs for full details)"');
    expect(s).toContain("maxLen - suffix.length");
    expect(s).not.toContain("slice(0, maxLen)}... (see logs");
  });
  it("has single site with suffix", () => {
    const s = readFileSync(SRC, "utf8");
    const count = (s.match(/suffix\.length/g) || []).length;
    expect(count).toBe(1);
  });
  it("payload: weak overflows by 31, fixed bounded", () => {
    const maxLen = 280;
    const suffix = "... (see logs for full details)";
    const weak = "a".repeat(281).slice(0, maxLen) + suffix;
    const fixed = "a".repeat(281).slice(0, maxLen - suffix.length) + suffix;
    expect(weak.length).toBe(311); // 280+31 overflow 31
    expect(fixed.length).toBe(280);
    expect(suffix.length).toBe(31);
  });
  it("sibling still correct with suffix.length", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("suffix.length");
    expect(sib).toContain("maxChars - suffix.length");
  });
});
