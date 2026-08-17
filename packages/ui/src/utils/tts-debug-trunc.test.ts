/** File-grep proof for ui tts trunc fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const SRC = "packages/ui/src/utils/tts-debug.ts";
const SIBLING = "packages/agent/src/actions/grounded-action-reply.ts";
describe("ui tts trunc", () => {
  it("reserves", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain("slice(0, maxChars - 1)}…");
    expect(s).not.toContain("slice(0, maxChars)}…");
  });
  it("single", () => {
    const s = readFileSync(SRC, "utf8");
    expect((s.match(/slice\(0, maxChars - 1\)/g)||[]).length).toBe(1);
  });
  it("payload", () => {
    const maxChars=80;
    const weak = "a".repeat(81).slice(0,maxChars)+"…";
    const fixed = "a".repeat(81).slice(0,maxChars-1)+"…";
    expect(weak.length).toBe(81);
    expect(fixed.length).toBe(80);
  });
  it("sibling correct", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("maxLength - 1");
  });
});
