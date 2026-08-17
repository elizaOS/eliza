import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("quick-app trunc reserve",()=>{
  it("reserve 14 for \\n… [truncated]",()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/quick-app-evidence.ts","utf8");
    expect(src).toContain("slice(0, MAX_CONTENT_CHARS - 14)}");
  });
  it("no bare remains",()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/quick-app-evidence.ts","utf8");
    expect(src).not.toContain("slice(0, MAX_CONTENT_CHARS)}\n… [truncated]");
  });
  it("count 1",()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/quick-app-evidence.ts","utf8");
    expect((src.match(/MAX_CONTENT_CHARS - 14/g)||[]).length).toBe(1);
  });
  it("payload weak 114 vs fixed 100 sibling correct",()=>{
    const MAX=100, suffix="\n… [truncated]";
    expect(suffix.length).toBe(14);
    expect(("a".repeat(101).slice(0,MAX)+suffix).length).toBe(114);
    expect(("a".repeat(101).slice(0,MAX-14)+suffix).length).toBe(100);
    const sibling=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sibling).toContain("slice(0, max - suffix.length)");
  });
});
