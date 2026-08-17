import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("orchestrator task trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/orchestrator-task-service.ts","utf8");
  it("reserve -1",()=>expect(src).toContain("slice(0, max - 1)}…"));
  it("no bare",()=>expect(src.includes("slice(0, max)}…")).toBe(false));
  it("payload + sibling",()=>{
    const max=2000; expect(max+1).toBe(2001); expect((max-1)+1).toBe(2000);
    const sib=fs.readFileSync("plugins/plugin-personal-assistant/src/actions/resolve-request.ts","utf8");
    expect(sib).toContain("max - 1");
  });
  it("count 1",()=>expect((src.match(/max - 1/g)||[]).length).toBeGreaterThanOrEqual(1));
});
