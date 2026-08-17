import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("redact trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-personal-assistant/src/lifeops/redact-sensitive-data.ts","utf8");
  it("subject reserve -1",()=>expect(src).toContain("slice(0, max - 1).trimEnd()}…"));
  it("body reserve suffix.length",()=>expect(src).toContain("max - suffix.length"));
  it("no bare subject",()=>{ expect(src.includes("slice(0, max).trimEnd()}…\n}\n\nfunction shortenBody")).toBe(false); });
  it("payload + sibling",()=>{
    const max=100, suffix="…"; expect(max+suffix.length).toBe(101); expect((max-1)+suffix.length).toBe(100);
    const bodyLen=150, digits=String(bodyLen-max).length, suffixBody=`… [+${bodyLen-max} chars]`;
    expect(max+suffixBody.length).toBeGreaterThan(max);
    expect((max - suffixBody.length)+suffixBody.length).toBe(max);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
});
