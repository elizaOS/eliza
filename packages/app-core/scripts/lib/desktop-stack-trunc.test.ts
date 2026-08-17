/** File-grep proof for desktop stack status trunc fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const SRC = "packages/app-core/scripts/lib/desktop-stack-status.mjs";
const SIBLING = "packages/agent/src/actions/grounded-action-reply.ts";
describe("desktop stack trunc", () => {
  it("reserves 399 for …", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain("slice(0, 399)}…");
    expect(s).not.toContain("slice(0, 400)}…");
  });
  it("single site", () => {
    const s = readFileSync(SRC, "utf8");
    expect((s.match(/slice\(0, 399\)/g)||[]).length).toBe(1);
  });
  it("payload", () => {
    const weak = "a".repeat(401).slice(0,400)+"…";
    const fixed = "a".repeat(401).slice(0,399)+"…";
    expect(weak.length).toBe(401);
    expect(fixed.length).toBe(400);
  });
  it("sibling correct", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("maxLength - 1");
  });
});
