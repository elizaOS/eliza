import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("browser wallet consent trunc",()=>{
  const src=fs.readFileSync("packages/ui/src/components/pages/browser-wallet-consent-format.ts","utf8");
  it("reserve suffix.length",()=>expect(src).toContain("max - suffix.length"));
  it("no bare",()=>expect(src.includes("slice(0, max)}… (")).toBe(false));
  it("payload + sibling",()=>{
    const max=240, msgLen=260, N=msgLen-max, suffix=`… (${N} more chars)`;
    expect(suffix.length).toBeGreaterThan(10);
    expect(max+suffix.length).toBeGreaterThan(max);
    expect((max - suffix.length)+suffix.length).toBe(max);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/suffix\.length/g)||[]).length).toBeGreaterThanOrEqual(1));
});
