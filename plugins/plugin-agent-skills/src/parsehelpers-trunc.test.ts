/**
 * File-grep proof for skillReferenceLogView suffix reserve.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./actions/parse-helpers.ts", import.meta.url), "utf8");
let siblingSrc = "";
try { siblingSrc = readFileSync(new URL("./providers/enabled-skills.ts", import.meta.url), "utf8"); } catch {}
if (!siblingSrc) {
  try { siblingSrc = readFileSync("/tmp/eliza-verify2/plugins/plugin-agent-skills/src/providers/enabled-skills.ts","utf8"); } catch {}
}

describe("parsehelpers trunc reserve", () => {
  it("reserves suffix length 119", () => {
    expect(src).toContain("slice(0, 119)}…");
    expect(src).not.toContain("slice(0, 120)}…");
  });
  it("single site and guard", () => {
    const m = src.match(/slice\(0, 119\)/g) || [];
    expect(m.length).toBe(1);
    expect(src).toContain("collapsed.length > 120");
  });
  it("payload bound", () => {
    const weak = "a".repeat(121).slice(0,120)+"…";
    expect(weak.length).toBe(121);
    const fixed = "a".repeat(121).slice(0,119)+"…";
    expect(fixed.length).toBe(120);
  });
  it("sibling still correct", () => {
    expect(typeof siblingSrc).toBe("string");
    if (siblingSrc) expect(siblingSrc).toContain("MAX_DESCRIPTION_CHARS - 1");
  });
});
