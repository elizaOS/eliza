import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("resume trunc",()=>{
  it("reserve -1 for …",()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/resume-context.ts","utf8");
    expect(src).toContain("slice(0, MAX_RESUME_PROGRESS_CHARS - 1)}…");
  });
  it("no bare remains",()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/resume-context.ts","utf8");
    expect(src).not.toContain("slice(0, MAX_RESUME_PROGRESS_CHARS)}…");
  });
  it("count 1",()=>{
    const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/resume-context.ts","utf8");
    expect((src.match(/MAX_RESUME_PROGRESS_CHARS - 1/g)||[]).length).toBe(1);
  });
  it("payload weak 101 vs fixed 100 sibling correct",()=>{
    const MAX=100;
    expect(("a".repeat(101).slice(0,MAX)+"…").length).toBe(101);
    expect(("a".repeat(101).slice(0,MAX-1)+"…").length).toBe(100);
    const sib=fs.readFileSync("packages/cloud/shared/src/lib/web-push/notify-service.ts","utf8");
    expect(sib).toContain("slice(0, MAX_BODY_LENGTH - 1)");
  });
});
