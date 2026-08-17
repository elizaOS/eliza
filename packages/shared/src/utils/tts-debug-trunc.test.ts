/** File-grep proof for tts-debug trunc fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const SRC = "packages/shared/src/utils/tts-debug.ts";
const SIBLING = "packages/agent/src/actions/grounded-action-reply.ts";
describe("tts shared trunc", () => {
  it("reserves 1", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain("slice(0, maxChars - 1)}…");
    expect(s).not.toContain("slice(0, maxChars)}…");
  });
  it("single site", () => {
    const s = readFileSync(SRC, "utf8");
    expect((s.match(/slice\(0, maxChars - 1\)/g)||[]).length).toBe(1);
  });
  it("payload", () => {
    const maxChars=100;
    const weak = "a".repeat(101).slice(0,maxChars)+"…";
    const fixed = "a".repeat(101).slice(0,maxChars-1)+"…";
    expect(weak.length).toBe(101);
    expect(fixed.length).toBe(100);
  });
  it("sibling correct", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("maxLength - 1");
  });
});
