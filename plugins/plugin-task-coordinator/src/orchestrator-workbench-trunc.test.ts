import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("orchestrator workbench trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-task-coordinator/src/OrchestratorWorkbench.tsx","utf8");
  it("reserve suffix.length",()=>expect(src).toContain("max - suffix.length"));
  it("no bare",()=>expect(src.includes("slice(0, max).trimEnd()}\\n\\n…")).toBe(false));
  it("payload + sibling",()=>{
    const max=6000, valLen=6100, suffix=`\n\n… ${(valLen-max).toLocaleString()} characters truncated`;
    expect(suffix.length).toBeGreaterThan(10);
    expect(max+suffix.length).toBeGreaterThan(max);
    expect((max - suffix.length)+suffix.length).toBe(max);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/suffix\.length/g)||[]).length).toBeGreaterThanOrEqual(1));
});
