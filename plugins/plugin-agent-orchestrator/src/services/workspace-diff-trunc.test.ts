import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("workspace-diff trunc reserve", ()=>{
  it("reserve 19 for \\n… [diff truncated]", ()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/workspace-diff.ts","utf8");
    expect(src).toContain("slice(0, MAX_DIFF_CHARS - 19)}");
  });
  it("no bare slice(0, MAX_DIFF_CHARS) remains with suffix", ()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/workspace-diff.ts","utf8");
    // should not contain the old pattern without -19
    expect(src).not.toContain("slice(0, MAX_DIFF_CHARS)}\n… [diff truncated]");
  });
  it("count 2 reserved sites", ()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/workspace-diff.ts","utf8");
    const m=src.match(/MAX_DIFF_CHARS - 19/g)||[];
    expect(m.length).toBe(2);
  });
  it("payload weak 19 over vs fixed capped sibling correct", ()=>{
    const MAX=100;
    const suffix="\n… [diff truncated]";
    expect(suffix.length).toBe(19);
    const weak=("a".repeat(101).slice(0,MAX)+suffix).length;
    const fixed=("a".repeat(101).slice(0,MAX-19)+suffix).length;
    expect(weak).toBe(119);
    expect(fixed).toBe(100);
    const sibling=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sibling).toContain("slice(0, max - suffix.length)");
  });
});
