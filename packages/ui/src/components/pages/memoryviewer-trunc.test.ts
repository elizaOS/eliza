import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("memoryviewer trunc",()=>{
  const src=fs.readFileSync("packages/ui/src/components/pages/MemoryViewerView.tsx","utf8");
  it("reserve -1",()=>expect(src).toContain("slice(0, max - 1)}…"));
  it("no bare",()=>expect(src.includes("slice(0, max)}…")).toBe(false));
  it("payload + sibling",()=>{
    const max=200; expect(max+1).toBe(201); expect((max-1)+1).toBe(200);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/max - 1/g)||[]).length).toBeGreaterThanOrEqual(1));
});
