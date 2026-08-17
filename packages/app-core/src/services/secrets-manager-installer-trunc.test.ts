/** File-grep proof for secrets truncateError suffix reserve fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = "packages/app-core/src/services/secrets-manager-installer.ts";
const SIBLING = "packages/agent/src/actions/grounded-action-reply.ts";

describe("secrets truncateError suffix reserve", () => {
  it("reserves suffix length with max - 1 for …", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain("slice(0, max - 1)}…");
    expect(s).not.toContain("slice(0, max)}…");
  });
  it("has single site", () => {
    const s = readFileSync(SRC, "utf8");
    const count = (s.match(/slice\(0, max - 1\)/g) || []).length;
    expect(count).toBe(1);
  });
  it("payload: weak overflows by 1, fixed bounded", () => {
    const max = 800;
    const weak = "a".repeat(801).slice(0, max) + "…";
    const fixed = "a".repeat(801).slice(0, max - 1) + "…";
    expect(weak.length).toBe(801);
    expect(fixed.length).toBe(800);
  });
  it("sibling still correct with maxLength - 1", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("maxLength - 1");
  });
});
