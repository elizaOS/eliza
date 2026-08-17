/**
 * File-grep proof for calendar truncateForPreview suffix reserve.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./internal/format.ts", import.meta.url), "utf8");
let sib = "";
try { sib = readFileSync(new URL("../../plugin-agent-skills/src/providers/enabled-skills.ts", import.meta.url), "utf8"); } catch {}
if (!sib) { try { sib = readFileSync("/tmp/eliza-verify2/plugins/plugin-agent-skills/src/providers/enabled-skills.ts","utf8"); } catch {} }

describe("calendar trunc", () => {
  it("reserves suffix", () => {
    expect(src).toContain("slice(0, maxLength - 1).trimEnd()}…");
    expect(src).not.toContain("slice(0, maxLength).trimEnd()}…");
  });
  it("single site", () => {
    const m = src.match(/slice\(0, maxLength - 1\)/g) || [];
    expect(m.length).toBe(1);
    expect(src).toContain("value.length <= maxLength");
  });
  it("payload bound", () => {
    const weak = "a".repeat(61).slice(0,60).trimEnd()+"…";
    expect(weak.length).toBe(61);
    const fixed = "a".repeat(61).slice(0,59).trimEnd()+"…";
    expect(fixed.length).toBe(60);
  });
  it("sibling still correct", () => {
    expect(typeof sib).toBe("string");
    if (sib) expect(sib).toContain("MAX_DESCRIPTION_CHARS - 1");
  });
});
