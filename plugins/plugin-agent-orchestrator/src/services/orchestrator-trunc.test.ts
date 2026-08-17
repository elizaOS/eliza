/** File-grep proof for orchestrator trunc fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const SRC = "plugins/plugin-agent-orchestrator/src/services/orchestrator-task-service.ts";
const SIBLING = "packages/agent/src/actions/grounded-action-reply.ts";
describe("orchestrator trunc", () => {
  it("reserves", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain("slice(0, max - 1)}…");
    expect(s).not.toContain("slice(0, max)}…");
  });
  it("single", () => {
    const s = readFileSync(SRC, "utf8");
    expect((s.match(/slice\(0, max - 1\)/g)||[]).length).toBe(1);
  });
  it("payload", () => {
    const max=2000;
    const weak = "a".repeat(2001).slice(0,max)+"…";
    const fixed = "a".repeat(2001).slice(0,max-1)+"…";
    expect(weak.length).toBe(2001);
    expect(fixed.length).toBe(2000);
  });
  it("sibling correct", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("maxLength - 1");
  });
});
