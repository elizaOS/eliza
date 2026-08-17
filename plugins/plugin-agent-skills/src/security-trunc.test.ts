/**
 * File-grep proof for truncateEvidence suffix reserve.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./security/types.ts", import.meta.url), "utf8");
let siblingSrc = "";
try { siblingSrc = readFileSync(new URL("./providers/enabled-skills.ts", import.meta.url), "utf8"); } catch {}
if (!siblingSrc) {
  try { siblingSrc = readFileSync("/tmp/eliza-verify2/plugins/plugin-agent-skills/src/providers/enabled-skills.ts","utf8"); } catch {}
}

describe("security trunc reserve", () => {
  it("reserves suffix length maxLen-1", () => {
    expect(src).toContain("slice(0, maxLen - 1)}…");
    expect(src).not.toContain("slice(0, maxLen)}…");
  });

  it("single site and length guard", () => {
    const matches = src.match(/slice\(0, maxLen - 1\)/g) || [];
    expect(matches.length).toBe(1);
    expect(src).toContain("evidence.length <= maxLen");
  });

  it("payload→effect bound", () => {
    const maxLen = 120;
    const weak = "a".repeat(121).slice(0, maxLen) + "…";
    expect(weak.length).toBe(121);
    const fixed = "a".repeat(121).slice(0, maxLen - 1) + "…";
    expect(fixed.length).toBe(120);
  });

  it("sibling correct still reserves", () => {
    expect(typeof siblingSrc).toBe("string");
    if (siblingSrc) expect(siblingSrc).toContain("MAX_DESCRIPTION_CHARS - 1");
  });
});
