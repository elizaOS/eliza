import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("completion-evidence trunc reserve",()=>{
  it("reserve clamp -14 for s1",()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/completion-evidence.ts","utf8");
    expect(src).toContain("slice(0, max - 14)}");
  });
  it("reserve evidence -23 for s2",()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/completion-evidence.ts","utf8");
    const m=(src.match(/MAX_EVIDENCE_CHARS - 23/g)||[]).length;
    expect(m).toBe(2);
  });
  it("no bare remains",()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/completion-evidence.ts","utf8");
    expect(src).not.toContain("slice(0, max)}\n… [truncated]");
    expect(src).not.toContain("slice(0, MAX_EVIDENCE_CHARS)}\n… [evidence truncated]");
  });
  it("payload weak vs fixed + sibling correct",()=>{
    const s1="\n… [truncated]"; expect(s1.length).toBe(14);
    const s2="\n… [evidence truncated]"; expect(s2.length).toBe(23);
    const MAX=100;
    expect(("a".repeat(101).slice(0,MAX)+s1).length).toBe(114);
    expect(("a".repeat(101).slice(0,MAX-14)+s1).length).toBe(100);
    expect(("a".repeat(101).slice(0,MAX)+s2).length).toBe(123);
    expect(("a".repeat(101).slice(0,MAX-23)+s2).length).toBe(100);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("slice(0, max - suffix.length)");
  });
});
