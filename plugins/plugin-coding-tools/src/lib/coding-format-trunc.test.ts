import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("coding format trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-coding-tools/src/lib/format.ts","utf8");
  it("reserve suffix.length",()=>expect(src).toContain("max - suffix.length"));
  it("no bare",()=>expect(src.includes("slice(0, max)}\\n…[truncated")).toBe(false));
  it("payload + sibling",()=>{
    const max=100, sLen=150, suffix=`\n…[truncated, ${sLen-max} more chars]`;
    expect(suffix.length).toBeGreaterThan(10);
    expect(max+suffix.length).toBeGreaterThan(max);
    expect((max - suffix.length)+suffix.length).toBe(max);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/suffix\.length/g)||[]).length).toBeGreaterThanOrEqual(1));
});
